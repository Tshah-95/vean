// The MUTATING tool core — the transport-free heart of every vean tool that
// CHANGES the document: `apply-op`, `preview-op`, `undo`. This is the one module
// where tool-output discipline (AGENTS.md "Agent feedback contract", BUILD-MONITOR
// review lens #3) is enforced.
//
// Like the LSP engine, this is split from the transport wiring (`../mcp/server`,
// the CLI scripts): these are PURE functions over the IR that CALL THE SHARED CORE
// — the edit algebra (src/ops, the ONLY mutation path) and the diagnostics engine
// (src/diagnostics, the ONLY rule source) — and assemble the `ToolResult` contract.
// No JSON-RPC, no stdio, no file I/O lives here; the bindings marshal these.
//
// The load-bearing rule, implemented HERE in `healthDelta`: a mutating tool returns
// the consequence report + the inverse + the touched URIs + a COMPACT health
// summary (the NEW-or-BLOCKING diagnostics only, computed by diffing the shared
// engine's pre- and post-edit sets). It NEVER returns the full diagnostic set —
// that is the ambient LSP's job (`publishDiagnostics`) and the explicit `diagnose`
// debug verb's job (which lives, deliberately apart from the mutators, in `core.ts`).
// Returning the full set on every edit is the explicit escalation trigger ("tool
// responses include full diagnostic dumps by default").
import { type Diagnostic, collectDiagnostics, summarize } from "../../diagnostics";
import type { Timeline } from "../../ir/types";
import { type EditError, type OpInvocation, type OpResult, apply, isEditError } from "../../ops";
import type { ToolHealth, ToolOutcome, ToolResult } from "./types";

// ─── Diagnostic identity (for the new-vs-existing diff) ──────────────────────
/** A diagnostic's identity for delta computation: its stable code + the stable
 *  identity of where it fires. Two diagnostics with the same key are "the same
 *  problem"; a key present after the edit but not before is NEW. Identity is by
 *  STABLE location (clip uuid, track id, transition/filter index, a frame range) —
 *  never an ephemeral array index — so the diff survives an edit that reorders the
 *  set (the core invariant: identity = stable uuids, not indices). */
function diagKey(d: Diagnostic): string {
  const l = d.location;
  return [
    d.code,
    l.clip ?? "",
    l.track ?? "",
    l.transition ?? "",
    l.filter ?? "",
    l.range ? `${l.range.from}-${l.range.to}` : "",
  ].join("|");
}

/** Compute the COMPACT health from the pre- and post-edit diagnostic sets. The
 *  detail list (`newOrBlocking`) is: every post-edit diagnostic whose key was NOT
 *  in the pre-edit set (introduced by this edit) PLUS every post-edit ERROR
 *  (blocking — surfaced even if pre-existing, because it blocks a faithful
 *  render). Counts come from the shared `summarize`. This is the ONLY place full
 *  Diagnostic objects enter a tool result, and only for the ones that are news. A
 *  pre-existing WARNING the edit didn't touch is COUNTED but omitted from the
 *  detail list — it's ambient context the LSP already showed, not news. */
export function healthDelta(before: Diagnostic[], after: Diagnostic[]): ToolHealth {
  const beforeKeys = new Set(before.map(diagKey));
  const seen = new Set<string>();
  const newOrBlocking: Diagnostic[] = [];
  for (const d of after) {
    const isNew = !beforeKeys.has(diagKey(d));
    const isBlocking = d.severity === "error";
    if (!isNew && !isBlocking) continue;
    // De-dupe (a new error is both new and blocking — list it once).
    const k = diagKey(d);
    if (seen.has(k)) continue;
    seen.add(k);
    newOrBlocking.push(d);
  }
  const s = summarize(after);
  return { errors: s.errors, warnings: s.warnings, clean: s.clean, newOrBlocking };
}

// ─── mutate — the shared mutating-tool path ──────────────────────────────────
/** Apply an op invocation to a document's IR and assemble the compact ToolResult.
 *  The single mutating-tool primitive: `apply-op`, `preview-op`, and `undo` all go
 *  through it.
 *
 *  Steps (every one a SHARED-CORE call, none reimplemented):
 *   1. diagnostics BEFORE (shared engine) — the baseline for the new-vs-existing
 *      diff;
 *   2. `apply(invocation, state)` (the edit algebra) — the only mutation path;
 *   3. diagnostics AFTER (shared engine) — the post-edit set;
 *   4. `healthDelta` — the compact new-or-blocking summary.
 *
 *  Returns the new state alongside the ToolResult so a stateful caller (the MCP
 *  server, a CLI script, a future session) can advance its document; the binding
 *  persists `newState` and returns the `result`. A precondition failure is a typed
 *  `ToolError` value, never a throw (contract law #5, surfaced through the tool). */
export function mutate(
  state: Timeline,
  invocation: OpInvocation,
  uri: string,
): { outcome: ToolOutcome; newState?: Timeline } {
  const before = collectDiagnostics(state);
  const applied: OpResult | EditError = apply(invocation, state);
  if (isEditError(applied)) {
    return { outcome: editErrorToTool(applied) };
  }
  const after = collectDiagnostics(applied.state);
  const result: ToolResult = {
    ok: true,
    consequences: applied.consequences,
    inverse: applied.inverse,
    touchedUris: [uri],
    health: healthDelta(before, after),
  };
  return { outcome: result, newState: applied.state };
}

/** preview-op: the SAME computation as `mutate` but the new state is DISCARDED —
 *  the agent sees the consequences + inverse + health a hypothetical edit WOULD
 *  produce without committing it (Shotcut has no equivalent; this is the "report
 *  before you render" surface). Returns only the outcome. */
export function preview(state: Timeline, invocation: OpInvocation, uri: string): ToolOutcome {
  return mutate(state, invocation, uri).outcome;
}

/** undo: re-apply a prior result's inverse. Sugar over `mutate` with the inverse
 *  invocation — undo is just another edit whose own inverse redoes it, so it gets
 *  the same consequence report + compact health + a (redo) inverse for free. */
export function undoTool(
  state: Timeline,
  inverse: OpInvocation,
  uri: string,
): { outcome: ToolOutcome; newState?: Timeline } {
  return mutate(state, inverse, uri);
}

// ─── Typed-error mapping (EditError → ToolError, never a throw) ───────────────
function editErrorToTool(e: EditError): ToolOutcome {
  return { ok: false, kind: e.kind, detail: editErrorDetail(e) };
}

/** Render an `EditError` to a human-readable detail string, branching on its
 *  typed `kind`. The MCP/CLI binding shows this verbatim, so the agent sees the
 *  precondition the same way the edit algebra reports it. */
export function editErrorDetail(e: EditError): string {
  switch (e.kind) {
    case "clip-not-found":
      return `clip not found: ${e.uuid}`;
    case "track-not-found":
      return `track not found: ${e.track}`;
    case "frame-out-of-range":
      return `frame ${e.frame} out of range (bound ${e.bound}): ${e.detail}`;
    case "dissolve-too-long":
      return `dissolve ${e.frames}f exceeds the ${e.side} neighbour (${e.neighbour}f)`;
    case "split-at-boundary":
      return `cannot split at frame ${e.frame}: ${e.detail}`;
    case "invalid-args":
      return e.detail;
    default:
      return e.detail;
  }
}
