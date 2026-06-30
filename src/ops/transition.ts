// pushTransition / popTransition — add or remove a field-level (cross-track)
// transition on the main tractor. These are the edit-algebra primitives behind
// the `timeline.addGraphic` composite (a graphic overlay needs a qtblend field
// transition compositing the upper graphics track over the lower footage track).
//
// They are intentionally minimal structural ops over `state.transitions` (plain
// data — a service + a/b track index + an [in,out] span). `pushTransition`
// appends; its inverse is `popTransition` of one. `popTransition` removes the
// last `count` transitions, CAPTURING them so its inverse re-pushes them
// verbatim. Keeping these in the op registry means the whole addGraphic sequence
// — addTrack, overwrite, pushTransition — inverts uniformly through `apply`, so
// `timeline.undo` replays a graphic exactly.
import { z } from "zod";
import { transitionSchema } from "../ir/types";
import type { Timeline, Transition } from "../ir/types";
import { cloneTimeline } from "./primitives";
import { type EditError, type Op, type OpResult, editError, noConsequences } from "./types";

/** pushTransition — append a field transition to the main tractor. */
export const pushTransitionArgs = z.object({ transition: transitionSchema });
export type PushTransitionArgs = z.infer<typeof pushTransitionArgs>;

export const pushTransition: Op<PushTransitionArgs> = (state, args): OpResult | EditError => {
  const next = cloneTimeline(state);
  next.transitions.push(structuredClone(args.transition) as Transition);
  return {
    state: next,
    consequences: noConsequences(),
    inverse: { op: "_popTransition", args: { count: 1 } },
  };
};

/** popTransition — remove the last `count` field transitions, capturing them so
 *  the inverse re-pushes them exactly. */
export const popTransitionArgs = z.object({
  count: z.number().int().positive().default(1),
});
export type PopTransitionArgs = z.infer<typeof popTransitionArgs>;

export const popTransition: Op<PopTransitionArgs> = (state, args): OpResult | EditError => {
  if (args.count > state.transitions.length) {
    return editError({
      kind: "precondition",
      detail: `popTransition: cannot pop ${args.count} of ${state.transitions.length} transitions`,
    });
  }
  const next = cloneTimeline(state);
  const removed = next.transitions.splice(next.transitions.length - args.count, args.count);
  return {
    state: next,
    consequences: noConsequences(),
    // Re-push the captured transitions in their original order.
    inverse: { op: "_restoreTransitions", args: { transitions: removed } },
  };
};

/** _restoreTransitions — the internal inverse of popTransition: re-append the
 *  captured transitions verbatim. Its own inverse pops exactly that many, so
 *  undo-of-undo round-trips. */
export const restoreTransitionsArgs = z.object({
  transitions: z.array(transitionSchema),
});
export type RestoreTransitionsArgs = z.infer<typeof restoreTransitionsArgs>;

export const restoreTransitions: Op<RestoreTransitionsArgs> = (
  state,
  args,
): OpResult | EditError => {
  const next = cloneTimeline(state);
  for (const t of args.transitions) next.transitions.push(structuredClone(t) as Transition);
  return {
    state: next,
    consequences: noConsequences(),
    inverse: { op: "_popTransition", args: { count: args.transitions.length } },
  };
};

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { colorClip, resetIds, timeline, transition, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samplesPushTransition: OpSample<PushTransitionArgs>[] = [
  {
    name: "push a qtblend field transition over two video tracks",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(colorClip(60, "gold", { id: "gfx" })),
          videoTrack(colorClip(60, "blue", { id: "base" })),
        ],
      });
    },
    // GFX (b=1) over footage (a=2) for [0,59].
    args: { transition: transition("qtblend", 2, 1, 0, 59, {}) },
  },
];

export const samplesPopTransition: OpSample<PopTransitionArgs>[] = [
  {
    name: "pop the last field transition (captured + restored by the inverse)",
    state: (): Timeline => {
      resetIds();
      return timeline(
        VERTICAL,
        {
          video: [
            videoTrack(colorClip(60, "gold", { id: "gfx2" })),
            videoTrack(colorClip(60, "blue", { id: "base2" })),
          ],
        },
        { transitions: [transition("qtblend", 2, 1, 0, 59, {})] },
      );
    },
    args: { count: 1 },
  },
];
