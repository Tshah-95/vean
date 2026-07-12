// The shared playlist-surgery primitives every op builds on. PURE: each function
// takes IR data and returns NEW IR data, never mutating its input. These are the
// vean equivalents of the helpers Shotcut's higher ops call into
// (`multitrackmodel.cpp`): get_clip_index_at, clip_start, splitClip,
// removeRegion, insert, consolidateBlanks, removeBlankPlaceholder,
// insertOrAdjustBlankAt. Here they operate on a track's `Item[]` (clips, blanks,
// dissolve markers) instead of a live `Mlt::Playlist`.
//
// An op = locate (findClip/findTrack) → one or two surgery calls → assemble
// { state, consequences, inverse }. The two reference ops (append, split) and
// every stub import from here, so the surgery is written + tested ONCE.
import { FADE_IN_SERVICE, FADE_OUT_SERVICE, uuid } from "../ir/builder";
import type { Blank, Clip, Filter, Item, Timeline, Track } from "../ir/types";
import type { TrackAddr, Uuid } from "./types";

// ─── Deep clone (purity boundary) ────────────────────────────────────────────
/** A structural deep clone of the timeline. Ops clone the input at the boundary
 *  so every downstream mutation is on a private copy — the input `state` is
 *  guaranteed untouched (contract law #1). `structuredClone` is built into Bun
 *  and copies the plain-data IR faithfully. */
export function cloneTimeline(tl: Timeline): Timeline {
  return structuredClone(tl);
}

// ─── Frame math ──────────────────────────────────────────────────────────────
/** Played length of a clip in frames: `out - in + 1` (inclusive window). */
export function playtime(c: Clip): number {
  return c.out - c.in + 1;
}

/** Frames an item occupies, measured PER-ITEM in isolation (a clip's playtime, a
 *  blank's length, a dissolve's frame count). This is the item's own extent — NOT
 *  its net contribution to the TIMELINE length, which differs for a dissolve and
 *  its neighbours (a dissolve is a SHARED overlap; see `timelineContribution`).
 *  Used by the consequence-reporting loops that walk a captured `removed[]` run
 *  (clips + blanks only, never a standalone dissolve), where per-item extent is
 *  exactly what's wanted. */
export function itemLength(it: Item): number {
  if (it.kind === "clip") return playtime(it);
  if (it.kind === "blank") return it.length;
  return it.frames; // dissolve
}

/** An item's RENDERED span on the timeline — how many frames it occupies after
 *  the serializer resolves dissolve overlaps. A blank is its length; a dissolve is
 *  its `frames` (the single blended entry the serializer emits); a CLIP is its
 *  playtime MINUS the frames any adjacent dissolve trims off its head/tail (those
 *  frames move into the neighbouring blended entry). This is the coordinate space
 *  the rendered `.mlt` uses, so every positional walker agrees with melt's output
 *  and `trackLength([A, dissolve(d), B]) === A + B - d` (the overlap counted once,
 *  not twice — fixing the frame-math overcount that mis-aligned positional ops on
 *  any track carrying a dissolve). `items`+`i` give the neighbour context a clip
 *  needs; a standalone item (no context) falls back to its solo `itemLength`. */
function renderedSpan(items: Item[], i: number): number {
  const it = items[i] as Item;
  if (it.kind === "blank") return it.length;
  if (it.kind === "dissolve") return it.frames;
  // A clip: subtract the frames any adjacent dissolve consumes from its solo span.
  const before = items[i - 1];
  const after = items[i + 1];
  const trimHead = before?.kind === "dissolve" ? before.frames : 0;
  const trimTail = after?.kind === "dissolve" ? after.frames : 0;
  return Math.max(0, playtime(it) - trimHead - trimTail);
}

/** Total RENDERED frame length of a track's item run (dissolve overlaps counted
 *  once). Equals the length melt produces. */
export function trackLength(items: Item[]): number {
  let n = 0;
  for (let i = 0; i < items.length; i++) n += renderedSpan(items, i);
  return n;
}

/** Frames from the track start to the start of `items[index]`, in RENDERED
 *  timeline coordinates (dissolve overlaps shared). */
export function startOf(items: Item[], index: number): number {
  let n = 0;
  for (let i = 0; i < index && i < items.length; i++) n += renderedSpan(items, i);
  return n;
}

