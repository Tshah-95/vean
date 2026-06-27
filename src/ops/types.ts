// The edit-algebra CONTRACT — the types every op (`src/ops/*.ts`) is written
// against. Mined from Shotcut's `src/commands/timelinecommands.{h,cpp}` and
// `src/models/multitrackmodel.cpp` (the answer key): we lift the op *semantics*
// and drop the Qt `QUndoCommand`/`UndoHelper` machinery. Where Shotcut mutates a
// live `Mlt::Playlist` and snapshots the whole track XML for undo, vean ops are
// PURE functions over the Timeline IR whose inverse is a fully-specified op
// invocation (smaller, diffable, composable).
//
// The five laws (enforced by tests/op-invariants.test.ts):
//   1. Purity — `op(state,args).state` is fresh; the input is never mutated.
//   2. Inverse — apply(inverse, apply(op).state).state DEEP-EQUALS the original.
//   3. Determinism — any randomness (a minted uuid) is captured into the inverse.
//   4. Serializability — toMlt(result.state) is namespace-clean + round-trips.
//   5. Typed failure — an invalid precondition returns an EditError VALUE, never
//      a thrown opaque error.
import { z } from "zod";
import { type Clip, type Timeline, clipSchema, trackKind } from "../ir/types";

// ─── UUID identity ───────────────────────────────────────────────────────────
// `Clip.id` IS the stable op-target uuid (see DESIGN-MOVE1.md §1). Ops target
// clips by uuid, NEVER by (trackIndex, clipIndex) — indices are ephemeral (every
// insert/remove/split renumbers them). This alias makes that intent legible at
// every call site without a wire-format change.
/** The stable op-target identity of a clip. */
export type Uuid = string;
/** The uuid of a clip (its `id`). Ops address content by THIS, not by index. */
export function clipUuid(clip: Clip): Uuid {
  return clip.id;
}

// ─── Track addressing ────────────────────────────────────────────────────────
// A track is addressed by its stable `id` (the playlist id), or by a
// (kind, index) pair for ops that create/position tracks. The video/audio split
// in the IR (`tracks.video[]` / `tracks.audio[]`) is the index space.
export const trackAddrSchema = z.union([
  z.object({ trackId: z.string().min(1) }),
  z.object({ kind: trackKind, index: z.number().int().nonnegative() }),
]);
export type TrackAddr = z.infer<typeof trackAddrSchema>;

// ─── Consequences — the structured "what changed" report ─────────────────────
// The reason this layer exists: report consequences BEFORE a frame renders.
// A superset; an op fills only the fields it touches. Everything locates by
// uuid + track id + position (frames from track start), never a bare index.

/** Where a clip is, by stable identity + position (never a raw index). */
export type ClipRef = {
  uuid: Uuid;
  /** The track's stable id. */
  track: string;
  /** Frames from the track's start to the clip's start. */
  position: number;
  /** Played length in frames (out - in + 1). */
  playtime: number;
};

export type BlankRef = {
  track: string;
  /** Frames from the track's start to the blank's start. */
  position: number;
  length: number;
};

export type ClipMove = {
  uuid: Uuid;
  from: { track: string; position: number };
  to: { track: string; position: number };
};

export type ClipTrim = {
  uuid: Uuid;
  /** Signed change to the clip's in-point (+ = trimmed in / later start). */
  inDelta: number;
  /** Signed change to the clip's out-point (+ = extended / later end). */
  outDelta: number;
  /** Signed change to playtime. */
  playtimeDelta: number;
};

/** A ripple effect on ONE other track: a shift of its content. */
export type RippleEffect = {
  track: string;
  /** Frames the track's content shifted (signed: + = right/later). */
  shift: number;
  /** Frame position from which the shift applies. */
  from: number;
};

/** A non-fatal advisory (e.g. "fade shortened to fit the trimmed clip"). */
export type Warning = { code: string; detail: string };

/** The full consequence report of one op. */
export type Consequences = {
  clipsAdded: ClipRef[];
  clipsRemoved: ClipRef[];
  clipsMoved: ClipMove[];
  clipsTrimmed: ClipTrim[];
  blanksCreated: BlankRef[];
  blanksRemoved: BlankRef[];
  ripple: RippleEffect[];
  /** Signed change to total timeline duration in frames. */
  durationDelta: number;
  warnings: Warning[];
};

