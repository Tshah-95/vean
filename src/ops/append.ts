// append — place a clip at the end of a track. The simplest reference op: it
// shows the full contract end-to-end (clone → mutate → consequences → inverse)
// with no ripple and no surgery beyond a push.
//
// Shotcut semantics (`multitrackmodel.cpp::appendClip`): remove the track's
// end-blank PLACEHOLDER, then `playlist.append(clip)` at the end. vean's IR does
// not carry a placeholder blank (an empty track is `[]`, and a trailing blank is
// dropped by `consolidateBlanks`), so append reduces to: append the clip to the
// track's items. If the track has a trailing gap the caller wants preserved,
// that gap is a real `<blank>` (load-bearing) and append lands AFTER it — exactly
// like Shotcut appends after content, not into the placeholder.
//
// Inverse: drop the appended clip from the end of the track. We ship this as a
// self-contained internal restore op (`_dropAppended`) registered alongside
// append, so append's inverse-invariant passes NOW without depending on the
// `remove` stub. (Per DESIGN-MOVE1.md the user-facing inverse is `remove`; the
// internal form is the same operation specialized to the just-appended tail.)
import { z } from "zod";
import type { Item, Timeline, Track } from "../ir/types";
import { cloneTimeline, findTrack, playtime, trackLength } from "./primitives";
import {
  type AppendArgs,
  type EditError,
  type Op,
  type OpResult,
  clipUuid,
  editError,
  noConsequences,
} from "./types";

export const append: Op<AppendArgs> = (state, args): OpResult | EditError => {
  const loc = findTrack(state, args.track);
  if (!loc) {
    const track =
      "trackId" in args.track ? args.track.trackId : `${args.track.kind}[${args.track.index}]`;
    return editError({ kind: "track-not-found", track });
  }

  const next = cloneTimeline(state);
  const items = (next.tracks[loc.kind][loc.index] as Track).items;
  const clip = structuredClone(args.clip);

  // Position the appended clip lands at = current RENDERED track length (dissolve
  // overlaps counted once, via the shared dissolve-aware `trackLength`).
  const pos = trackLength(items);
  items.push(clip);

  const c = noConsequences();
  c.clipsAdded.push({
    uuid: clipUuid(clip),
    track: loc.track.id,
    position: pos,
    playtime: playtime(clip),
  });
  c.durationDelta = playtime(clip);

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "_dropAppended",
      args: { track: { trackId: loc.track.id }, uuid: clipUuid(clip) },
    },
  };
};

// ─── The internal inverse op (drop the just-appended clip) ────────────────────
// Removes the clip `uuid` from the END of the named track, restoring the
// pre-append state exactly. Registered as `_dropAppended` so append's inverse is
// fully-specified and self-contained. Its OWN inverse is `append` of the dropped
// clip back onto that track — so undo-of-undo round-trips too.
export const dropAppendedArgs = z.object({
  track: z.object({ trackId: z.string().min(1) }),
  uuid: z.string().min(1),
});
export type DropAppendedArgs = z.infer<typeof dropAppendedArgs>;

export const dropAppended: Op<DropAppendedArgs> = (state, args): OpResult | EditError => {
  const loc = findTrack(state, args.track);
  if (!loc) return editError({ kind: "track-not-found", track: args.track.trackId });
  const items = loc.track.items;
  const lastIndex = items.length - 1;
  const last = items[lastIndex] as Item | undefined;
  if (!last || last.kind !== "clip" || last.id !== args.uuid) {
    return editError({
      kind: "precondition",
      detail: `_dropAppended: clip "${args.uuid}" is not the last item of track "${args.track.trackId}"`,
    });
  }

  const next = cloneTimeline(state);
  const nItems = (next.tracks[loc.kind][loc.index] as Track).items;
  const dropped = nItems.pop() as Extract<Item, { kind: "clip" }>;

  // Position the clip occupied (rendered track length without it).
  const pos = trackLength(nItems);

  const c = noConsequences();
  c.clipsRemoved.push({
    uuid: dropped.id,
    track: loc.track.id,
    position: pos,
    playtime: playtime(dropped),
  });
  c.durationDelta = -playtime(dropped);

  return {
    state: next,
    consequences: c,
    inverse: { op: "append", args: { track: { trackId: loc.track.id }, clip: dropped } },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { clip, colorClip, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<AppendArgs>[] = [
  {
    name: "append a color clip onto a single video track",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, { video: [videoTrack(colorClip(45, "black", { fadeIn: 12 }))] });
    },
    args: {
      track: { kind: "video", index: 0 },
      clip: colorClip(60, "gold", { id: "appended-clip", fadeOut: 15 }),
    },
  },
  {
    name: "append a file clip onto a track ending in a blank gap",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(colorClip(30, "blue"))],
      });
    },
    args: {
      track: { kind: "video", index: 0 },
      clip: clip("/abs/b.mp4", { id: "appended-file", dur: 50 }),
    },
  },
];
