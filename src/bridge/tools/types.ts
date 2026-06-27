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
//   • `health` — a COMPACT diagnostic summary: error + warning COUNTS, plus ONLY
//     the NEW-or-BLOCKING diagnostic details (the deltas this edit introduced and
//     any error that blocks a faithful render). It is NOT the full diagnostic set.
//
// The full current diagnostic set belongs to the AMBIENT LSP stream
// (`publishDiagnostics`) and to the explicit `diagnose` debug/CI verb — NEVER to a
// mutating tool's response, which would flood the agent's context on every call
// (the explicit escalation trigger: "tool responses include full diagnostic dumps
// by default"). A tool returns the DELTA; the editor already has the full picture.
import type { Diagnostic } from "../../diagnostics";
import type { Consequences, OpInvocation } from "../../ops";

// ─── The compact health summary ─────────────────────────────────────────────
/** The diagnostic health an MCP mutation tool returns: counts + ONLY the
 *  new-or-blocking details. Deliberately NOT the full set.
 *
 *  `newOrBlocking` is the curated detail list — the diagnostics the agent must act
 *  on right now: every diagnostic this edit INTRODUCED (a delta vs the pre-edit
 *  set, keyed by code+location) PLUS any pre-existing ERROR that blocks a faithful
 *  render. A warning that already existed and the edit didn't touch is summarized
 *  in `warnings` but omitted from `newOrBlocking` — it's ambient context the LSP
 *  already showed, not news. */
export type ToolHealth = {
  /** Total error count in the post-edit document. */
  errors: number;
  /** Total warning count in the post-edit document. */
  warnings: number;
  /** True iff zero errors AND zero warnings (the clean gate). */
  clean: boolean;
  /** The curated detail list: diagnostics NEW to this edit + any blocking error.
   *  Compact — this is the ONLY place full Diagnostic objects appear in a tool
   *  result, and only for the ones that are news. */
  newOrBlocking: Diagnostic[];
};

// ─── The mutating-tool result ───────────────────────────────────────────────
/** The result every mutating tool returns. Compact by construction: the
 *  consequence report + the inverse + touched URIs + the compact health. No full
 *  diagnostic dump. */
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
  /** Compact diagnostic health: counts + new/blocking details ONLY. */
  health: ToolHealth;
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

// ─── Read-tool results (no mutation, no health delta) ────────────────────────
// `resolve-value-at-frame`, `find-references`, `render`, `still` don't mutate the
// document, so they don't carry the consequence/inverse/health triple — they
// return their own payload directly (the resolved value, the reference set, the
// produced file path). Their result types live with their handlers; this file
// owns only the MUTATING contract, which is the one with the discipline rule.
