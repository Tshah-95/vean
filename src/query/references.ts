/**
 * findReferences — "find all references" over the timeline document. Given a
 * source path, a property name, or a clip, return everything that refers to it:
 *   • SOURCE  → every clip whose `resource` is that media path/color.
 *   • PROPERTY → every filter (and transition) that READS or WRITES that property,
 *     across all clips/transitions, with the owning clip/transition located.
 *   • CLIP    → the adjacency / ripple set: what MOVES if this clip moves (its
 *     track neighbours and — for a ripple edit — the cross-track content at/after
 *     its position). This is the "what does editing here disturb?" query the LSP
 *     surfaces before a move/ripple.
 *
 * Pure + document-keyed (no I/O). The mirror of `resolveValueAtFrame`: where
 * resolve answers "what is the value HERE?", references answers "where ELSE does
 * this thing appear / what depends on it?".
 */
import { isAnimated } from "../ir/keyframes";
import type { Clip, Item, Timeline, Track, Transition } from "../ir/types";
import { playtime, startOf, trackLength } from "../ops/primitives";

// ─── The reference query (a discriminated union of the three kinds) ────────────
export type ReferenceQuery =
  /** Every clip using this media path / color spec (the `resource`). */
  | { kind: "source"; resource: string }
  /** Every reader/writer of this filter/transition property (by name). */
  | { kind: "property"; property: string }
  /** The adjacency/ripple set for this clip (what moves if it moves). `ripple`
   *  selects the ripple-all-tracks reach (cross-track) vs the single-track reach. */
  | { kind: "clip"; clip: string; ripple?: boolean };

// ─── Located reference shapes ──────────────────────────────────────────────────
/** A clip located by stable identity + where it sits. */
export type ClipSite = {
  uuid: string;
  track: string;
  /** Frames from the track start to the clip's start. */
  position: number;
  playtime: number;
  resource: string;
};

/** A site that references a property: the owning scope + whether it's animated
 *  (a writer that animates the value over time) or static. */
export type PropertySite = {
  /** Where the property lives. */
  owner:
    | { kind: "clip-filter"; clip: string; track: string; service: string }
    | { kind: "transition"; index: number; service: string };
  /** The property's raw value (the animation string or static literal). */
  value: string | number;
  /** True if the value is an MLT animation string (contains `=`) — an animated
   *  writer; false is a static read/write. */
  animated: boolean;
};

/** One clip in a clip's ripple set, with HOW it is affected. */
export type RippleSite = {
  uuid: string;
  track: string;
  position: number;
  /** Why it's in the set: a same-track neighbour after the clip (shifts on a
   *  ripple delete/insert), or cross-track content at/after the position (shifts
   *  only under ripple-all-tracks). */
  relation: "same-track-after" | "same-track-before" | "cross-track-after";
};

export type ReferenceResult =
  | { kind: "source"; resource: string; clips: ClipSite[] }
  | { kind: "property"; property: string; sites: PropertySite[] }
  | {
      kind: "clip";
      clip: string;
      /** The clip itself (its site), or `undefined` when not found. */
      site?: ClipSite;
      /** Adjacency/ripple set: what moves if this clip moves. */
      affected: RippleSite[];
      notFound?: string;
    };

// ─── Walk helpers ──────────────────────────────────────────────────────────────
/** Every (track, clip, position) triple in the timeline, video then audio. */
function* allClipSites(state: Timeline): Generator<{ track: Track; clip: Clip; position: number }> {
  for (const track of [...state.tracks.video, ...state.tracks.audio]) {
    for (let i = 0; i < track.items.length; i++) {
      const it = track.items[i] as Item;
      if (it.kind === "clip") {
        yield { track, clip: it, position: startOf(track.items, i) };
      }
    }
  }
}

function clipSite(track: Track, clip: Clip, position: number): ClipSite {
  return {
    uuid: clip.id,
    track: track.id,
    position,
    playtime: playtime(clip),
    resource: clip.resource,
  };
}

// ─── findReferences ────────────────────────────────────────────────────────────
/** Find all references to `ref` in the timeline. Pure; computed from the graph. */
export function findReferences(state: Timeline, ref: ReferenceQuery): ReferenceResult {
  if (ref.kind === "source") return findBySource(state, ref.resource);
  if (ref.kind === "property") return findByProperty(state, ref.property);
  return findClipAdjacency(state, ref.clip, ref.ripple ?? false);
}

// ─── source → clips using it ───────────────────────────────────────────────────
function findBySource(state: Timeline, resource: string): ReferenceResult {
  const clips: ClipSite[] = [];
  for (const { track, clip, position } of allClipSites(state)) {
    if (clip.resource === resource) clips.push(clipSite(track, clip, position));
  }
  return { kind: "source", resource, clips };
}