/** An empty consequence report — ops spread over it and fill what they touch. */
export function noConsequences(): Consequences {
  return {
    clipsAdded: [],
    clipsRemoved: [],
    clipsMoved: [],
    clipsTrimmed: [],
    blanksCreated: [],
    blanksRemoved: [],
    ripple: [],
    durationDelta: 0,
    warnings: [],
  };
}

// ─── EditError — typed preconditions (the `…Valid()` guards, as VALUES) ───────
// Shotcut guards every op with a `…Valid()` predicate (trimClipInValid,
// addTransitionValid, …). vean returns the failure as a value so the
// bridge/diagnostics layer can surface it; an op NEVER throws for a bad
// precondition (law #5).
export type EditError =
  | { kind: "clip-not-found"; uuid: Uuid }
  | { kind: "track-not-found"; track: string }
  | { kind: "frame-out-of-range"; frame: number; bound: number; detail: string }
  | { kind: "dissolve-too-long"; frames: number; neighbour: number; side: "in" | "out" }
  | { kind: "split-at-boundary"; frame: number; detail: string }
  | { kind: "invalid-args"; detail: string }
  | { kind: "precondition"; detail: string };

/** Narrow an `OpResult | EditError` to the error arm. */
export function isEditError(x: OpResult | EditError): x is EditError {
  return "kind" in x && !("state" in x);
}

/** Construct an EditError (typed sugar so op bodies stay terse). */
export function editError(e: EditError): EditError {
  return e;
}

// ─── The op contract ─────────────────────────────────────────────────────────
/** A fully-specified op invocation: a registry op name + its args (possibly
 *  carrying captured removed-content for an inverse). This is what an `inverse`
 *  IS — re-applying it through `apply` undoes the forward op. */
export type OpInvocation = {
  op: string;
  // biome-ignore lint/suspicious/noExplicitAny: args are per-op; the registry validates them via the op's Zod schema before dispatch.
  args: any;
};

/** The result of a successful op: a NEW state, the consequence report, and the
 *  inverse invocation. `apply(inverse, state).state` deep-equals the original. */
export type OpResult = {
  state: Timeline;
  consequences: Consequences;
  inverse: OpInvocation;
};

/** Every op: `(state, args) -> OpResult | EditError`. Pure; never mutates
 *  `state`; never throws for a bad precondition (returns an EditError instead). */
export type Op<A> = (state: Timeline, args: A) => OpResult | EditError;

/** A registry entry: the op fn + its args Zod schema (validated by `apply`). */
export type OpEntry<A> = {
  /** The op's body. */
  fn: Op<A>;
  /** Zod schema for the op's args — `apply` parses args before dispatch, so a
   *  malformed call is an `invalid-args` EditError, not a thrown ZodError. */
  args: z.ZodType<A>;
};

// ─── samples fixture (the registry-driven invariant harness contract) ─────────
/** One invariant-test case for an op. `state` is a THUNK (fresh per call;
 *  `resetIds()` first for determinism) and `args` must be VALID for it — the
 *  harness asserts the op does not error, then checks inverse + serialize laws.
 *  Error-path cases live as separate unit tests in the op's own file. */
export type OpSample<A = unknown> = {
  name: string;
  state: () => Timeline;
  args: A;
};

// ─── Per-op arg schemas ───────────────────────────────────────────────────────
// Each op's input, Zod-validated by `apply` before dispatch. Kept here so the
// contract (args ⇄ op) is in one place; op bodies import the inferred types.
// `clipSchema` is reused for ops that take a whole clip to place.

const rippleAll = z.boolean().default(false);

/** append — place a clip at the end of a track. */
export const appendArgs = z.object({
  track: trackAddrSchema,
  clip: clipSchema,
});
export type AppendArgs = z.infer<typeof appendArgs>;

/** split — cut the clip `uuid` at timeline `frame`. */
export const splitArgs = z.object({
  uuid: z.string().min(1),
  frame: z.number().int().nonnegative(),
});
export type SplitArgs = z.infer<typeof splitArgs>;

/** insert (ripple) — split the covering clip at `position`, insert between. */
export const insertArgs = z.object({
  track: trackAddrSchema,
  clip: clipSchema,
  position: z.number().int().nonnegative(),
  rippleAllTracks: rippleAll,
});
export type InsertArgs = z.infer<typeof insertArgs>;

/** overwrite — drop `clip` over `[position, position+playtime)`, replacing. */
export const overwriteArgs = z.object({
  track: trackAddrSchema,
  clip: clipSchema,
  position: z.number().int().nonnegative(),
});
export type OverwriteArgs = z.infer<typeof overwriteArgs>;

