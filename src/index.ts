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

// ─── The navigation queries (Move 1b) ──────────────────────────────────────
// Pure, document-keyed QUERIES over the IR — the LSP's hover/go-to-definition/
// find-references surface. `resolveValueAtFrame` (the effective value of a
// parameter at a frame, with the resolution path) and `findReferences` (clips
// using a source, readers/writers of a property, a clip's adjacency/ripple set).
// Namespaced so the query verbs don't collide with the ops/builder surface.
export * as query from "./query";

// ─── The diagnostics engine (Move 1b) ──────────────────────────────────────
// The SHARED diagnostics core — the one place domain validity rules live. The
// future LSP, the MCP tools, the CLI debug verb, tests, and the UI all call
// `collectDiagnostics(state)` (the FULL current set for a document — LSP-ready,
// an empty set clears). Pure + document-keyed; no I/O. Namespaced so the
// diagnostics verbs don't collide with ops/query.
export * as diagnostics from "./diagnostics";

// ─── The render/inspect driver (Move 0) ────────────────────────────────────
export * from "./driver/melt";

// ─── The agent bridge (Move 2) ─────────────────────────────────────────────
// Two coordinated surfaces over the SAME shared core: `vean-lsp` (ambient
// publishDiagnostics + navigation + code actions) and the MCP/CLI domain tools
// (apply-op/preview-op/undo/render/still/resolve/refs, returning focused
// mutation results plus optional alerts). Neither reimplements a rule — the LSP engine calls
// `collectDiagnostics` + the queries + the source map; the tools call the edit
// algebra + diagnostics + driver. Namespaced so the bridge's verbs don't collide.
export * as bridge from "./bridge";