/** Index of the item covering timeline `position` (the `get_clip_index_at`):
 *  the item whose rendered `[start, start+span)` contains `position`. A position
 *  exactly on a boundary belongs to the item STARTING there. Returns the LAST
 *  non-dissolve item index when `position` is at/after the track end, or -1 for an
 *  empty track. A dissolve's blended entry CAN be the covering item (a position in
 *  the overlap resolves to the marker); the caller's `regionTouchesDissolve` guard
 *  then refuses to split it rather than `splitEntryAt` throwing on the marker. */
export function itemIndexAt(items: Item[], position: number): number {
  if (items.length === 0) return -1;
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const len = renderedSpan(items, i);
    if (position < acc + len) return i;
    acc += len;
  }
  // The last NON-dissolve item (a trailing dissolve can't be a covering item; the
  // IR forbids one, but stay defensive).
  for (let i = items.length - 1; i >= 0; i--) {
    if ((items[i] as Item).kind !== "dissolve") return i;
  }
  return items.length - 1;
}

// ─── Location ────────────────────────────────────────────────────────────────
/** Everything an op needs about a located clip: which track list it lives on,
 *  the indices, the clip itself, and its frame position on the track. */
export type ClipLocation = {
  trackKind: "video" | "audio";
  /** Index of the track within its kind's list (tracks.video[] / tracks.audio[]). */
  trackIndex: number;
  /** The track's stable id. */
  trackId: string;
  /** Index of the clip within the track's items[]. */
  itemIndex: number;
  clip: Clip;
  /** Frames from the track start to the clip's start. */
  position: number;
};

/** Find a clip by uuid across all tracks. Returns `undefined` if no clip carries
 *  that id (the caller turns that into a `clip-not-found` EditError). */
export function findClip(state: Timeline, id: Uuid): ClipLocation | undefined {
  const lists: Array<["video" | "audio", Track[]]> = [
    ["video", state.tracks.video],
    ["audio", state.tracks.audio],
  ];
  for (const [kind, tracks] of lists) {
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti] as Track;
      for (let ii = 0; ii < track.items.length; ii++) {
        const it = track.items[ii] as Item;
        if (it.kind === "clip" && it.id === id) {
          return {
            trackKind: kind,
            trackIndex: ti,
            trackId: track.id,
            itemIndex: ii,
            clip: it,
            position: startOf(track.items, ii),
          };
        }
      }
    }
  }
  return undefined;
}

/** Every clip in the timeline that shares `link.id` with the given clip, EXCLUDING
 *  the clip itself — its linked partners (the A/V pair, or a larger link group). An
 *  unlinked clip has no partners (empty array). Partners are located by uuid so a
 *  caller can shift/inspect each one; the order is video-tracks-then-audio-tracks,
 *  document order within a track (deterministic). Used by the link-aware ops (move
 *  shifts every partner; trim/split/ripple check whether an edit would desync one). */
export function findLinkedPartners(state: Timeline, clip: Clip): ClipLocation[] {
  const link = clip.link;
  if (link == null) return [];
  const out: ClipLocation[] = [];
  const lists: Array<["video" | "audio", Track[]]> = [
    ["video", state.tracks.video],
    ["audio", state.tracks.audio],
  ];
  for (const [kind, tracks] of lists) {
    for (let ti = 0; ti < tracks.length; ti++) {
      const track = tracks[ti] as Track;
      for (let ii = 0; ii < track.items.length; ii++) {
        const it = track.items[ii] as Item;
        if (it.kind !== "clip") continue;
        if (it.id === clip.id) continue; // the clip itself is not its own partner
        if (it.link?.id !== link.id) continue;
        out.push({
          trackKind: kind,
          trackIndex: ti,
          trackId: track.id,
          itemIndex: ii,
          clip: it,
          position: startOf(track.items, ii),
        });
      }
    }
  }
  return out;
}

/** The first audio track (by index) that is ENTIRELY BLANK across the rendered
 *  region `[position, position+length)` — a place the detached audio can land
 *  without stamping over existing content (Shotcut's "find a blank audio track for
 *  the span, else add one"). Returns the track's index within `tracks.audio[]`, or
 *  -1 if no existing audio track has a free span there. */
export function findAudioTrackWithBlank(state: Timeline, position: number, length: number): number {
  const audio = state.tracks.audio;
  for (let ti = 0; ti < audio.length; ti++) {
    if (regionIsBlank((audio[ti] as Track).items, position, length)) return ti;
  }
  return -1;
}

