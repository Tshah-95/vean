// The op REGISTRY + the `apply` dispatcher. This is the single entry point to the
// edit algebra: a `name → { fn, args schema }` map of every op, the dispatcher
// that validates args (a malformed call is a typed `invalid-args` EditError, not
// a thrown ZodError) and runs the op, and the `samples` collection the
// registry-driven invariant harness consumes.
//
// Undo is `apply(result.inverse, result.state)` — the inverse is itself a
// registry invocation, so the dispatcher handles it uniformly. Internal restore
// ops (`_dropAppended`, `_unsplit`, …) are registered too (prefixed `_`) so an
// inverse that carries captured content dispatches like any other op.
import { z } from "zod";
import type { Timeline } from "../ir/types";
// Op functions + their samples come from the per-op files; the args SCHEMAS are
// the canonical ones in `./types` (imported below), so an op file never has to
// re-export its schema.
import { append, samples as appendSamples, dropAppended, dropAppendedArgs } from "./append";
import {
  dissolve,
  samples as dissolveSamples,
  removeDissolve,
  removeDissolveArgs,
} from "./dissolve";
import { fadeIn, fadeOut, samplesFadeIn, samplesFadeOut } from "./fade";
import { addFilter, removeFilter, samplesAddFilter, samplesRemoveFilter } from "./filter";
import { gain, samples as gainSamples, setGain, setGainArgs } from "./gain";
import { insert, samples as insertSamples, uninsert, uninsertArgs } from "./insert";
import { lift, samples as liftSamples, unlift, unliftArgs } from "./lift";
import {
  detachAudio,
  linkClips,
  reattachAudio,
  reattachAudioInternal,
  reattachAudioInternalArgs,
  redetachAudio,
  redetachAudioArgs,
  restoreLinks,
  restoreLinksArgs,
  samplesDetachAudio,
  samplesLinkClips,
  samplesReattachAudio,
  samplesUnlinkClips,
  unlinkClips,
} from "./link";
import { move, moveOne, samples as moveSamples, spanTransition, spanTransitionArgs } from "./move";
import {
  overwrite,
  samples as overwriteSamples,
  restoreRegion,
  restoreRegionArgs,
} from "./overwrite";
import { reinsert, reinsertArgs, remove, samples as removeSamples } from "./remove";
import {
  removeWords,
  removeWordsArgs,
  samples as removeWordsSamples,
  restoreWords,
  restoreWordsArgs,
} from "./removeWords";
import { replace, samples as replaceSamples } from "./replace";
import { roll, rollArgs, samples as rollSamples } from "./roll";
import { slide, slideArgs, samples as slideSamples } from "./slide";
import { slip, slipArgs, samples as slipSamples } from "./slip";
import { split, samples as splitSamples, unsplit, unsplitArgs } from "./split";
import {
  addTrack,
  removeTrack,
  restoreTrack,
  restoreTrackArgs,
  samplesAddTrack,
  samplesRemoveTrack,
} from "./track";
import {
  popTransition,
  popTransitionArgs,
  pushTransition,
  pushTransitionArgs,
  restoreTransitions,
  restoreTransitionsArgs,
  samplesPopTransition,
  samplesPushTransition,
} from "./transition";
import { samplesTrimIn, samplesTrimOut, trimIn, trimOut } from "./trim";
import {
  type Consequences,
  type EditError,
  type Op,
  type OpEntry,
  type OpInvocation,
  type OpResult,
  type OpSample,
  addFilterArgs,
  addTrackArgs,
  appendArgs,
  detachAudioArgs,
  dissolveArgs,
  fadeArgs,
  gainArgs,
  insertArgs,
  isEditError,
  liftArgs,
  linkClipsArgs,
  moveArgs,
  noConsequences,
  overwriteArgs,
  reattachAudioArgs,
  removeArgs,
  removeFilterArgs,
  removeTrackArgs,
  replaceArgs,
  splitArgs,
  trimArgs,
  unlinkClipsArgs,
} from "./types";

// ─── The registry ────────────────────────────────────────────────────────────
// Each entry pairs the op fn with its args Zod schema. The `_`-prefixed ops are
// the internal inverse/restore forms (a fully-specified inverse carrying captured
// content) — public ops never call them directly; only an `inverse` invocation
// names them.
// A heterogeneous registry of differently-typed ops. Each op's args schema may
// carry `.default()` fields (so its Zod INPUT type ≠ its OUTPUT type); the op fn
// is written against the OUTPUT type. `reg` pairs them by the schema's OUTPUT
// (`z.output<S>`), which is exactly what `safeParse(...).data` yields and what the
// op fn consumes — so dispatch is type-correct end to end.
// biome-ignore lint/suspicious/noExplicitAny: the registry is intentionally heterogeneous; per-entry typing is recovered at the call sites via each op's own signature, and `apply` validates args through the paired schema before dispatch.
const reg = <S extends z.ZodTypeAny>(fn: Op<z.output<S>>, args: S): OpEntry<any> => ({
  // biome-ignore lint/suspicious/noExplicitAny: erased to the heterogeneous registry entry type; the paired schema guarantees args shape at dispatch.
  fn: fn as Op<any>,
  // biome-ignore lint/suspicious/noExplicitAny: erased alongside fn; safeParse re-establishes the concrete type.
  args: args as any,
});