/** lift — replace the clip with a same-length blank (leave a gap). */
export const liftArgs = z.object({ uuid: z.string().min(1) });
export type LiftArgs = z.infer<typeof liftArgs>;

/** remove (ripple) — drop the clip and close the gap. */
export const removeArgs = z.object({
  uuid: z.string().min(1),
  rippleAllTracks: rippleAll,
});
export type RemoveArgs = z.infer<typeof removeArgs>;

/** replace — swap the producer at the clip's slot, keeping the played length. */
export const replaceArgs = z.object({
  uuid: z.string().min(1),
  clip: clipSchema,
  /** Copy the old clip's filters onto the replacement (Shotcut's copyFilters). */
  copyFilters: z.boolean().default(false),
});
export type ReplaceArgs = z.infer<typeof replaceArgs>;

/** trimIn / trimOut — resize a clip's in/out by `delta` frames. */
export const trimArgs = z.object({
  uuid: z.string().min(1),
  /** Signed frames. trimIn: + trims the head (later start). trimOut: + extends
   *  the tail (later end). The neighbouring blank absorbs the change non-ripple. */
  delta: z.number().int(),
  rippleAllTracks: rippleAll,
});
export type TrimArgs = z.infer<typeof trimArgs>;

/** move — relocate a clip to (track, position). */
export const moveArgs = z.object({
  uuid: z.string().min(1),
  toTrack: trackAddrSchema,
  toPosition: z.number().int().nonnegative(),
  /** Ripple (push/pull) vs lift+overwrite (leave a gap, stamp over). */
  ripple: z.boolean().default(false),
  rippleAllTracks: rippleAll,
});
export type MoveArgs = z.infer<typeof moveArgs>;

/** dissolve — overlap two adjacent clips by `frames` into a same-track Dissolve. */
export const dissolveArgs = z.object({
  track: trackAddrSchema,
  leftUuid: z.string().min(1),
  rightUuid: z.string().min(1),
  frames: z.number().int().positive(),
  luma: z.string().default("luma"),
});
export type DissolveArgs = z.infer<typeof dissolveArgs>;

/** fadeIn / fadeOut — set the fade length (frames). 0 removes the fade. */
export const fadeArgs = z.object({
  uuid: z.string().min(1),
  frames: z.number().int().nonnegative(),
});
export type FadeArgs = z.infer<typeof fadeArgs>;

/** gain — set a clip's audio gain. Stored as the IR `Clip.gain` MULTIPLIER
 *  (1 = unity), which the serializer compiles to Shotcut's `audioGain` volume
 *  filter. `db` is accepted for the agent-facing API and converted. */
export const gainArgs = z.object({
  uuid: z.string().min(1),
  /** Gain in decibels (0 dB = unity). Converted to the IR multiplier. */
  db: z.number(),
});
export type GainArgs = z.infer<typeof gainArgs>;

/** addFilter — attach an (ordered) filter on the clip's producer. */
export const addFilterArgs = z.object({
  uuid: z.string().min(1),
  filter: z.object({
    service: z.string().min(1),
    properties: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
    shotcutName: z.string().optional(),
  }),
  /** Insertion index in the filter list; appended when omitted. */
  index: z.number().int().nonnegative().optional(),
});
export type AddFilterArgs = z.infer<typeof addFilterArgs>;

/** removeFilter — detach the filter at `index` from the clip's producer. */
export const removeFilterArgs = z.object({
  uuid: z.string().min(1),
  index: z.number().int().nonnegative(),
});
export type RemoveFilterArgs = z.infer<typeof removeFilterArgs>;

/** addTrack — add a video (prepend) or audio (append) track. */
export const addTrackArgs = z.object({
  kind: trackKind,
  /** Optional explicit id/name; minted when omitted. */
  id: z.string().min(1).optional(),
  name: z.string().optional(),
});
export type AddTrackArgs = z.infer<typeof addTrackArgs>;

/** removeTrack — drop a track (captured for the inverse). */
export const removeTrackArgs = z.object({ track: trackAddrSchema });
export type RemoveTrackArgs = z.infer<typeof removeTrackArgs>;

// gain dB ⇄ multiplier (shared by gain.ts + its inverse). 0 dB = 1.0.
/** Linear amplitude multiplier for `db` decibels (0 dB → 1). */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}
/** Decibels for a linear amplitude `mult` (1 → 0 dB). */
export function gainToDb(mult: number): number {
  return 20 * Math.log10(mult);
}
