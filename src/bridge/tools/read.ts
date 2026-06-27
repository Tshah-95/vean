// The vean READ/RENDER TOOL CORE — the transport-free implementation of the
// NON-mutating domain tools: the two navigation queries (resolve-value-at-frame,
// find-references) and the two driver inspect verbs (render, still).
//
// Split from the MUTATING core (`./core`, which owns apply-op / undo / preview and
// the compact-health discipline) for the same transport-free reason the LSP engine
// is split from its server: these are pure (resolve/refs) or driver-delegating
// (render/still) functions that CALL THE SHARED CORE — the navigation queries
// (src/query) and the melt driver (src/driver) — and the MCP server / CLI just
// JSON-marshal them. They own NO rule and NO edit logic.
//
// Why a distinct result shape from the mutating ToolResult (`./types`): a read
// tool changes nothing, so it carries no `consequences` / `inverse` / health DELTA
// — that triple is meaningless for a query. Instead each read tool returns its own
// payload directly (the resolved value, the reference set, the produced artifact
// path). The one field a read tool DOES share with the mutating contract is
// `touchedUris`: render/still PRODUCE a file (an mp4 / a png), and the agent's
// whole reason to call them is to then INSPECT that artifact — so the tool reports
// the produced path in `touchedUris`, exactly the way a mutating tool reports the
// document it changed. (The .mlt SOURCE is read-only here; the URI that gets
// "touched" is the new artifact on disk, which is what the agent reads next.)
import { type RenderOpts, render, still } from "../../driver/melt";
import type { Timeline } from "../../ir/types";
import {
  type ReferenceQuery,
  type ReferenceResult,
  type ResolveResult,
  type ResolveTarget,
  findReferences,
  resolveValueAtFrame,
} from "../../query";

// ─── Read-tool result shapes ──────────────────────────────────────────────────
/** A pure-query read tool's result: `ok` + the typed query payload. No mutation,
 *  so no consequences/inverse/health — the discipline triple is only for edits. A
 *  thin, honest wrapper: the agent gets the same structured answer the shared query
 *  computes, flagged with `ok` so the MCP envelope is uniform across the tool set. */
export type ReadResult<T> = {
  ok: true;
  /** The shared query's typed answer (a ResolveResult or a ReferenceResult). */
  result: T;
};

/** A render/still tool's result: where the artifact landed (`outPath`) AND the
 *  same path surfaced in `touchedUris` — the artifact the agent inspects next.
 *
 *  `touchedUris` is the load-bearing field (the assignment's explicit requirement):
 *  render/still are the agent's EYES — it calls them to put a frame on disk and
 *  then reads that PNG/MP4. Reporting the produced path in `touchedUris` mirrors
 *  how a mutating tool reports the document it changed, so a host (or the agent)
 *  has one uniform "here is the file to look at next" field across every tool. */
export type RenderToolResult = {
  ok: true;
  /** The kind of artifact produced (an agent can branch on it). */
  kind: "render" | "still";
  /** Absolute/relative path to the produced file (mirrors the driver's outPath). */
  outPath: string;
  /** The produced artifact, as the URI(s) the agent should READ next — the
   *  perceptual-inspection surface. For `still`, the single PNG; for `render`, the
   *  single MP4. (A read of the SOURCE .mlt is not a "touch"; the new file is.) */
  touchedUris: string[];
  /** Captured melt stderr (chatty progress; surfaced for debugging a slow/odd
   *  render without re-running). Compact — a single string, not a dump. */
  stderr: string;
};

/** A failed read/render tool: a typed reason, no artifact. Returned (not thrown)
 *  so the agent reads the failure the same way it reads a mutating ToolError. */
export type ReadError = {
  ok: false;
  /** The failure kind (`parse`, `not-found`, `render`, `still`). */
  kind: string;
  /** Human-readable detail (a melt stderr tail, a missing-target message, …). */
  detail: string;
};

export type ReadOutcome<T> = ReadResult<T> | ReadError;
export type RenderOutcome = RenderToolResult | ReadError;

/** Narrow a read/render outcome to the error arm. */
export function isReadError(x: { ok: boolean }): x is ReadError {
  return x.ok === false;
}

// ─── resolve-value-at-frame (query) ───────────────────────────────────────────
/** resolve-value-at-frame: the effective value of a parameter at a TIMELINE frame,
 *  with the resolution path. Pure SHARED query (`query.resolveValueAtFrame`) — no
 *  rule reimplemented. A `notFound` from the query becomes a typed `ReadError` so
 *  the MCP envelope is consistent; otherwise the full ResolveResult is returned. */
export function resolveTool(
  state: Timeline,
  frame: number,
  target: ResolveTarget,
): ReadOutcome<ResolveResult> {
  const result = resolveValueAtFrame(state, target, frame);
  if (result.notFound) {
    return { ok: false, kind: "not-found", detail: result.notFound };
  }
  return { ok: true, result };
}

/** find-references: clips using a source / readers-writers of a property / a clip's
 *  adjacency-ripple set. Pure SHARED query (`query.findReferences`). A clip-query
 *  `notFound` becomes a typed `ReadError`; every other reference set is returned. */
export function referencesTool(
  state: Timeline,
  query: ReferenceQuery,
): ReadOutcome<ReferenceResult> {
  const result = findReferences(state, query);
  if (result.kind === "clip" && result.notFound) {
    return { ok: false, kind: "not-found", detail: result.notFound };
  }
  return { ok: true, result };
}

// ─── render / still (driver, arm's-length melt) ───────────────────────────────
/** render: drive `melt` to produce an MP4 of the whole `.mlt` headless. Returns the
 *  produced path in BOTH `outPath` and `touchedUris` (the artifact to inspect). A
 *  nonzero melt exit (a thrown MeltError) becomes a typed `ReadError` carrying the
 *  stderr — the agent reads the failure, never an uncaught throw. */
export async function renderTool(
  mltPath: string,
  outPath: string,
  opts?: RenderOpts,
): Promise<RenderOutcome> {
  try {
    const r = await render(mltPath, outPath, opts);
    return {
      ok: true,
      kind: "render",
      outPath: r.outPath,
      touchedUris: [r.outPath],
      stderr: r.stderr,
    };
  } catch (err) {
    return { ok: false, kind: "render", detail: errMsg(err) };
  }
}

/** still: drive `melt` to grab ONE exact frame (`frame`, 0-based) of the `.mlt` as
 *  a true PNG — the agent's perceptual-inspection eye. Returns the produced PNG in
 *  BOTH `outPath` and `touchedUris` (so the agent reads it next). A bad frame
 *  (negative/non-integer) or a melt failure becomes a typed `ReadError`. */
export async function stillTool(
  mltPath: string,
  frame: number,
  outPath: string,
): Promise<RenderOutcome> {
  try {
    const r = await still(mltPath, frame, outPath);
    return {
      ok: true,
      kind: "still",
      outPath: r.outPath,
      touchedUris: [r.outPath],
      stderr: r.stderr,
    };
  } catch (err) {
    return { ok: false, kind: "still", detail: errMsg(err) };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