// ─── _compound — one reversible edit built from a sequence of invocations ──────
// A macro op: thread `state` through each step (via `apply`), collect every step's
// inverse, and return ONE result whose own inverse re-applies those inverses in
// REVERSE order. This lets a higher-level op reuse already-verified ops AND their
// capturing inverses instead of hand-rolling a bespoke restore. `move` (non-ripple)
// is the first user: it is lift(source)+overwrite(dest), so its undo is
// _restoreRegion(dest)∘_unlift(source) — the destination content overwrite captured
// is restored, and the clip is put back at the source. Pure (every sub-op clones);
// self-inverse (undo of a compound is a compound of the reversed inverses, which
// redoes the original). It lives HERE beside the registry so op files only NAME it
// in an inverse invocation — no import cycle. `apply` is a hoisted function, so the
// runtime call below resolves even though `apply` is declared later in the module.
// Internal (`_`-prefixed): never agent-facing.
export const compoundArgs = z.object({
  steps: z.array(z.object({ op: z.string().min(1), args: z.any() })).default([]),
});
export type CompoundArgs = z.infer<typeof compoundArgs>;

function mergeConsequences(into: Consequences, add: Consequences): void {
  into.clipsAdded.push(...add.clipsAdded);
  into.clipsRemoved.push(...add.clipsRemoved);
  into.clipsMoved.push(...add.clipsMoved);
  into.clipsTrimmed.push(...add.clipsTrimmed);
  into.blanksCreated.push(...add.blanksCreated);
  into.blanksRemoved.push(...add.blanksRemoved);
  into.ripple.push(...add.ripple);
  into.durationDelta += add.durationDelta;
  into.warnings.push(...add.warnings);
}

export const compound: Op<CompoundArgs> = (state, args): OpResult | EditError => {
  let cur = state;
  const inverses: OpInvocation[] = [];
  const merged = noConsequences();
  for (const step of args.steps) {
    const r = apply({ op: step.op, args: step.args }, cur);
    if (isEditError(r)) return r;
    cur = r.state;
    inverses.push(r.inverse);
    mergeConsequences(merged, r.consequences);
  }
  return {
    state: cur,
    consequences: merged,
    inverse: { op: "_compound", args: { steps: [...inverses].reverse() } },
  };
};

export const REGISTRY: Record<string, OpEntry<unknown>> = {
  // Reference ops (implemented).
  append: reg(append, appendArgs),
  split: reg(split, splitArgs),
  // Stubs (finalized signatures; bodies land in Move 1b).
  insert: reg(insert, insertArgs),
  overwrite: reg(overwrite, overwriteArgs),
  lift: reg(lift, liftArgs),
  remove: reg(remove, removeArgs),
  replace: reg(replace, replaceArgs),
  trimIn: reg(trimIn, trimArgs),
  trimOut: reg(trimOut, trimArgs),
  slip: reg(slip, slipArgs),
  slide: reg(slide, slideArgs),
  move: reg(move, moveArgs),
  roll: reg(roll, rollArgs),
  dissolve: reg(dissolve, dissolveArgs),
  fadeIn: reg(fadeIn, fadeArgs),
  fadeOut: reg(fadeOut, fadeArgs),
  gain: reg(gain, gainArgs),
  addFilter: reg(addFilter, addFilterArgs),
  removeFilter: reg(removeFilter, removeFilterArgs),
  addTrack: reg(addTrack, addTrackArgs),
  removeTrack: reg(removeTrack, removeTrackArgs),
  pushTransition: reg(pushTransition, pushTransitionArgs),
  popTransition: reg(popTransition, popTransitionArgs),
  // A/V split (the detachAudio family) — split an A/V clip into a video-only +
  // audio-only pair joined by a typed link, and the link primitives.
  detachAudio: reg(detachAudio, detachAudioArgs),
  reattachAudio: reg(reattachAudio, reattachAudioArgs),
  linkClips: reg(linkClips, linkClipsArgs),
  unlinkClips: reg(unlinkClips, unlinkClipsArgs),
  // Word-level cut (transcript-driven; targets are stable-id-resolved frame
  // ranges, never indices). Internal inverse `_restoreWords` below.
  removeWords: reg(removeWords, removeWordsArgs),
  // Internal inverse/restore ops.
  _dropAppended: reg(dropAppended, dropAppendedArgs),
  _unsplit: reg(unsplit, unsplitArgs),
  _uninsert: reg(uninsert, uninsertArgs),
  _unlift: reg(unlift, unliftArgs),
  _reinsert: reg(reinsert, reinsertArgs),
  _restoreRegion: reg(restoreRegion, restoreRegionArgs),
  _compound: reg(compound, compoundArgs),
  _spanTransition: reg(spanTransition, spanTransitionArgs),
  _removeDissolve: reg(removeDissolve, removeDissolveArgs),
  _setGain: reg(setGain, setGainArgs),
  _restoreTrack: reg(restoreTrack, restoreTrackArgs),
  // `_popTransition` is the INTERNAL inverse name `pushTransition`'s inverse
  // dispatches to (so an undo of an addGraphic pop is namespaced); it shares the
  // same body as the public `popTransition`.
  _popTransition: reg(popTransition, popTransitionArgs),
  _restoreTransitions: reg(restoreTransitions, restoreTransitionsArgs),
  _restoreWords: reg(restoreWords, restoreWordsArgs),
  // A/V-split inverses: detachAudio↔_reattachAudio, reattachAudio↔_redetachAudio,
  // link/unlink↔_restoreLinks.
  _reattachAudio: reg(reattachAudioInternal, reattachAudioInternalArgs),
  _redetachAudio: reg(redetachAudio, redetachAudioArgs),
  _restoreLinks: reg(restoreLinks, restoreLinksArgs),
  // The link-UNAWARE single-clip move core: the link-aware public `move` drives
  // partner sub-moves through this so a partner never re-expands its own link.
  _moveOne: reg(moveOne, moveArgs),
};