/** A `link-desync` warning iff the clip is linked to partners this edit does NOT
 *  touch — so the edit (a one-sided trim/split/ripple) would drift a detached A/V
 *  pair out of sync. Returns `[]` for an unlinked clip. This is the "record, don't
 *  silently corrupt" contract from DESIGN-UI.md §Appendix: the op still performs the
 *  edit (never mangles the partner), but flags the drift so the diagnostics layer +
 *  the surface can offer a "trim both" fix. The `verb` names the op for the message;
 *  `detail` describes the specific desync. Partner uuids ride in the warning detail
 *  so a consumer can locate them without re-deriving the group. */
export function linkDesyncWarning(
  state: Timeline,
  clip: Clip,
  verb: string,
  detail: string,
): Array<{ code: string; detail: string }> {
  const partners = findLinkedPartners(state, clip);
  if (partners.length === 0) return [];
  const ids = partners.map((p) => p.clip.id).join(", ");
  return [
    {
      code: "link-desync",
      detail: `${verb}: clip "${clip.id}" is linked to [${ids}] — ${detail}. The linked partner(s) were NOT adjusted, so the A/V pair may now be out of sync (trim/edit both, or unlink).`,
    },
  ];
}

/** Resolve a TrackAddr to its (kind, index, track). `undefined` if it doesn't
 *  resolve to a real track. */
export function findTrack(
  state: Timeline,
  addr: TrackAddr,
): { kind: "video" | "audio"; index: number; track: Track } | undefined {
  if ("trackId" in addr) {
    for (const kind of ["video", "audio"] as const) {
      const list = state.tracks[kind];
      const index = list.findIndex((t) => t.id === addr.trackId);
      if (index >= 0) return { kind, index, track: list[index] as Track };
    }
    return undefined;
  }
  const list = state.tracks[addr.kind];
  if (addr.index < 0 || addr.index >= list.length) return undefined;
  return { kind: addr.kind, index: addr.index, track: list[addr.index] as Track };
}

/** The mutable track-items array for a resolved track within a (cloned) state. */
export function trackItems(state: Timeline, kind: "video" | "audio", index: number): Item[] {
  return (state.tracks[kind][index] as Track).items;
}

// ─── Fade classification (decision #1 + gap-5 fix, DESIGN-MOVE1.md §4) ─────────
/** True iff a filter is a vean fade sentinel OR carries a Shotcut fade name —
 *  fade detection keys on the NAME, never on a bare 2-keyframe shape (resolves
 *  Move-0 keyframe gap #5: a user's genuine edge-anchored ramp is NOT a fade). */
export function isFadeIn(f: Filter): boolean {
  return f.service === FADE_IN_SERVICE || (f.shotcutName ?? "").startsWith("fadeIn");
}
export function isFadeOut(f: Filter): boolean {
  return f.service === FADE_OUT_SERVICE || (f.shotcutName ?? "").startsWith("fadeOut");
}

// ─── Escape-hatch keyframe-window re-base (DESIGN-MOVE1.md §4) ─────────────────
/** Re-base an escape-hatch animation string by `shift` frames: every keyframe
 *  `frame=value` becomes `(frame+shift)=value`, clamped to `[0, len-1]`, dropping
 *  keyframes that fall outside the new window. Fade SENTINELS never reach here
 *  (they carry `{frames}`, not a keyframe string — decision #1); only a literal
 *  animated property (`"0=…;N=…"`) is shifted. A non-animated value (no `=`) passes
 *  through untouched. This is the shared re-base both trim (head-trim moves the
 *  clip's local origin) and split (the TAIL half's origin moves by the head length)
 *  consume, mirroring `MLT.adjustClipFilters` shifting a filter's window by the
 *  edit delta. Lives here in `primitives` so split + trim share one implementation;
 *  `trim.ts` re-exports it for the test that imports it by its historical path. */
