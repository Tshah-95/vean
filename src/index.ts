// vean — the agent-native video editing core.
//
// This is the headless barrel. Real surface lands per Move (see ROADMAP.md):
//   src/ir/          the typed document: IR types, serialize, parse, keyframes (Move 0)
//   src/ops/         the edit algebra: op(state) -> {state', consequences, inverse} (Move 1)
//   src/diagnostics/ the LSP: static checks, resolve-value-at-frame, find-references (Move 1)
//   src/bridge/      the agent surface: CLI / MCP verbs (Move 2)
//   src/driver/      the melt/ffmpeg subprocess driver + inspect

export const VERSION = "0.0.0";