/** The set of PUBLIC op names (excludes the `_`-prefixed internal restore ops) —
 *  the agent-facing vocabulary. */
export const OP_NAMES: string[] = Object.keys(REGISTRY).filter((n) => !n.startsWith("_"));

// ─── apply — the dispatcher (validate args, then run) ─────────────────────────
/** Apply an op invocation to a state. Looks the op up in the registry, validates
 *  `args` against its Zod schema (a parse failure → `invalid-args` EditError, not
 *  a throw), and runs it. Undo = `apply(result.inverse, result.state)`. An
 *  unknown op name → `precondition` EditError. */
export function apply(invocation: OpInvocation, state: Timeline): OpResult | EditError {
  const entry = REGISTRY[invocation.op];
  if (!entry) {
    return { kind: "precondition", detail: `apply: unknown op "${invocation.op}"` };
  }
  const parsed = entry.args.safeParse(invocation.args);
  if (!parsed.success) {
    return { kind: "invalid-args", detail: `${invocation.op}: ${parsed.error.message}` };
  }
  return entry.fn(state, parsed.data);
}

/** Apply an op's inverse — sugar for `apply(result.inverse, result.state)`. The
 *  undo of a successful op. */
export function undo(result: OpResult): OpResult | EditError {
  return apply(result.inverse, result.state);
}

// ─── Samples (registry-driven invariant harness) ──────────────────────────────
// Each op contributes its `samples` under the registry name the harness drives.
// Append + split are populated; the rest are empty until their bodies land (the
// harness skips an op with no samples). Verbs that share a file (trim/fade/
// filter/track) export per-verb sample arrays wired to the right name here.
export const SAMPLES: Record<string, OpSample[]> = {
  append: appendSamples as OpSample[],
  split: splitSamples as OpSample[],
  insert: insertSamples as OpSample[],
  overwrite: overwriteSamples as OpSample[],
  lift: liftSamples as OpSample[],
  remove: removeSamples as OpSample[],
  replace: replaceSamples as OpSample[],
  trimIn: samplesTrimIn as OpSample[],
  trimOut: samplesTrimOut as OpSample[],
  slip: slipSamples as OpSample[],
  slide: slideSamples as OpSample[],
  move: moveSamples as OpSample[],
  roll: rollSamples as OpSample[],
  dissolve: dissolveSamples as OpSample[],
  fadeIn: samplesFadeIn as OpSample[],
  fadeOut: samplesFadeOut as OpSample[],
  gain: gainSamples as OpSample[],
  addFilter: samplesAddFilter as OpSample[],
  removeFilter: samplesRemoveFilter as OpSample[],
  addTrack: samplesAddTrack as OpSample[],
  removeTrack: samplesRemoveTrack as OpSample[],
  pushTransition: samplesPushTransition as OpSample[],
  popTransition: samplesPopTransition as OpSample[],
  detachAudio: samplesDetachAudio as OpSample[],
  reattachAudio: samplesReattachAudio as OpSample[],
  linkClips: samplesLinkClips as OpSample[],
  unlinkClips: samplesUnlinkClips as OpSample[],
  removeWords: removeWordsSamples as OpSample[],
};

// ─── Re-exports (the public op surface) ───────────────────────────────────────
export * from "./types";
export * from "./primitives";
export {
  append,
  split,
  insert,
  overwrite,
  lift,
  remove,
  replace,
  trimIn,
  trimOut,
  slip,
  slide,
  move,
  roll,
  dissolve,
  fadeIn,
  fadeOut,
  gain,
  addFilter,
  removeFilter,
  addTrack,
  removeTrack,
  pushTransition,
  popTransition,
  detachAudio,
  reattachAudio,
  linkClips,
  unlinkClips,
  removeWords,
};
export { isEditError };