export function shiftAnimWindow(value: string, shift: number, len: number): string {
  if (!value.includes("=")) return value;
  const kept: string[] = [];
  for (const token of value.split(";")) {
    const eq = token.indexOf("=");
    if (eq < 0) {
      kept.push(token);
      continue;
    }
    const frameStr = token.slice(0, eq);
    const rest = token.slice(eq + 1);
    const frame = Number.parseInt(frameStr, 10);
    if (Number.isNaN(frame)) {
      // A non-numeric keyframe time (e.g. a timecode) — leave it verbatim rather
      // than risk corrupting it; the full timecode re-base is a separate concern.
      kept.push(token);
      continue;
    }
    const moved = frame + shift;
    if (moved < 0 || moved > len - 1) continue; // outside the new window — drop
    kept.push(`${moved}=${rest}`);
  }
  return kept.join(";");
}

/** Apply `shiftAnimWindow` across a clip's NON-fade filters in place (the clip is
 *  assumed already a private clone). Returns whether any window was shifted. Used
 *  by trim (origin move on head-trim) and split (tail-half origin move). */
export function shiftClipAnimWindows(clip: Clip, shift: number, len: number): boolean {
  if (shift === 0) return false;
  let touched = false;
  for (const f of clip.filters) {
    if (isFadeIn(f) || isFadeOut(f)) continue; // fades are sentinels, not strings
    for (const [k, v] of Object.entries(f.properties)) {
      if (typeof v === "string" && v.includes("=")) {
        const next = shiftAnimWindow(v, shift, len);
        if (next !== v) {
          f.properties[k] = next;
          touched = true;
        }
      }
    }
  }
  return touched;
}

// ─── Blanks ──────────────────────────────────────────────────────────────────
/** A blank of `length` frames (length must be > 0 to exist as an item). */
export function blankItem(length: number): Blank {
  return { kind: "blank", length };
}

/** Consolidate a track's blanks (the `consolidateBlanks` + `removeBlankPlaceholder`
 *  semantics, made pure):
 *   • merge any run of adjacent blanks into one,
 *   • drop a trailing blank (nothing plays after it),
 *   • the result of an emptied track is `[]` (vean models an empty track as no
 *     items; the Shotcut background/placeholder is regenerated on emit — vean
 *     does NOT keep a 0-length placeholder in the IR, unlike Shotcut's live
 *     playlist which needs one).
 *  Returns a NEW items array. */
export function consolidateBlanks(items: Item[]): Item[] {
  const out: Item[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.kind === "blank" && prev && prev.kind === "blank") {
      out[out.length - 1] = blankItem(prev.length + it.length);
    } else {
      out.push(it);
    }
  }
  // Drop a trailing blank (a gap with nothing after it is not load-bearing).
  while (out.length > 0 && (out[out.length - 1] as Item).kind === "blank") out.pop();
  return out;
}

/** Append a blank so the next append lands exactly at `position` (the "add blank
 *  to end if needed" branch of append/overwrite/insert). If `position` is at or
 *  before the current track end, returns the items unchanged. Returns the new
 *  items + the length of any blank added (0 if none). */
export function padToPosition(items: Item[], position: number): { items: Item[]; padded: number } {
  const end = trackLength(items);
  if (position <= end) return { items: [...items], padded: 0 };
  const pad = position - end;
  return { items: [...items, blankItem(pad)], padded: pad };
}

// ─── Dissolve-adjacency guards (fix: ops must not corrupt a dissolve overlap) ──
/** True iff the clip at `itemIndex` participates in a dissolve on EITHER side (a
 *  dissolve marker immediately precedes or follows it). Vacating such a clip
 *  (remove/lift/move-source) would leave a dangling dissolve marker the serializer
 *  rejects, so the op returns a typed precondition instead. */
export function clipTouchesDissolve(items: Item[], itemIndex: number): boolean {
  const before = items[itemIndex - 1];
  const after = items[itemIndex + 1];
  return before?.kind === "dissolve" || after?.kind === "dissolve";
}

/** Frames a dissolve consumes off the clip at `itemIndex` on the given side
 *  (`before` = its head edge, `after` = its tail edge), or 0 if no dissolve sits
 *  there. The serializer trims these frames into the nested lumaMix tractor, so a
 *  split/trim must leave that edge at least this long. */
export function dissolveConsumesAt(
  items: Item[],
  itemIndex: number,
  side: "before" | "after",
): number {
  const neighbour = side === "before" ? items[itemIndex - 1] : items[itemIndex + 1];
  return neighbour?.kind === "dissolve" ? neighbour.frames : 0;
}

