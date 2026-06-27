// replace — swap the producer at a clip's slot, keeping the played WINDOW length.
//
// Shotcut semantics (`multitrackmodel.cpp::replace`): replace the producer at the
// clip's entry while keeping the slot's playtime — the new producer is resized to
// the existing slot length so nothing after it shifts. Optionally copy the old
// clip's filters onto the replacement (`copyFilters`). The clip's timeline
// position and length are unchanged; only its content (resource/service/window)
// changes.
//
// vean mirrors this on the pure IR: locate the clip, build the replacement from
// `args.clip` but RESIZE it to the old slot's playtime (anchored at the new clip's
// `in`), preserving the replacement's identity (its own uuid) and — when
// `copyFilters` — prepending the old clip's filters ahead of the replacement's.
// Because the slot playtime is preserved, no neighbour moves and the timeline
// duration is unchanged.
//
// Inverse: `replace({ uuid: <new clip uuid>, clip: <captured old clip> })`. The
// captured old clip carries its full window + filters + gain, and since the slot
// playtime is unchanged the inverse resizes it to a no-op — restoring the original
// byte-for-byte. (We capture the WHOLE old clip, not just its resource, so the
// restore is exact.) `copyFilters` is `false` on the inverse: the captured old
// clip already carries its own filter list verbatim, so re-copying would double it.
import type { Clip, Track } from "../ir/types";
import { cloneTimeline, findClip, playtime } from "./primitives";
import {
  type EditError,
  type Op,
  type OpResult,
  type ReplaceArgs,
  clipUuid,
  editError,
  noConsequences,
  replaceArgs,
} from "./types";

export const replace: Op<ReplaceArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  // Capture the WHOLE old clip for the exact inverse.
  const oldClip: Clip = structuredClone(loc.clip);
  const slot = playtime(oldClip);

  // Build the replacement: take args.clip but pin its played window to the slot
  // length (anchored at the replacement's own `in`), so neighbours never move.
  const incoming = structuredClone(args.clip);
  const replacement: Clip = {
    ...incoming,
    in: incoming.in,
    out: incoming.in + slot - 1,
    filters: args.copyFilters
      ? [...structuredClone(oldClip.filters), ...incoming.filters]
      : incoming.filters,
  };

  const next = cloneTimeline(state);
  const track = next.tracks[loc.trackKind][loc.trackIndex] as Track;
  track.items[loc.itemIndex] = replacement;

  const c = noConsequences();
  // The old content leaves and the new content arrives at the SAME slot; report it
  // as a remove + add at the identical position/playtime (no move, no trim of
  // neighbours, no duration change).
  c.clipsRemoved.push({
    uuid: oldClip.id,
    track: loc.trackId,
    position: loc.position,
    playtime: slot,
  });
  c.clipsAdded.push({
    uuid: clipUuid(replacement),
    track: loc.trackId,
    position: loc.position,
    playtime: playtime(replacement),
  });
  c.durationDelta = 0;

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "replace",
      args: { uuid: clipUuid(replacement), clip: oldClip, copyFilters: false },
    },
  };
};

export { replaceArgs };

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { clip, colorClip, filter, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<ReplaceArgs>[] = [
  {
    name: "replace a file clip with another (window pinned to the slot, neighbours fixed)",
    state: () => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(20, "black"),
            clip("/abs/old.mp4", { id: "swapme", dur: 40, fadeIn: 6 }),
            colorClip(20, "gold"),
          ),
        ],
      });
    },
    // The new clip's `in` is 5; replace pins its out to in + 40 - 1 = 44.
    args: {
      uuid: "swapme",
      clip: clip("/abs/new.mp4", { id: "newclip", in: 5, out: 9 }),
      copyFilters: false,
    },
  },
  {
    name: "replace with copyFilters (old clip's filters ride onto the replacement)",
    state: () => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/has-filters.mp4", {
              id: "swapme",
              dur: 50,
              fadeOut: 10,
              filters: [filter("brightness", { level: "0=0.5;49=1" })],
            }),
          ),
        ],
      });
    },
    args: {
      uuid: "swapme",
      clip: colorClip(10, "blue", { id: "newcolor" }),
      copyFilters: true,
    },
  },
];
