// The MCP TOOL-RESULT CONTRACT — the shape every mutating vean tool returns.
//
// This is the load-bearing "tool output discipline" rule (AGENTS.md "Agent
// feedback contract", BUILD-MONITOR review lens #3). A mutating tool (`apply-op`,
// `undo`, …) reports:
//   • `consequences` — the structured "what changed" report from the edit algebra
//     (clips added/removed/moved/trimmed, ripple, duration delta, warnings). This
//     is the whole reason the ops layer exists: report consequences BEFORE a frame
//     renders.
//   • `inverse` — the op invocation that undoes this edit (re-applied via the
//     `undo` tool). Mirrors how Claude sees an undoable code edit.
//   • `touchedUris` — which document(s) this edit changed, so the agent (and the
//     ambient LSP) know what to re-read.
//   • `alerts` — optional, present ONLY when this mutation introduced new blocking
//     error diagnostics. Clean edits omit it entirely.
//
// The full current diagnostic set belongs to the AMBIENT LSP stream
// (`publishDiagnostics`) and to the explicit `diagnose` debug/CI verb — NEVER to a
// mutating tool's response, which would flood the agent's context on every call
// (the explicit escalation trigger: "tool responses include full diagnostic dumps
// by default"). A tool returns mutation-local facts; the editor already has the
// full picture.
import type { Diagnostic } from "../../diagnostics";
import type { Consequences, OpInvocation } from "../../ops";

// ─── The mutating-tool result ───────────────────────────────────────────────
/** The result every mutating tool returns. Focused by construction: the
 *  consequence report + the inverse + touched URIs, with optional alerts only when
 *  this mutation introduced new blocking errors. No standing health snapshot and
 *  no full diagnostic dump. */
export type ToolResult = {
  /** Whether the op applied. A false here carries `error` (a typed EditError
   *  message) and no state change. */
  ok: true;
  /** The structured consequence report from the edit algebra. */
  consequences: Consequences;
  /** The op that undoes this edit (re-apply via `undo`). */
  inverse: OpInvocation;
  /** Documents this edit changed (so the agent re-reads + the LSP re-publishes). */
  touchedUris: string[];
  /** New error diagnostics introduced by this mutation. Omitted when empty. */
  alerts?: Diagnostic[];
};

/** A failed mutating tool: a typed reason, no state change. Returned (not thrown)
 *  so the agent sees the precondition the same way the edit algebra reports it. */
export type ToolError = {
  ok: false;
  /** The EditError kind (`clip-not-found`, `dissolve-too-long`, …) or `parse`. */
  kind: string;
  /** Human-readable detail. */
  detail: string;
};

export type ToolOutcome = ToolResult | ToolError;

/** Narrow a tool outcome to the error arm. */
export function isToolError(x: ToolOutcome): x is ToolError {
  return x.ok === false;
}

// ─── Read-tool results (no mutation, no alert delta) ─────────────────────────
// `resolve-value-at-frame`, `find-references`, `render`, `still` don't mutate the
// document, so they don't carry the consequence/inverse/alerts shape — they return
// their own payload directly (the resolved value, the reference set, the produced
// file path). Their result types live with their handlers; this file owns only the
// MUTATING contract, which is the one with the discipline rule.