/** True iff a positional edit over `[position, position+length)` (length 0 = a
 *  split AT `position`) would corrupt a dissolve on this track. Two unsafe cases:
 *   1. The edit's span overlaps a dissolve's BLENDED region (the marker's rendered
 *      frames) — it would shred the nested lumaMix tractor.
 *   2. The edit's boundary (`position`, or `position+length`) falls strictly
 *      INSIDE a clip that PARTICIPATES in a dissolve — splitting such a clip would
 *      shorten the neighbour the dissolve depends on (leaving the marker longer
 *      than its clip, an unserializable state) or wedge a clip between the dissolve
 *      and its neighbour.
 *  Edits on clip junctions, or wholly inside dissolve-free clips, are safe. Used by
 *  insert/overwrite/move (and ripple via the same seam) to return a typed
 *  precondition instead of splitting an unsplittable/dissolve-bound item. */
export function regionTouchesDissolve(items: Item[], position: number, length: number): boolean {
  const lo = position;
  const hi = position + Math.max(0, length); // half-open [lo, hi); split → [lo, lo]
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Item;
    const span = renderedSpan(items, i);
    const spanLo = acc;
    const spanHi = acc + span;
    acc = spanHi;
    if (it.kind === "dissolve") {
      // Case 1: the edit overlaps the blended region.
      if (length === 0 && lo > spanLo && lo < spanHi) return true;
      if (length > 0 && lo < spanHi && hi > spanLo) return true;
      continue;
    }
    if (
      it.kind === "clip" &&
      (items[i - 1]?.kind === "dissolve" || items[i + 1]?.kind === "dissolve")
    ) {
      // Case 2: a split/region boundary strictly inside a dissolve-bound clip.
      const boundaryInside = (b: number) => b > spanLo && b < spanHi;
      if (length === 0 && boundaryInside(lo)) return true;
      if (
        length > 0 &&
        (boundaryInside(lo) || boundaryInside(hi) || (lo <= spanLo && hi >= spanHi))
      ) {
        return true;
      }
    }
  }
  return false;
}

// ─── splitEntryAt — the splitClip semantics (the trickiest primitive) ─────────
/** Split the item at `itemIndex` at `localFrame` (frames from the ITEM's start).
 *  Mirrors `multitrackmodel.cpp::splitClip`:
 *   • A BLANK splits into two blanks of length `localFrame` and `len-localFrame`.
 *   • A CLIP splits into left `[in, in+localFrame-1]` and right
 *     `[in+localFrame, out]`. The LEFT keeps the original uuid? — NO: we keep the
 *     ORIGINAL uuid on the RIGHT (the tail), and mint a fresh uuid for the LEFT
 *     (head). Rationale in DESIGN-MOVE1.md §3: Shotcut resizes the original
 *     producer to the right window, so the surviving identity belongs to the
 *     tail; a later op still referencing the pre-split clip then lands on the
 *     tail (the safer default).
 *   • Fade deletion: drop `fadeOut` from the LEFT half, `fadeIn` from the RIGHT
 *     half ("remove fades usually not desired after split"). A head `fadeIn`
 *     survives on the left; a tail `fadeOut` survives on the right; a combined
 *     fade therefore lands as left-fadeIn + right-fadeOut.
 *   • Escape-hatch animated (non-fade) filters keep their windows; the per-frame
 *     re-base helper is `shiftAnimWindow` (Move 1b consumes it on trim — the
 *     reference ops' fixtures don't carry escape-hatch filters across a split).
 *  `0 < localFrame < itemLength` is REQUIRED (the caller guards; splitting at a
 *  boundary is a no-op the caller rejects). Returns the new items array plus the
 *  left/right uuids (blank split returns no uuids). */
