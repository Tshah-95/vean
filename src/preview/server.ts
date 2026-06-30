// The local preview SERVER (Move 5, Phase B). A thin Bun HTTP server bound to
// 127.0.0.1 that (a) serves the built viewer (`viewer/dist`) — or reverse-proxies
// a Vite dev server in `--dev` — and (b) exposes READ-only JSON endpoints backed
// by the action runtime / the shared core. It owns NO domain logic: every
// timeline read goes through `resolveTimelineTarget` + the IR parser, and the
// proxy-render goes through `src/preview/proxy.ts`. This is allowed local
// coordination (127.0.0.1 only, like the future Tauri IPC) — the canonical
// timeline state stays file-based; the server is a read adapter + a static host.
//
// Endpoints (all 127.0.0.1; JSON except the streamed media):
//   GET  /api/health                      → { ok, version, repo, timeline? }
//   GET  /api/timelines                   → { timelines: [...] }
//   GET  /api/timeline?route=timeline:main→ parsed IR + { resolvedPath, fps, totalFrames }
//   GET  /api/diagnostics?route=…         → { health, diagnostics }
//   POST /api/proxy-render {route,scale?} → { ok, proxyUrl, fps, totalFrames, width, height, cached }
//   GET  /api/proxy/:key.mp4              → streams the cached proxy (Range-capable)
//   GET  /api/overlay/:key.mov            → streams a Remotion overlay clip (Range-capable)
//
// WRITE-BACK (the edit loop; in-memory, no disk write until /api/save):
//   POST /api/apply-op {route,op,args}    → applies the op to the route's working IR
//                                           { ok, ir, consequences, diagnostics, health,
//                                             canUndo, canRedo, dirty } | { ok:false, … }
//   POST /api/undo {route}                → pops + applies the top inverse (same shape)
//   POST /api/redo {route}                → re-applies the top undone op (same shape)
//   POST /api/save {route}                → serializes the working IR to the .mlt
//                                           { ok, path } | { ok:false, … }
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { collectDiagnostics, summarize } from "../diagnostics";
import { VERSION } from "../index";
import { fromMlt } from "../ir/parse";
import type { OpInvocation } from "../ops";
import { listKnownProjects, resolveProject } from "../project/context";
import type { ResolvedProject } from "../project/context";
import { remotionCacheDir } from "../state/remotionCache";
import { resolveTimelineTarget } from "../state/timeline";
import { listTimelines } from "../state/timeline";
import { buildFootageProxy, proxyCacheDir, totalFrames } from "./proxy";
import {
  SessionStore,
  applyOp,
  markSaved,
  redoSession,
  serializeSession,
  undoSession,
} from "./session";
import type { TimelineSession } from "./session";

export type PreviewServerOptions = {
  repo: string;
  /** The default timeline route the viewer loads (default timeline:main). */
  timeline?: string;
  port: number;
  /** Serve the Vite dev server (reverse-proxied) instead of viewer/dist. */
  dev?: boolean;
  /** Repo root holding the viewer/ workspace (default: the vean repo root). */
  veanRoot?: string;
};