// ─── property → readers/writers ────────────────────────────────────────────────
function findByProperty(state: Timeline, property: string): ReferenceResult {
  const sites: PropertySite[] = [];
  // Clip filters.
  for (const { track, clip } of allClipSites(state)) {
    for (const f of clip.filters) {
      if (property in f.properties) {
        const value = f.properties[property] as string | number;
        sites.push({
          owner: { kind: "clip-filter", clip: clip.id, track: track.id, service: f.service },
          value,
          animated: isAnimated(String(value)),
        });
      }
    }
  }
  // Field transitions.
  for (let i = 0; i < state.transitions.length; i++) {
    const tr = state.transitions[i] as Transition;
    if (property in tr.properties) {
      const value = tr.properties[property] as string | number;
      sites.push({
        owner: { kind: "transition", index: i, service: tr.service },
        value,
        animated: isAnimated(String(value)),
      });
    }
  }
  return { kind: "property", property, sites };
}

// ─── clip → adjacency / ripple set ─────────────────────────────────────────────
/** The set of clips that MOVE if the target clip moves. On a SAME-TRACK edit
 *  (ripple delete/insert/move), every later clip on the clip's own track shifts;
 *  the immediately-preceding clip is reported too (it bounds the gap that closes).
 *  Under RIPPLE-ALL-TRACKS, cross-track content at or after the clip's start
 *  position also shifts. This is precisely the reach a ripple consequence reports —
 *  surfacing it BEFORE the edit is the "what will this disturb?" query. */
function findClipAdjacency(state: Timeline, uuid: string, ripple: boolean): ReferenceResult {
  // Locate the clip + its track context.
  let found:
    | {
        track: Track;
        trackKind: "video" | "audio";
        trackIndex: number;
        itemIndex: number;
        clip: Clip;
        position: number;
      }
    | undefined;
  const lists: Array<["video" | "audio", Track[]]> = [
    ["video", state.tracks.video],
    ["audio", state.tracks.audio],
  ];
  for (const [trackKind, tracks] of lists) {
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti] as Track;
      for (let ii = 0; ii < track.items.length; ii++) {
        const it = track.items[ii] as Item;
        if (it.kind === "clip" && it.id === uuid) {
          found = {
            track,
            trackKind,
            trackIndex: ti,
            itemIndex: ii,
            clip: it,
            position: startOf(track.items, ii),
          };
        }
      }
    }
  }
  if (!found) {
    return { kind: "clip", clip: uuid, affected: [], notFound: `clip "${uuid}" not found` };
  }

  const affected: RippleSite[] = [];
  const { track, position } = found;

  // Same-track neighbours: the clip immediately before (bounds the closing gap —
  // the last clip-index before the target, even across blanks/dissolves) and EVERY
  // clip after it (they shift on a ripple delete/insert/move).
  for (let i = 0; i < track.items.length; i++) {
    const it = track.items[i] as Item;
    if (it.kind !== "clip" || it.id === uuid) continue;
    const pos = startOf(track.items, i);
    if (i < found.itemIndex) {
      if (isLastClipBefore(track.items, i, found.itemIndex)) {
        affected.push({
          uuid: it.id,
          track: track.id,
          position: pos,
          relation: "same-track-before",
        });
      }
    } else {
      affected.push({ uuid: it.id, track: track.id, position: pos, relation: "same-track-after" });
    }
  }

  // Cross-track reach (ripple-all-tracks): content at/after the clip's start on
  // OTHER tracks shifts too. Only included when `ripple` is requested — that's the
  // edit mode where the cross-track effect actually happens.
  if (ripple) {
    for (const [, tracks] of lists) {
      for (const other of tracks) {
        if (other.id === track.id) continue;
        for (let i = 0; i < other.items.length; i++) {
          const it = other.items[i] as Item;
          if (it.kind !== "clip") continue;
          const pos = startOf(other.items, i);
          // Anything starting at or after the ripple seam shifts.
          if (pos >= position && pos < trackLength(other.items)) {
            affected.push({
              uuid: it.id,
              track: other.id,
              position: pos,
              relation: "cross-track-after",
            });
          }
        }
      }
    }
  }

  return {
    kind: "clip",
    clip: uuid,
    site: clipSite(track, found.clip, position),
    affected,
  };
}

/** True iff `i` is the LAST clip-index strictly before `targetIndex` (so it's the
 *  immediate clip-neighbour even across intervening blanks/dissolves). */
function isLastClipBefore(items: Item[], i: number, targetIndex: number): boolean {
  for (let j = i + 1; j < targetIndex; j++) {
    if ((items[j] as Item).kind === "clip") return false;
  }
  return true;
}
