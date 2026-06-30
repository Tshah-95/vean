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

export async function fetchHealth(): Promise<{ ok: true; version: string; repo: string; defaultRoute: string }> {
  return getJson("/api/health");
}

export async function fetchTimeline(route?: string): Promise<TimelineResponse> {
  const qs = route ? `?route=${encodeURIComponent(route)}` : "";
  return getJson(`/api/timeline${qs}`);
}

export async function fetchTimelines(): Promise<{ ok: true; timelines: Array<{ path: string; aliases: string[] }> }> {
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

export async function fetchDiagnostics(
  route?: string,
): Promise<{ ok: true; health: { errors: number; warnings: number } | Record<string, number>; diagnostics: unknown[] }> {
  const qs = route ? `?route=${encodeURIComponent(route)}` : "";
  return getJson(`/api/diagnostics${qs}`);
}

export async function renderProxy(route?: string, scale?: number, force?: boolean): Promise<ProxyResponse> {
  const res = await fetch("/api/proxy-render", {
    method: "POST",
    headers: { "content-type": "application/json" },
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
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as T | ApiError;
  if (!res.ok || (body as ApiError).ok === false) {
    const err = body as ApiError;
    throw new Error(`${err.kind ?? res.status}: ${err.detail ?? res.statusText}`);
  }
  return body as T;
}

/** Apply one edit-algebra op to the route's working IR. Returns the new IR +
 *  consequences + the full ambient diagnostic set. */
export async function applyOp(invocation: OpInvocation, route?: string): Promise<SessionEditResult> {
  return postJson<SessionEditResult>("/api/apply-op", { route, ...invocation });
}

/** Pop + apply the top inverse on the working IR. */
export async function undoEdit(route?: string): Promise<SessionEditResult> {
  return postJson<SessionEditResult>("/api/undo", { route });
}

/** Re-apply the top undone op on the working IR. */
export async function redoEdit(route?: string): Promise<SessionEditResult> {
  return postJson<SessionEditResult>("/api/redo", { route });
}

/** Serialize the working IR back to the .mlt on disk. */
export async function saveTimeline(route?: string): Promise<SaveResult> {
  return postJson<SaveResult>("/api/save", { route });
}

// ─── Generic action bridge ───────────────────────────────────────────────────
// Every product panel (media, jobs, render, project) calls registered actions
// through one endpoint rather than a bespoke fetch per feature. The server runs
// the SAME `executeAction` the CLI/MCP/Tauri use; this just returns its `output`.

/** Run any registered vean action through the local action bridge. Returns the
 *  action's typed `output`; throws on a non-ok envelope (validation/policy/exec). */
export async function runAction<T = unknown>(
  id: string,
  input?: unknown,
  project?: string,
): Promise<T> {
  const res = await fetch("/api/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, input, project }),
  });
  const env = (await res.json()) as { ok: true; output: T } | ApiError;
  if (!res.ok || (env as ApiError).ok === false) {
    const err = env as ApiError;
    throw new Error(`${err.kind ?? res.status}: ${err.detail ?? res.statusText}`);
  }
  return (env as { ok: true; output: T }).output;
}