export type PreviewServerHandle = {
  url: string;
  port: number;
  stop: () => void;
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** The vean repo root (two levels up from `src/preview/`). */
function veanRepoRoot(): string {
  return resolve(new URL("../..", import.meta.url).pathname);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function projectFor(repo: string): ResolvedProject {
  return (
    resolveProject({ project: repo, cwd: repo, env: process.env }) ?? {
      rootPath: repo,
      source: "explicit",
      stateDbPath: "",
    }
  );
}

/** Serve a file from disk with a Range-capable streamed body (so `<video>` can
 *  seek). Returns 404 if the file is missing or escapes `baseDir`. */
function serveFile(filePath: string, baseDir: string, req: Request): Response {
  const resolved = resolve(filePath);
  // Path-traversal guard: the resolved path must stay under baseDir.
  if (!resolved.startsWith(resolve(baseDir))) {
    return new Response("forbidden", { status: 403 });
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return new Response("not found", { status: 404 });
  }
  const file = Bun.file(resolved);
  const size = statSync(resolved).size;
  const type =
    CONTENT_TYPES[extname(resolved).toLowerCase()] ?? file.type ?? "application/octet-stream";

  const range = req.headers.get("range");
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : size - 1;
      if (start <= end && end < size) {
        return new Response(file.slice(start, end + 1), {
          status: 206,
          headers: {
            "content-type": type,
            "content-range": `bytes ${start}-${end}/${size}`,
            "accept-ranges": "bytes",
            "content-length": String(end - start + 1),
          },
        });
      }
    }
  }
  return new Response(file, {
    headers: { "content-type": type, "accept-ranges": "bytes", "content-length": String(size) },
  });
}

/** Read a timeline route to its parsed IR + frame/fps metadata, or a typed error
 *  response. Shared by /api/timeline and /api/proxy-render. */
function readTimeline(
  repo: string,
  route: string | undefined,
): { resolvedPath: string; timeline: ReturnType<typeof fromMlt> } | { error: Response } {
  const project = projectFor(repo);
  const resolved = resolveTimelineTarget(repo, project, route);
  if ("ok" in resolved) {
    return { error: jsonResponse(resolved, 404) };
  }
  let xml: string;
  try {
    xml = readFileSync(resolved.resolvedPath, "utf8");
  } catch (error) {
    return {
      error: jsonResponse(
        { ok: false, kind: "read", detail: String((error as Error)?.message ?? error) },
        500,
      ),
    };
  }
  return { resolvedPath: resolved.resolvedPath, timeline: fromMlt(xml) };
}

/** Resolve a route to its live in-memory `TimelineSession`, lazy-loading + parsing
 *  the `.mlt` from disk on first touch. The session is keyed by the RESOLVED path
 *  inside the store, so two aliases for the same file share one working copy +
 *  history. Returns a typed error Response on an unresolvable route or a read/parse
 *  failure (so a malformed document is a 500, not a throw). */
function getSession(
  store: SessionStore,
  repo: string,
  route: string | undefined,
): { session: TimelineSession } | { error: Response } {
  const project = projectFor(repo);
  const resolved = resolveTimelineTarget(repo, project, route);
  if ("ok" in resolved) {
    return { error: jsonResponse(resolved, 404) };
  }
  try {
    const session = store.get(resolved.resolvedPath, (uri) => readFileSync(uri, "utf8"));
    return { session };
  } catch (error) {
    return {
      error: jsonResponse(
        { ok: false, kind: "parse", detail: String((error as Error)?.message ?? error) },
        500,
      ),
    };
  }
}

/** Build the request handler. Split out (and exported) so a test can drive it
 *  directly without binding a port, and so `Bun.serve` just wraps it. */
