// vean — the agent-native video editing core.
//
// This is the public headless barrel. The Move-0 spine (the typed document) is
// live; later Moves extend it (see ROADMAP.md):
//   src/ir/          the typed document: IR types, profile, builder, serialize,
//                    parse, keyframes (Move 0 — here now)
//   src/driver/      the melt/ffmpeg subprocess driver + inspect (Move 0)
//   src/ops/         the edit algebra: op(state) -> {state', consequences, inverse} (Move 1)
//   src/diagnostics/ the LSP: static checks, resolve-value-at-frame, find-references (Move 1)
//   src/bridge/      the agent surface: CLI / MCP verbs (Move 2)

export const VERSION = "0.0.0";

// ─── The typed IR (Move 0) ─────────────────────────────────────────────────
// Types + Zod schemas.
export * from "./ir/types";
// Profile presets + frame/second helpers.
export * from "./ir/profile";
// The authoring surface (clip, colorClip, dissolve, tracks, transition, …).
export * from "./ir/builder";
// IR ⇄ .mlt XML.
export { toMlt } from "./ir/serialize";
export { fromMlt } from "./ir/parse";
// The keyframe model + animation-string round-trip.
export * from "./ir/keyframes";

// ─── The edit algebra (Move 1) ─────────────────────────────────────────────
// The op registry + `apply`/`undo` dispatcher + the pure op(state) -> {state',
// consequences, inverse} contract. Two reference ops (append, split) are live;
// the rest are finalized-signature stubs filled in Move 1b. Exposed under the
// `ops` namespace so the op verbs (which intentionally share verbs with the IR
// builder, e.g. `dissolve`) don't collide with the builder's authoring surface:
// `ops.append(state, args)`, `ops.apply(inv, state)`, `ops.REGISTRY`, …
export * as ops from "./ops";

// ─── The render/inspect driver (Move 0) ────────────────────────────────────
export * from "./driver/melt";
