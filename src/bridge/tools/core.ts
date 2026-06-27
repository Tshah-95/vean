// The vean TOOL CORE — the transport-free implementation of the NON-mutating
// domain tools, plus the serialization helpers every binding shares.
//
// Like the LSP engine, this is split from the MCP/CLI wiring (`../mcp/server`, the
// scripts): these are pure (or query-delegating) functions that CALL THE SHARED
// CORE — the navigation queries (src/query) and the diagnostics engine
// (src/diagnostics) — and return their own payloads. The MCP server / CLI just
// JSON-marshal these.
//
// The MUTATING tools (`apply-op`, `preview-op`, `undo`) and the tool-output
// discipline they enforce live in their own module, `./mutate` — kept apart
// because the mutation-output contract is the load-bearing rule and deserves a
// dedicated home (and its own focused tests). They are RE-EXPORTED here so the
// barrel + the bindings have one import surface for "the tool core".
//
// `diagnose` is the ONE tool allowed to return the FULL diagnostic set: it is the
// explicit debug/CI verb, called deliberately for a complete report, NOT after
// every edit. It lives here, with the read tools, deliberately APART from the
// mutators in `./mutate` — the mutators return mutation-local facts, never a
// standing health snapshot or the full dump.
import { type Diagnostic, collectDiagnostics, summarize } from "../../diagnostics";
import { fromMlt } from "../../ir/parse";
import { toMlt } from "../../ir/serialize";
import type { Timeline } from "../../ir/types";

// ─── The mutating tools (re-exported from their dedicated module) ────────────
// `apply-op` / `preview-op` / `undo` + the mutation-output discipline live in
// `./mutate`; surface them here so the barrel + bindings import "the tool core"
// from one place.
export { alertsDelta, editErrorDetail, mutate, preview, undoTool } from "./mutate";

// ─── The read/render tools (re-exported from their dedicated module) ─────────
// The two navigation queries (resolve-value-at-frame, find-references) and the two
// driver inspect verbs (render, still) live in `./read` — the transport-free
// read/render tool core, symmetric to `./mutate` on the read side. Surface them
// here so the barrel + bindings import "the tool core" from one place. (render/
// still return `touchedUris` — the produced artifact the agent inspects next.)
export {
  type ReadResult,
  type RenderToolResult,
  type ReadError,
  type ReadOutcome,
  type RenderOutcome,
  isReadError,
  resolveTool,
  referencesTool,
  renderTool,
  stillTool,
} from "./read";

// ─── The diagnose debug verb (stays here, with parse/serialize) ──────────────
/** diagnose (debug/CI tool, NOT the ambient loop): the FULL current set + health.
 *  This is the ONE tool allowed to return the full set, because it is the explicit
 *  debug verb — an agent calls it deliberately for a full report, not after every
 *  edit. The mutating tools (`./mutate`) return mutation-local facts instead. */
export function diagnoseTool(state: Timeline): {
  health: ReturnType<typeof summarize>;
  diagnostics: Diagnostic[];
} {
  const diagnostics = collectDiagnostics(state);
  return { health: summarize(diagnostics), diagnostics };
}

// ─── Serialization helpers (shared by the tools + the MCP server) ────────────
/** Parse a `.mlt` text to IR (the document the tools mutate). Throws on a
 *  malformed document — the MCP server maps that to a `ToolError`. */
export function parseDoc(text: string): Timeline {
  return fromMlt(text);
}

/** Serialize an IR back to `.mlt` text (after a mutating tool, to write the file
 *  the LSP then re-reads). Deterministic + Shotcut-clean by the Move-0 contract. */
export function serializeDoc(state: Timeline): string {
  return toMlt(state);
}
