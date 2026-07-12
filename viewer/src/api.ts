// Typed fetch wrappers for the preview server's read + proxy endpoints. The
// server is bound to 127.0.0.1 and serves this very app, so all requests are
// same-origin (relative URLs).
import type {
  ApiError,
  OpInvocation,
  ProxyResponse,
  SaveResult,
  SessionEditResult,
  TimelineResponse,
} from "./types";

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  const body = (await res.json()) as T | ApiError;
  if (!res.ok || (body as ApiError).ok === false) {
    const err = body as ApiError;
    throw new Error(`${err.kind ?? res.status}: ${err.detail ?? res.statusText}`);
  }
  return body as T;
}

export async function fetchHealth(): Promise<{
  ok: true;
  version: string;
  repo: string;
  defaultRoute: string;
}> {
  return getJson("/api/health");
}

export async function fetchTimeline(route?: string): Promise<TimelineResponse> {
  const qs = route ? `?route=${encodeURIComponent(route)}` : "";
  return getJson(`/api/timeline${qs}`);
}

export async function fetchTimelines(): Promise<{
  ok: true;
  timelines: Array<{ path: string; aliases: string[] }>;
}> {
  return getJson("/api/timelines");
}

export interface ProjectEntry {
  id: string;
  title: string;
  rootPath: string;
  timelinePath: string | null;
}

export async function fetchProjects(): Promise<{ ok: true; projects: ProjectEntry[] }> {
  return getJson("/api/projects");
}

export async function fetchDiagnostics(route?: string): Promise<{
  ok: true;
  health: { errors: number; warnings: number } | Record<string, number>;
  diagnostics: unknown[];
}> {
  const qs = route ? `?route=${encodeURIComponent(route)}` : "";
  return getJson(`/api/diagnostics${qs}`);
}

/** Build the same-origin URL the live-preview footage `<video>` streams a SOURCE
 *  clip from (Range-served by `GET /api/media`). `path` is the clip's absolute
 *  `resource`; `route` scopes the server-side allowlist check to the timeline that
 *  references it. This is the Tier-0 footage transport — the browser seeks this
 *  per-source element to the source frame the playhead resolves to, replacing the
 *  whole-timeline `melt` proxy as the realtime footage source. */
export function mediaUrl(path: string, route?: string): string {
  const qs = new URLSearchParams({ path });
  if (route) qs.set("route", route);
  return `/api/media?${qs.toString()}`;
}

export async function renderProxy(
  route?: string,
  scale?: number,
  force?: boolean,
): Promise<ProxyResponse> {
  const res = await fetch("/api/proxy-render", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vean-nonce": crypto.randomUUID() },
    body: JSON.stringify({ route, scale, force }),
  });
  const body = (await res.json()) as ProxyResponse | ApiError;
  if (!res.ok || (body as ApiError).ok === false) {
    const err = body as ApiError;
    throw new Error(`${err.kind ?? res.status}: ${err.detail ?? res.statusText}`);
  }
  return body as ProxyResponse;
}

// ─── Edit loop (in-memory working copy on the server; disk untouched until save) ──

async function postJson<T>(path: string, payload: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vean-nonce": crypto.randomUUID() },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as T | ApiError;
  if (!res.ok || (body as ApiError).ok === false) {
    const err = body as ApiError;
    throw new Error(`${err.kind ?? res.status}: ${err.detail ?? res.statusText}`);
  }
  return body as T;
}

/** Who is editing — the GUI operator (default) or a named agent/session. Tags the
 *  undo entry so a later undo can refuse to cross authorship (mirrors the session
 *  `EditAuthor` / `EditOptions`). */
export interface EditAuthorOpts {
  /** The edit's author. Omitted → the human operator. */
  author?: string;
  /** Permit an undo/redo to cross an authorship boundary (the GUI's explicit
   *  "undo anyway" affordance). Omitted → false (the safe, never-cross default). */
  allowCrossAuthor?: boolean;
}

/** Apply one edit-algebra op to the route's working IR. Returns the new IR +
 *  consequences + the full ambient diagnostic set. `opts.author` tags the undo
 *  entry for the agent-scoped undo boundary. */
export async function applyOp(
  invocation: OpInvocation,
  route?: string,
  opts?: EditAuthorOpts,
): Promise<SessionEditResult> {
  return postJson<SessionEditResult>("/api/apply-op", { route, ...invocation, ...opts });
}

/** Pop + apply the top inverse on the working IR. Refuses to cross authorship
 *  unless `opts.allowCrossAuthor` (returns a `cross-author-undo` error). */
export async function undoEdit(route?: string, opts?: EditAuthorOpts): Promise<SessionEditResult> {
  return postJson<SessionEditResult>("/api/undo", { route, ...opts });
}

/** Re-apply the top undone op on the working IR. */
export async function redoEdit(route?: string, opts?: EditAuthorOpts): Promise<SessionEditResult> {
  return postJson<SessionEditResult>("/api/redo", { route, ...opts });
}

/** Serialize the working IR back to the .mlt on disk. */
export async function saveTimeline(route?: string): Promise<SaveResult> {
  return postJson<SaveResult>("/api/save", { route });
}

// ─── Generic action bridge ───────────────────────────────────────────────────
// Every product panel (media, jobs, render, project) calls registered actions
// through one endpoint rather than a bespoke fetch per feature. The server runs
// the SAME `executeAction` the CLI/MCP/Tauri use; this just returns its `output`.

/** Render one exact frame of the route's timeline to a PNG (via render.still) and
 *  return a server URL for it. */
export async function renderStill(
  frame: number,
  route?: string,
): Promise<{ ok: true; stillUrl: string; frame: number }> {
  return postJson("/api/still", { route, frame });
}

/** Render the route's whole timeline to an MP4 (via render.video) and return a
 *  server URL for it. */
export async function renderVideo(route?: string): Promise<{ ok: true; videoUrl: string }> {
  return postJson("/api/render", { route });
}

/** This checkout's worktree identity — slug, branch, whether it's the canonical
 *  tree, its state DB path, and the live drive session (if any). The read-only
 *  answer to "which version am I looking at?" across concurrent worktrees
 *  (mirrors `worktree.whereami` / DESIGN-WORKTREE §4.5). */
export interface WhereAmI {
  worktreePath: string;
  slug: string;
  branch: string | null;
  isPrimary: boolean;
  source: string;
  stateDbPath: string;
  driveSession: { name: string; url: string; port: number; status: string } | null;
  veanBinResolvesTo: string | null;
  veanBinMatchesCheckout: boolean;
}

/** Fetch this checkout's worktree identity via the `worktree.whereami` action. */
export async function fetchWhereAmI(project?: string): Promise<WhereAmI> {
  return runAction<WhereAmI>("worktree.whereami", {}, project);
}

/** Run any registered vean action through the local action bridge. Returns the
 *  action's typed `output`; throws on a non-ok envelope (validation/policy/exec). */
export async function runAction<T = unknown>(
  id: string,
  input?: unknown,
  project?: string,
): Promise<T> {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "content-type": "application/json", "x-vean-nonce": crypto.randomUUID() },
    body: JSON.stringify({ id, input, project }),
  });
  const env = (await res.json()) as { ok: true; output: T } | ApiError;
  if (!res.ok || (env as ApiError).ok === false) {
    const err = env as ApiError;
    throw new Error(`${err.kind ?? res.status}: ${err.detail ?? res.statusText}`);
  }
  return (env as { ok: true; output: T }).output;
}