export function splitEntryAt(
  items: Item[],
  itemIndex: number,
  localFrame: number,
): { items: Item[]; leftUuid?: Uuid; rightUuid?: Uuid } {
  const it = items[itemIndex];
  if (!it) throw new Error(`splitEntryAt: no item at index ${itemIndex}`);
  const out = [...items];

  if (it.kind === "blank") {
    const left = blankItem(localFrame);
    const right = blankItem(it.length - localFrame);
    out.splice(itemIndex, 1, left, right);
    return { items: out };
  }
  if (it.kind === "dissolve") {
    // A dissolve marker is not splittable content; the caller never targets one.
    throw new Error("splitEntryAt: cannot split a dissolve marker");
  }

  // A clip. Left/right source windows (inclusive).
  const headLen = localFrame; // head plays the clip's local frames [0, localFrame-1]
  const tailLen = playtime(it) - localFrame; // tail plays local [localFrame, len-1]
  // Deep-clone each half's filters so a downstream window re-base mutates only that
  // half — `Array.filter` keeps the SAME filter-object references, so without the
  // clone the two halves would share a filter and a re-base on one would corrupt
  // the other (the head would inherit the tail's shifted keyframes).
  const leftClip: Clip = {
    ...structuredClone(it),
    id: uuid(), // fresh identity for the head
    in: it.in,
    out: it.in + localFrame - 1,
    filters: it.filters.filter((f) => !isFadeOut(f)).map((f) => structuredClone(f)), // drop fadeOut from the head
  };
  const rightClip: Clip = {
    ...structuredClone(it),
    id: it.id, // the original identity survives on the tail
    in: it.in + localFrame,
    out: it.out,
    filters: it.filters.filter((f) => !isFadeIn(f)).map((f) => structuredClone(f)), // drop fadeIn from the tail
  };
  // Re-base escape-hatch animated filter windows (DESIGN-MOVE1.md §3 step 4 / §4):
  //   • HEAD: origin unchanged (it still plays the clip from local 0), so its
  //     keyframe strings are left VERBATIM. Keyframes past `headLen-1` are outside
  //     the head's shorter window, but melt simply doesn't reach them, and KEEPING
  //     them preserves the in-window interpolation gradient (a `0=0;50=0.5` ramp
  //     queried at frame 30 still tends toward the real 50-target) AND the round-
  //     trip fixpoint. Dropping them would flatten the head — wrong. (`headLen` is
  //     referenced for symmetry/legibility; the head needs no shift.)
  //   • TAIL: its origin moves forward by `localFrame` (it now plays from source
  //     `in+localFrame`), so every keyframe re-bases by `-localFrame`; any that fall
  //     before 0 are dropped. Without this the tail's keyframes mis-anchor when the
  //     serializer re-emits them on the tail's 0-based window.
  // Fade sentinels carry only `{frames}` (no keyframe string), so they're untouched
  // here — the serializer owns their keyframe math.
  void headLen; // the head is faithful verbatim; see above
  shiftClipAnimWindows(rightClip, -localFrame, tailLen);
  // `length` (source duration): for a FILE clip both halves window the same
  // producer, so `length` (the source's total duration) is unchanged. For a COLOR
  // clip there is no external source — `length` IS the clip's own played count, and
  // the serializer emits it literally on the dissolve-neighbour producer path (the
  // solo path regenerates it). So a split color clip whose half later neighbours a
  // dissolve would emit `length=<original>` but re-parse to `length=<window>`,
  // breaking the round-trip fixpoint. Track each color half's `length` to its own
  // window so every emission path is round-trip-faithful.
  //
  // AND re-base each color half's WINDOW to 0-based (`[0, playtime-1]`). A color
  // generator is content-identical at every frame and positionless, so its `in`/
  // `out` are arbitrary — the canonical (and serialized) form is 0-based. The
  // tail half otherwise inherits `in = it.in + localFrame` (e.g. 30) while its
  // re-based `length` is its played count (e.g. 30), so `out (59) ≥ length (30)`
  // and the diagnostics engine's in-out-beyond-source rule fires on a perfectly
  // valid edit — a cross-surface inconsistency between the split op and the
  // diagnostics engine. Re-basing to 0-based makes `out < length` hold by
  // construction (the rule's stated invariant for a generator) while staying
  // byte-identical on round-trip and pixel-identical on render (verified). A
  // color clip carries no source-windowed filters, so no keyframe re-base is
  // needed alongside this.
  if (it.service === "color") {
    // Capture each half's played length BEFORE re-basing (playtime reads in/out).
    const leftPlay = playtime(leftClip);
    const rightPlay = playtime(rightClip);
    leftClip.in = 0;
    leftClip.out = leftPlay - 1;
    leftClip.length = leftPlay;
    rightClip.in = 0;
    rightClip.out = rightPlay - 1;
    rightClip.length = rightPlay;
  }
  out.splice(itemIndex, 1, leftClip, rightClip);
  return { items: out, leftUuid: leftClip.id, rightUuid: rightClip.id };
}