export function createPreviewHandler(
  opts: PreviewServerOptions,
): (req: Request) => Promise<Response> {
  const repo = opts.repo;
  const veanRoot = opts.veanRoot ?? veanRepoRoot();
  const distDir = join(veanRoot, "viewer", "dist");
  const defaultRoute = opts.timeline;
  // One working-copy store per server instance: holds each route's in-memory IR +
  // undo/redo history across requests for the lifetime of this preview process.
  const sessions = new SessionStore();

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // ── API ──────────────────────────────────────────────────────────────
    if (path === "/api/health") {
      return jsonResponse({
        ok: true,
        version: VERSION,
        repo,
        defaultRoute: defaultRoute ?? "timeline:main",
      });
    }

    if (path === "/api/timelines") {
      const project = projectFor(repo);
      return jsonResponse({ ok: true, timelines: listTimelines(repo, project) });
    }

    // Cross-project picker: the known projects (from ~/.vean/projects.json) with
    // each one's resolved timeline:main path, so the viewer can switch projects.
    // Any project's timeline serves by absolute path regardless of which project
    // this server was launched for (resolveTimelineTarget accepts absolute .mlt).
    if (path === "/api/projects") {
      const projects = listKnownProjects().map((p) => {
        let timelinePath: string | null = null;
        try {
          const proj = resolveProject({ project: p.rootPath, cwd: p.rootPath, env: process.env });
          if (proj) {
            const resolved = resolveTimelineTarget(p.rootPath, proj, undefined);
            if (!("ok" in resolved)) timelinePath = resolved.resolvedPath;
          }
        } catch {
          /* a project without a usable timeline:main is listed but not switchable */
        }
        return { id: p.id, title: p.title ?? p.rootPath, rootPath: p.rootPath, timelinePath };
      });
      return jsonResponse({ ok: true, projects });
    }

    if (path === "/api/timeline") {
      const route = url.searchParams.get("route") ?? defaultRoute ?? undefined;
      const read = readTimeline(repo, route);
      if ("error" in read) return read.error;
      const { timeline, resolvedPath } = read;
      return jsonResponse({
        ok: true,
        resolvedPath,
        route: route ?? "timeline:main",
        profile: timeline.profile,
        fps: timeline.profile.fps,
        totalFrames: totalFrames(timeline),
        timeline,
      });
    }

    if (path === "/api/diagnostics") {
      const route = url.searchParams.get("route") ?? defaultRoute ?? undefined;
      const read = readTimeline(repo, route);
      if ("error" in read) return read.error;
      const diagnostics = collectDiagnostics(read.timeline);
      return jsonResponse({ ok: true, health: summarize(diagnostics), diagnostics });
    }

    // ── Write-back / undo / redo / save (in-memory working copy) ────────────
    // These mutate the route's in-memory IR ONLY; nothing reaches disk until an
    // explicit POST /api/save. Every mutation routes through the shared-core
    // session helpers (which call the edit algebra + diagnostics engine).
    if (path === "/api/apply-op" && req.method === "POST") {
      let body: { route?: string; op?: string; args?: unknown } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonResponse({ ok: false, kind: "invalid-args", detail: "body must be JSON" }, 400);
      }
      if (typeof body.op !== "string" || body.op.length === 0) {
        return jsonResponse({ ok: false, kind: "invalid-args", detail: "op is required" }, 400);
      }
      // The args schema is per-op and validated inside `apply`; pass them through.
      const invocation: OpInvocation = { op: body.op, args: body.args ?? {} };
      const route = body.route ?? defaultRoute ?? undefined;
      const got = getSession(sessions, repo, route);
      if ("error" in got) return got.error;
      const outcome = applyOp(got.session, invocation);
      return jsonResponse(outcome, outcome.ok ? 200 : 422);
    }

    if (path === "/api/undo" && req.method === "POST") {
      let body: { route?: string } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        // empty body is fine — fall back to the default route
      }
      const route = body.route ?? defaultRoute ?? undefined;
      const got = getSession(sessions, repo, route);
      if ("error" in got) return got.error;
      const outcome = undoSession(got.session);
      return jsonResponse(outcome, outcome.ok ? 200 : 422);
    }

    if (path === "/api/redo" && req.method === "POST") {
      let body: { route?: string } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        // empty body is fine — fall back to the default route
      }
      const route = body.route ?? defaultRoute ?? undefined;
      const got = getSession(sessions, repo, route);
      if ("error" in got) return got.error;
      const outcome = redoSession(got.session);
      return jsonResponse(outcome, outcome.ok ? 200 : 422);
    }

    if (path === "/api/save" && req.method === "POST") {
      let body: { route?: string } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        // empty body is fine — fall back to the default route
      }
      const route = body.route ?? defaultRoute ?? undefined;
      const got = getSession(sessions, repo, route);
      if ("error" in got) return got.error;
      const { session } = got;
      try {
        // Deterministic serialize (toMlt) → byte-identical golden output. The
        // session is the single I/O point; write the serialized bytes here.
        writeFileSync(session.uri, serializeSession(session), "utf8");
        markSaved(session);
        return jsonResponse({ ok: true, path: session.uri });
      } catch (error) {
        return jsonResponse(
          { ok: false, kind: "write", detail: String((error as Error)?.message ?? error) },
          500,
        );
      }
    }

    if (path === "/api/proxy-render" && req.method === "POST") {
      let body: { route?: string; scale?: number; force?: boolean } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        // empty body is fine — use defaults
      }
      const route = body.route ?? defaultRoute ?? undefined;
      const read = readTimeline(repo, route);
      if ("error" in read) return read.error;
      try {
        const result = await buildFootageProxy(repo, read.resolvedPath, {
          ...(body.scale != null ? { scale: body.scale } : {}),
          ...(body.force != null ? { force: body.force } : {}),
        });
        const key =
          result.proxyPath
            .split("/")
            .pop()
            ?.replace(/\.mp4$/, "") ?? "";
        return jsonResponse({
          ok: true,
          proxyUrl: `/api/proxy/${key}.mp4`,
          fps: result.fps,
          totalFrames: result.totalFrames,
          width: result.width,
          height: result.height,
          cached: result.cached,
        });
      } catch (error) {
        return jsonResponse(
          { ok: false, kind: "proxy-render", detail: String((error as Error)?.message ?? error) },
          500,
        );
      }
    }

    if (path.startsWith("/api/proxy/")) {
      const name = decodeURIComponent(path.slice("/api/proxy/".length));
      const dir = proxyCacheDir(repo);
      return serveFile(join(dir, name), dir, req);
    }

    if (path.startsWith("/api/overlay/")) {
      const name = decodeURIComponent(path.slice("/api/overlay/".length));
      const dir = remotionCacheDir(repo);
      return serveFile(join(dir, name), dir, req);
    }

    if (path.startsWith("/api/")) {
      return jsonResponse(
        { ok: false, kind: "not-found", detail: `no such endpoint: ${path}` },
        404,
      );
    }

    // ── Static (the built viewer) or Vite dev proxy ────────────────────────
    if (opts.dev) {
      // Reverse-proxy non-/api routes to the Vite dev server on port+1.
      const viteUrl = `http://127.0.0.1:${opts.port + 1}${path}${url.search}`;
      try {
        const proxied = await fetch(viteUrl, {
          method: req.method,
          headers: req.headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        });
        return new Response(proxied.body, { status: proxied.status, headers: proxied.headers });
      } catch {
        return new Response(
          `Vite dev server not reachable on 127.0.0.1:${opts.port + 1}. Run \`bun run viewer:dev\` in another terminal, or omit --dev to serve viewer/dist.`,
          { status: 502 },
        );
      }
    }

    // Serve viewer/dist with SPA fallback to index.html.
    if (!existsSync(distDir)) {
      return new Response(
        `viewer/dist not found at ${distDir}.\nBuild it first: \`bun run viewer:build\` (or run \`vean preview --dev\` against the Vite dev server).`,
        { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    const candidate = path === "/" ? join(distDir, "index.html") : join(distDir, path);
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return serveFile(candidate, distDir, req);
    }
    // SPA fallback.
    return serveFile(join(distDir, "index.html"), distDir, req);
  };
}

/** Start the preview server on 127.0.0.1:port. Returns a handle with the URL and
 *  a `stop()`. The caller (the `preview.serve` action) keeps the process alive. */
export function startPreviewServer(opts: PreviewServerOptions): PreviewServerHandle {
  const handle = createPreviewHandler(opts);
  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    fetch: handle,
    // Long renders: don't time out the proxy-render request.
    idleTimeout: 0,
  });
  const boundPort = server.port ?? opts.port;
  return {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    stop: () => server.stop(true),
  };
}
