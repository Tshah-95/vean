// Typed fetch wrappers for the preview server's read + proxy endpoints. The
// server is bound to 127.0.0.1 and serves this very app, so all requests are
// same-origin (relative URLs).
import type { ApiError, ProxyResponse, TimelineResponse } from "./types";

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