// ─── removeRange — the removeRegion loop, made pure ───────────────────────────
/** Remove `length` frames of content starting at timeline `position` (the
 *  `removeRegion` semantics): split the straddled left edge, then drop whole
 *  covered items, splitting the straddled right edge as needed. Leaves a HOLE
 *  (no auto-blank) — the caller decides whether to fill it (overwrite) or close
 *  it (remove ripples by NOT calling this; lift fills with a blank). Returns the
 *  new items, the removed entries (in order, for the inverse), and the frame
 *  position the hole now starts at (== `position`, clamped to track end). */
export function removeRange(
  items: Item[],
  position: number,
  length: number,
): { items: Item[]; removed: Item[]; holeAt: number } {
  let work = [...items];
  const end = trackLength(work);
  let remaining = Math.min(length, Math.max(0, end - position));
  const removed: Item[] = [];
  if (remaining <= 0) return { items: work, removed, holeAt: position };

  // Split the straddled left edge so `position` lands on an item boundary.
  let idx = itemIndexAt(work, position);
  const startBoundary = startOf(work, idx);
  if (position > startBoundary) {
    const local = position - startBoundary;
    work = splitEntryAt(work, idx, local).items;
    idx += 1; // the right part of the split is the new region head
  }

  // Drop covered items, splitting the straddled right edge if an item overhangs.
  while (remaining > 0 && idx < work.length) {
    const len = itemLength(work[idx] as Item);
    if (len > remaining) {
      // The last item overhangs the region — split it and remove only the left.
      work = splitEntryAt(work, idx, remaining).items;
    }
    const cut = work[idx] as Item;
    removed.push(cut);
    work.splice(idx, 1);
    remaining -= itemLength(cut);
  }
  return { items: work, removed, holeAt: position };
}

// ─── Captured-span surgery (lossless overwrite/move inverse) ──────────────────
/** The contiguous run of items overlapping the rendered region `[position,
 *  position+length)`, captured WHOLE (no split) for an exact inverse, plus the
 *  index range it occupies and the rendered frame at which the first captured item
 *  STARTS. overwrite/move use this so undo can replace the post-edit span with the
 *  captured originals verbatim — re-merging what a naive split-edge `removeRange`
 *  would otherwise fragment into fresh-uuid head/tail clips (the straddle inverse
 *  bug). `lo`/`hi` are item indices (half-open); `items.slice(lo,hi)` are the
 *  originals; `spanStart` is the rendered start of `items[lo]`. */
export function spanCovering(
  items: Item[],
  position: number,
  length: number,
): { lo: number; hi: number; captured: Item[]; spanStart: number } {
  const end = trackLength(items);
  const regionLo = position;
  const regionHi = Math.min(position + length, end);
  let lo = items.length;
  let hi = 0;
  let acc = 0;
  let spanStart = position;
  for (let i = 0; i < items.length; i++) {
    const span = renderedSpan(items, i);
    const itemLo = acc;
    const itemHi = acc + span;
    acc = itemHi;
    // An item overlaps the region if its rendered span intersects [regionLo,
    // regionHi). A zero-length region (insert) overlaps the item STARTING at it.
    const overlaps =
      length === 0
        ? itemLo <= regionLo && regionLo < itemHi
        : itemLo < regionHi && itemHi > regionLo;
    if (overlaps) {
      if (i < lo) {
        lo = i;
        spanStart = itemLo;
      }
      if (i + 1 > hi) hi = i + 1;
    }
  }
  if (lo > hi) {
    // No overlap (region past the end) — empty span starting at `position`.
    return { lo: items.length, hi: items.length, captured: [], spanStart: position };
  }
  return { lo, hi, captured: items.slice(lo, hi).map((it) => structuredClone(it)), spanStart };
}

// ─── insertEntryAt — split-and-splice (insert/overwrite share this) ───────────
/** Insert `entry` at timeline `position`, splitting the covering item so the new
 *  entry lands on a boundary (the insert/overwrite "split starting item" branch).
 *  Pure; returns the new items + the index the entry landed at. Does NOT ripple
 *  other tracks (the op layer does that via `rippleOtherTracks`). When `position`
 *  is at/after the track end, pads with a blank and appends. */
