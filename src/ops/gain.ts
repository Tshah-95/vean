// changeGain — set a clip's audio gain. The agent-facing arg is `db` (0 dB =
// unity); the IR stores the linear MULTIPLIER on `Clip.gain` (the serializer
// compiles a non-unity multiplier to Shotcut's `audioGain` volume filter, and a
// unity gain to no filter at all — `serialize.ts gainFilters`).
//
// Shotcut semantics (`multitrackmodel.cpp::changeGain`): find-or-attach the
// clip's `audioGain` volume filter and set its `level`. vean models that filter
// as the first-class `Clip.gain` field, so this op is a single-field set —
// find-or-attach is implicit (the field exists or is absent), and we never touch
// the filter list (fade sentinels and escape-hatch filters are untouched).
//
// Canonical form: unity gain is represented as `gain: undefined` (the field
// absent), NOT `gain: 1`. The serializer emits no volume filter for either, and
// the parser recovers `undefined` — so absent is the round-trip-faithful form.
// Setting gain to unity therefore CLEARS the field.
//
// Inverse: restore the EXACT previous gain. The design names this a scalar
// (`gain({ uuid, db: <previous> })`), but a dB round-trip is lossy across floats
// (`dbToGain(gainToDb(0.5)) !== 0.5`), which would break the deep-equals inverse
// law. So we capture the previous MULTIPLIER verbatim and restore it through a
// self-contained internal op `_setGain` (the same captured-data pattern append
// uses for `_dropAppended`). `_setGain`'s own inverse re-sets the value this op
// just wrote, so undo-of-undo round-trips too.
import { z } from "zod";
import type { Clip, Timeline, Track } from "../ir/types";
import { cloneTimeline, findClip } from "./primitives";
import {
  type EditError,
  type GainArgs,
  type Op,
  type OpResult,
  dbToGain,
  editError,
  gainArgs,
  noConsequences,
} from "./types";

/** Canonicalize a multiplier: unity (or anything ≤ epsilon of 1) is the absent
 *  field; otherwise the value itself. Mirrors `gainFilters`' unity check so the
 *  IR never carries a `gain: 1` that would silently vanish on round-trip. */
function canonGain(mult: number): number | undefined {
  return mult === 1 ? undefined : mult;
}

export const gain: Op<GainArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  const prev = loc.clip.gain; // the exact prior multiplier (undefined = unity)
  const nextGain = canonGain(dbToGain(args.db));

  const next = cloneTimeline(state);
  const target = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items[loc.itemIndex] as Clip;
  if (nextGain == null) {
    target.gain = undefined;
  } else {
    target.gain = nextGain;
  }

  const c = noConsequences();
  // A gain change neither moves frames nor adds/removes content — it's a level
  // edit on an existing clip. Report it as a (zero-length) trim of that clip so
  // the consequence log still names the affected clip.
  c.clipsTrimmed.push({
    uuid: loc.clip.id,
    inDelta: 0,
    outDelta: 0,
    playtimeDelta: 0,
  });

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "_setGain",
      args: { uuid: args.uuid, gain: prev ?? null },
    },
  };
};

export { gainArgs };

// ─── The internal inverse op (restore an exact prior multiplier) ──────────────
// Sets `Clip.gain` to the captured multiplier verbatim (`null` = unity = the
// absent field). Lossless where the public `gain` op (db→multiplier) is lossy,
// so gain's inverse-invariant holds byte-exact. Its own inverse re-sets the
// value the forward `gain` wrote, expressed back through the public `gain` op
// (db), so undo-of-undo composes through the registry.
export const setGainArgs = z.object({
  uuid: z.string().min(1),
  /** The exact multiplier to restore; `null` clears the field (unity). */
  gain: z.number().nonnegative().nullable(),
});
export type SetGainArgs = z.infer<typeof setGainArgs>;

export const setGain: Op<SetGainArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  const prev = loc.clip.gain; // captured so _setGain's own inverse is exact
  const restore = args.gain == null ? undefined : canonGain(args.gain);

  const next = cloneTimeline(state);
  const target = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items[loc.itemIndex] as Clip;
  if (restore == null) {
    target.gain = undefined;
  } else {
    target.gain = restore;
  }

  const c = noConsequences();
  c.clipsTrimmed.push({ uuid: loc.clip.id, inDelta: 0, outDelta: 0, playtimeDelta: 0 });

  // The inverse of restoring `prev` is restoring whatever was there before this
  // call. Expressed as another _setGain (lossless), it round-trips undo/redo.
  return {
    state: next,
    consequences: c,
    inverse: { op: "_setGain", args: { uuid: args.uuid, gain: prev ?? null } },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { audioTrack, clip, resetIds, timeline } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samples: OpSample<GainArgs>[] = [
  {
    name: "set gain on an audio clip that started at unity (no gain field)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        audio: [audioTrack(clip("/abs/vo.wav", { id: "vo", dur: 120 }))],
      });
    },
    // -6 dB → multiplier ~0.501; the inverse restores the absent field exactly.
    args: { uuid: "vo", db: -6 },
  },
  {
    name: "change gain on an audio clip that already had a non-unity gain",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        audio: [audioTrack(clip("/abs/vo.wav", { id: "vo2", dur: 90, gain: 0.5 }))],
      });
    },
    // +3 dB on top; inverse restores the literal prior 0.5 multiplier verbatim.
    args: { uuid: "vo2", db: 3 },
  },
  {
    name: "set gain to unity (0 dB) on a clip that had a gain — clears the field",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        audio: [audioTrack(clip("/abs/vo.wav", { id: "vo3", dur: 60, gain: 0.25 }))],
      });
    },
    // 0 dB → multiplier 1 → field cleared; inverse restores 0.25.
    args: { uuid: "vo3", db: 0 },
  },
];
