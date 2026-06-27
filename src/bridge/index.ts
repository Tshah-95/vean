// The agent BRIDGE barrel (Move 2). Two coordinated surfaces over the SAME shared
// core — never a reimplementation of a rule (that would be the BUILD-MONITOR
// escalation trigger; diagnostics rules live in src/diagnostics ONLY):
//
//   • lsp/    — vean-lsp: the AMBIENT-FEEDBACK surface. Document sync +
//               publishDiagnostics (push) + navigation + code actions. `engine`
//               is the transport-free heart (calls collectDiagnostics + the
//               source map + the queries); `server` is the stdio binding.
//   • tools/  — the ToolResult contract + the transport-free tool core (wraps the
//               edit algebra, diagnostics, queries, driver; enforces the focused
//               mutation-output discipline).
//   • mcp/    — vean-mcp: the DOMAIN-ACTION surface. Registers the tool set on an
//               MCP stdio server, marshalling each call to the tool core.
//
// The payoff of the split (AGENTS.md "the layer model"): a human gesture (a future
// UI) and an agent action (an MCP tool) become the SAME op through the SAME edit
// algebra, and BOTH update the SAME document the LSP watches — so ambient
// diagnostics are correct for either author. Build the editing logic once.

// LSP — ambient feedback.
//   engine      — analyze (parse + shared diagnostics → LSP shapes) + the shared
//                 element-locating helpers.
//   navigation  — hover / references / definition (the READ surface; calls
//                 src/query: resolveValueAtFrame + findReferences).
//   codeActions — the deterministic repairs (the FIX surface; WorkspaceEdits over
//                 the .mlt text, computed from a diagnostic's code + data).
export { analyze, toLspDiagnostic, type Analysis } from "./lsp/engine";
export { definition, hover, references } from "./lsp/navigation";
export { codeActions } from "./lsp/codeActions";
export { registerHandlers } from "./lsp/server";

// Tools — the contract + the core.
export {
  type ToolResult,
  type ToolError,
  type ToolOutcome,
  isToolError,
} from "./tools/types";
// The MUTATING tools (apply-op / preview-op / undo) + the mutation-output discipline.
export { mutate, preview, undoTool } from "./tools/mutate";
// The read / render / debug tools + the ser/de helpers. The two navigation
// queries (resolve/refs) + the two melt inspect verbs (render/still) live in
// `./tools/read`; render/still return `touchedUris` (the produced artifact the
// agent inspects next). `diagnose` + parse/serialize live in `./tools/core`.
export {
  resolveTool,
  referencesTool,
  renderTool,
  stillTool,
  isReadError,
  type ReadResult,
  type RenderToolResult,
  type ReadError,
  type ReadOutcome,
  type RenderOutcome,
  diagnoseTool,
  parseDoc,
  serializeDoc,
} from "./tools/core";

// MCP — domain actions.
export { registerTools } from "./mcp/server";
