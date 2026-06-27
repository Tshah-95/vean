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
// The load-bearing rule, implemented HERE in `alertsDelta`: a mutating tool returns
// mutation-local facts (consequences, inverse, touched URIs) and ONLY adds `alerts`
// when this mutation introduced new blocking errors. It NEVER returns a standing
// health snapshot or the full diagnostic set — those belong to the ambient LSP
// (`publishDiagnostics`) and the explicit `diagnose` debug verb.
import { type Diagnostic, collectDiagnostics } from "../../diagnostics";
import type { Timeline } from "../../ir/types";
import { type EditError, type OpInvocation, type OpResult, apply, isEditError } from "../../ops";
import type { ToolOutcome, ToolResult } from "./types";

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

/** Compute the mutation-local alert set from the pre- and post-edit diagnostics:
 *  every post-edit ERROR whose stable key was absent before the edit. Warnings and
 *  pre-existing diagnostics stay out of mutating tool replies; the LSP/diagnose
 *  surfaces own the standing health picture. */
export function alertsDelta(before: Diagnostic[], after: Diagnostic[]): Diagnostic[] {
  const beforeKeys = new Set(before.map(diagKey));
  const seen = new Set<string>();
  const alerts: Diagnostic[] = [];
  for (const d of after) {
    if (d.severity !== "error") continue;
    const k = diagKey(d);
    if (beforeKeys.has(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    alerts.push(d);
  }
  return alerts;
}

// ─── mutate — the shared mutating-tool path ──────────────────────────────────
/** Apply an op invocation to a document's IR and assemble the focused ToolResult.
 *  The single mutating-tool primitive: `apply-op`, `preview-op`, and `undo` all go
 *  through it.
 *
 *  Steps (every one a SHARED-CORE call, none reimplemented):
 *   1. diagnostics BEFORE (shared engine) — the baseline for the new-vs-existing
 *      diff;
 *   2. `apply(invocation, state)` (the edit algebra) — the only mutation path;
 *   3. diagnostics AFTER (shared engine) — the post-edit set;
 *   4. `alertsDelta` — newly introduced blocking errors, if any.
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
  const alerts = alertsDelta(before, after);
  const result: ToolResult = {
    ok: true,
    consequences: applied.consequences,
    inverse: applied.inverse,
    touchedUris: [uri],
    ...(alerts.length > 0 ? { alerts } : {}),
  };
  return { outcome: result, newState: applied.state };
}

/** preview-op: the SAME computation as `mutate` but the new state is DISCARDED —
 *  the agent sees the consequences + inverse + alerts a hypothetical edit WOULD
 *  produce without committing it (Shotcut has no equivalent; this is the "report
 *  before you render" surface). Returns only the outcome. */
export function preview(state: Timeline, invocation: OpInvocation, uri: string): ToolOutcome {
  return mutate(state, invocation, uri).outcome;
}

/** undo: re-apply a prior result's inverse. Sugar over `mutate` with the inverse
 *  invocation — undo is just another edit whose own inverse redoes it, so it gets
 *  the same consequence report + optional alerts + a (redo) inverse for free. */
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