export function insertEntryAt(
  items: Item[],
  position: number,
  entry: Item,
): { items: Item[]; index: number } {
  const end = trackLength(items);
  if (position >= end) {
    const { items: padded } = padToPosition(items, position);
    return { items: [...padded, entry], index: padded.length };
  }
  let work = [...items];
  let idx = itemIndexAt(work, position);
  const boundary = startOf(work, idx);
  if (position > boundary) {
    work = splitEntryAt(work, idx, position - boundary).items;
    idx += 1;
  }
  work.splice(idx, 0, entry);
  return { items: work, index: idx };
}

/** True iff the rendered region `[position, position+frames)` on `items` is
 *  ENTIRELY blank (or past the track end). A ripple-CLOSE may only pull such a
 *  track left — removing blank space is lossless and invertible; removing real
 *  content is not, and Shotcut's ripple-all-tracks does NOT shred clips on other
 *  tracks. */
export function regionIsBlank(items: Item[], position: number, frames: number): boolean {
  const end = trackLength(items);
  if (position >= end) return true; // nothing there — trailing emptiness
  let acc = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Item;
    const span = renderedSpan(items, i);
    const itemLo = acc;
    const itemHi = acc + span;
    acc = itemHi;
    // Does this item overlap the rendered region [position, position+frames)?
    if (itemHi <= position || itemLo >= position + frames) continue;
    // A clip or dissolve overlapping the region means it is NOT blank-only.
    if (it.kind !== "blank") return false;
  }
  return true;
}

// ─── Cross-track ripple (insertOrAdjustBlankAt / removeRegion-on-others) ──────
/** Ripple every OTHER track by inserting (dir=+1) or removing (dir=-1) `frames`
 *  of blank at timeline `position`. Mirrors Shotcut's rippleAllTracks fan-out:
 *  on insert it opens a gap on each other unlocked track (`insertOrAdjustBlankAt`);
 *  on remove it pulls content left, but ONLY where the seam region is blank
 *  (`removeRegion` on each other track removes blank space, never real clips —
 *  Shotcut's ripple-all-tracks leaves content-bearing tracks untouched). A track
 *  whose seam holds real content is left as-is and reported with `blocked:true` so
 *  the cross-track effect is VISIBLE in the consequence report (never a silent
 *  shred). Mutates the (already-cloned) `state` in place and returns per-track
 *  notes. `exceptKind`/`exceptIndex` skip the track the primary op ran on. */
export function rippleOtherTracks(
  state: Timeline,
  exceptKind: "video" | "audio",
  exceptIndex: number,
  position: number,
  frames: number,
  dir: 1 | -1,
  /** Track ids to SKIP on an OPEN ripple (dir=+1). Used by the inverse of a
   *  ripple-CLOSE so it re-opens gaps on exactly the tracks the close pulled left,
   *  leaving the content tracks the close skipped untouched — keeping undo exact. */
  skipOpen?: ReadonlySet<string>,
): RippleNote[] {
  const notes: RippleNote[] = [];
  for (const kind of ["video", "audio"] as const) {
    const list = state.tracks[kind];
    for (let ti = 0; ti < list.length; ti++) {
      if (kind === exceptKind && ti === exceptIndex) continue;
      const track = list[ti] as Track;
      if (dir === 1) {
        if (skipOpen?.has(track.id)) {
          notes.push({ track: track.id, shift: 0, from: position, blocked: true });
          continue;
        }
        // Opening a gap is always lossless (content shifts right, invertible).
        const { items } = insertEntryAt(track.items, position, blankItem(frames));
        track.items = consolidateBlanks(items);
        notes.push({ track: track.id, shift: frames, from: position });
      } else {
        // Closing a gap: only pull left if the seam region is blank. A track that
        // holds real content there is LEFT UNTOUCHED and flagged blocked — never
        // shredded — so the report shows exactly why the alignment didn't move.
        if (regionIsBlank(track.items, position, frames)) {
          const { items } = removeRange(track.items, position, frames);
          track.items = consolidateBlanks(items);
          notes.push({ track: track.id, shift: -frames, from: position });
        } else {
          notes.push({ track: track.id, shift: 0, from: position, blocked: true });
        }
      }
    }
  }
  return notes;
}

/** A ripple note (mirrors the RippleEffect consequence shape, kept local to
 *  avoid a circular import of the consequence type into primitives). `blocked`
 *  marks a ripple-CLOSE that did NOT move a track because its seam held real
 *  content (Shotcut leaves it untouched; the op surfaces this as a warning). */
export type RippleNote = { track: string; shift: number; from: number; blocked?: boolean };
