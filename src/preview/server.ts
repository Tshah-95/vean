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
//   POST /api/action {id,input?,project?}  → the whole action registry over local
//                                            IPC (ActionEnvelope) — every product
//                                            panel is action-backed, no per-feature endpoint
//   POST /api/proxy-render {route,scale?} → { ok, proxyUrl, fps, totalFrames, width, height, cached }
//   POST /api/still {route?,frame}        → renders one frame (render.still) → { ok, stillUrl }
//   POST /api/render {route?}             → renders the full video (render.video) → { ok, videoUrl }
//   GET  /api/render-out/:name            → streams a rendered still/video (Range-capable)
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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { createActionContext, executeAction } from "../actions";
import { collectDiagnostics, summarize } from "../diagnostics";
import { collectProbeDiagnostics } from "../driver/probeDiagnostics";
import { VERSION } from "../index";
import { fromMlt } from "../ir/parse";
import type { OpInvocation } from "../ops";
import { listKnownProjects, resolveProject } from "../project/context";
import type { ResolvedProject } from "../project/context";
import { findByOutPath, remotionCacheDir } from "../state/remotionCache";
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
import type { ViteDevHandle } from "./viteDev";

/** Actions that block their caller indefinitely and so must not be invoked through
 *  the synchronous `/api/action` bridge (the viewer is already hosted by a preview
 *  server; `preview.serve` would spin a second one and hang this request). */
const BLOCKING_ACTIONS = new Set<string>(["preview.serve"]);

export type PreviewServerOptions = {
  repo: string;
  /** The default timeline route the viewer loads (default timeline:main). */
  timeline?: string;
  port: number;
  /** Serve the live Vite dev server (reverse-proxied, HMR) — the DEFAULT. When
   *  false, serve the pre-built `viewer/dist` snapshot. `startPreviewServer`
   *  auto-manages a Vite child when this is true (see `vitePort`). */
  dev?: boolean;
  /** The loopback port of the managed Vite dev server to reverse-proxy to. Set by
   *  `startPreviewServer` after it starts Vite; when absent the dev branch falls
   *  back to the `port + 1` / 5175 convention (a hand-started `bun run viewer:dev`). */
  vitePort?: number;
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
  // Source/proxy media the live-preview footage `<video>` streams (Range-served).
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

/** The vean repo root (two levels up from `src/preview/`). */
function veanRepoRoot(): string {
  return resolve(new URL("../..", import.meta.url).pathname);
}

/** Cross-origin isolation headers (DESIGN-LIVE-PREVIEW §8.5). The live-preview
 *  compositor decodes footage with WebCodecs in workers and (for the Tier-2 audio
 *  ring buffer) `SharedArrayBuffer`; both are gated behind `crossOriginIsolated`,
 *  which the browser only grants when the top-level document is served with
 *  `Cross-Origin-Opener-Policy: same-origin` AND `Cross-Origin-Embedder-Policy:
 *  require-corp`. Under COEP `require-corp` every subresource the isolated document
 *  loads (the JS bundle, fonts, the footage/proxy/overlay media streams, the JSON
 *  API) must itself be CORP-compatible or the browser blocks it — which would
 *  silently un-isolate the page. The whole preview origin is 127.0.0.1
 *  same-origin, so stamping `Cross-Origin-Resource-Policy: same-origin` on EVERY
 *  response (HTML, assets, JSON, Range-streamed media) is the correct, complete
 *  policy: the document gets COOP+COEP and every subresource is CORP-allowed.
 *  Applied centrally (see `withCrossOriginIsolation`) so no endpoint can forget it
 *  and drop isolation. These headers are inert for the current `<video>`/proxy
 *  preview; they cost nothing and unblock the compositor that replaces it. */
function applyCrossOriginIsolation(res: Response): Response {
  res.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  res.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  res.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return res;
}

/** Wrap a request handler so every response it returns carries the cross-origin
 *  isolation headers. Centralizing this guarantees `crossOriginIsolated === true`
 *  in the served viewer regardless of which code path produced the Response. */
function withCrossOriginIsolation(
  handler: (req: Request) => Promise<Response>,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => applyCrossOriginIsolation(await handler(req));
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

/** Collect the absolute source-media resource paths a timeline references — every
 *  footage clip's `resource`, across all video + audio tracks. This is the
 *  ALLOWLIST the `/api/media` source-serve endpoint validates against (a request
 *  may only stream a file the live timeline actually points at — never an arbitrary
 *  disk path). `color`/synthetic producers (resource = a hex/named color, not a
 *  file) and Remotion graphic overlays are naturally excluded: a color resource is
 *  not a path on disk, and graphics are drawn by the `@remotion/player` overlay,
 *  not the footage `<video>`. Paths are resolved to absolutes so the membership
 *  check is exact regardless of how the request spelled the path. */
function referencedResources(timeline: ReturnType<typeof fromMlt>): Set<string> {
  const out = new Set<string>();
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const item of track.items) {
      if (item.kind === "clip") out.add(resolve(item.resource));
    }
  }
  return out;
}

/** Enrich the WIRE IR with Remotion-overlay identity recovered from the render
 *  cache index, for clips that don't already carry it. An EXISTING baked overlay
 *  (e.g. retire's `renders/chat.mov`, placed before the `vean:composition`
 *  metadata existed) has no `composition` field in the canonical .mlt; the viewer
 *  recognizes a Remotion overlay only by that field. So this READ-ADAPTER walks
 *  the parsed timeline and, for any clip whose `resource` matches the `outPath` of
 *  a cache entry, attaches `composition: { id, props }` — IN THE RETURNED IR ONLY.
 *  Nothing is written back to disk (the canonical .mlt stays untouched), so the
 *  demo works without editing it. A clip that already carries `composition` is
 *  left alone (don't clobber an authored identity). Resilient by construction:
 *  `findByOutPath` degrades to null on a missing/corrupt index, so an absent cache
 *  simply yields no enrichment and never throws.
 *
 *  Resources are resolved relative to the .mlt's own directory (the same base the
 *  probe/driver layers use for relative clip resources) before comparing, since
 *  the index `outPath` is absolute. */
function enrichWithComposition(
  repo: string,
  resolvedPath: string,
  timeline: ReturnType<typeof fromMlt>,
): void {
  const baseDir = dirname(resolvedPath);
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const item of track.items) {
      if (item.kind !== "clip" || item.composition) continue;
      const abs = resolve(baseDir, item.resource);
      const entry = findByOutPath(repo, abs);
      if (entry) item.composition = { id: entry.compositionId, props: entry.props };
    }
  }
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

  const handle = async function handle(req: Request): Promise<Response> {
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
      // Read-adapter enrichment: recover Remotion-overlay identity for baked
      // overlays placed without `vean:composition` metadata, in the wire IR only.
      enrichWithComposition(repo, resolvedPath, timeline);
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
      const engine = collectDiagnostics(read.timeline);
      // Driver-layer fps/VFR diagnostics need ffprobe (I/O), which the pure engine
      // can't do — collect them here and merge into the set so the viewer badge
      // reflects them. A probe failure (missing ffprobe / unreadable source) must
      // not break the read: degrade to engine-only.
      let probe: typeof engine = [];
      try {
        probe = await collectProbeDiagnostics(read.timeline, {
          baseDir: dirname(read.resolvedPath),
          repo, // honor the project's fps.*Tolerance settings
        });
      } catch {
        probe = [];
      }
      const diagnostics = [...engine, ...probe];
      return jsonResponse({ ok: true, health: summarize(diagnostics), diagnostics });
    }

    // ── Generic action bridge ──────────────────────────────────────────────
    // The whole action registry over local IPC: the same `executeAction` the CLI,
    // MCP, and Tauri app call, projected to the hosted UI so every product panel
    // (media browser, jobs/activity, render/still, project dashboard) is
    // action-backed rather than growing a bespoke endpoint per feature. Body:
    //   POST /api/action { id, input?, project? } → ActionEnvelope (200 always; the
    //                                               envelope's `ok` carries success)
    // Long-blocking server actions are refused (the viewer is ALREADY hosted by a
    // preview server; spinning a second one would hang this request thread).
    if (path === "/api/action" && req.method === "POST") {
      let body: { id?: string; input?: unknown; project?: string } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        return jsonResponse({ ok: false, kind: "invalid-args", detail: "body must be JSON" }, 400);
      }
      if (typeof body.id !== "string" || body.id.length === 0) {
        return jsonResponse({ ok: false, kind: "invalid-args", detail: "id is required" }, 400);
      }
      if (BLOCKING_ACTIONS.has(body.id)) {
        return jsonResponse(
          {
            ok: false,
            actionId: body.id,
            kind: "policy",
            detail: `${body.id} blocks the server; not callable through /api/action`,
          },
          422,
        );
      }
      const ctx = createActionContext({
        cwd: repo,
        surface: "tauri",
        project: body.project ?? repo,
        env: process.env,
      });
      const envelope = await executeAction(body.id, body.input ?? {}, ctx);
      return jsonResponse(envelope);
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

    // ── Live source media (the Tier-0 footage transport) ───────────────────
    // GET /api/media?path=<abs>&route=<r>  → streams a SOURCE clip's media file,
    // Range-capable, so a pooled `<video>` can point at the source the playhead
    // resolves to and seek it by source time (DESIGN-LIVE-PREVIEW §6 Tier 0). This
    // is what replaces the whole-timeline `melt` proxy as the realtime footage
    // source: the browser composites the live IR by seeking per-source `<video>`s,
    // never by re-rendering a file per edit.
    //
    // SECURITY: a request may only stream a file the route's LIVE timeline actually
    // references. We resolve the route's working session IR (the same in-memory
    // copy the preview shows) and require the requested path to be in its
    // referenced-resource allowlist. An arbitrary disk path is a 403 — the endpoint
    // is a footage transport, not a general file server. (The session store is the
    // source of truth so an edit that re-links a clip's resource is honored without
    // a save.)
    if (path === "/api/media") {
      const requested = url.searchParams.get("path");
      if (!requested) {
        return jsonResponse({ ok: false, kind: "invalid-args", detail: "path is required" }, 400);
      }
      const route = url.searchParams.get("route") ?? defaultRoute ?? undefined;
      const got = getSession(sessions, repo, route);
      if ("error" in got) return got.error;
      const allow = referencedResources(got.session.ir);
      const resolved = resolve(requested);
      if (!allow.has(resolved)) {
        return jsonResponse(
          { ok: false, kind: "forbidden", detail: "path is not referenced by this timeline" },
          403,
        );
      }
      // serveFile's baseDir guard wants the served file under baseDir; the source's
      // own directory is the correct base (we've already authorized the exact path).
      return serveFile(resolved, dirname(resolved), req);
    }

    // ── Per-source short-GOP H.264 decode proxy (the LIVE in-browser decode src) ──
    // GET /api/source-proxy?path=<abs>&route=<r>  → builds (once, cached) a small
    // short-GOP H.264 proxy of ONE source file and streams it Range-capable. This is
    // the source the in-browser mediabunny→WebCodecs decoder demuxes (§5, §8.2): the
    // user's footage is HEVC/ProRes, which WebCodecs can't reliably decode, so the
    // realtime decode path consumes an `avc1` proxy that decodes everywhere. The
    // short GOP (`-g 15`) collapses worst-case seek toward a single keyframe.
    //
    // SAME ALLOWLIST as /api/media: a request may only build/stream a proxy for a
    // file the route's LIVE timeline actually references — never an arbitrary disk
    // path. The transcode shells out to `melt` once; subsequent requests hit the
    // content-addressed cache. `melt` here is a one-time prep, NOT in the scrub loop.
    if (path === "/api/source-proxy") {
      const requested = url.searchParams.get("path");
      if (!requested) {
        return jsonResponse({ ok: false, kind: "invalid-args", detail: "path is required" }, 400);
      }
      const route = url.searchParams.get("route") ?? defaultRoute ?? undefined;
      const got = getSession(sessions, repo, route);
      if ("error" in got) return got.error;
      const allow = referencedResources(got.session.ir);
      const resolvedReq = resolve(requested);
      if (!allow.has(resolvedReq)) {
        return jsonResponse(
          { ok: false, kind: "forbidden", detail: "path is not referenced by this timeline" },
          403,
        );
      }
      try {
        const { buildSourceProxy } = await import("./source-proxy");
        // `intra=1` requests an ALL-INTRA H.264 proxy (every frame a keyframe) for
        // scrub-heavy footage — the §8.2 extreme of the short-GOP seek lever. Absent
        // it, the default short GOP (`-g 15`) balances size vs seek for normal play.
        const intra = url.searchParams.get("intra") === "1";
        const result = await buildSourceProxy(repo, resolvedReq, { intra });
        return serveFile(result.proxyPath, dirname(result.proxyPath), req);
      } catch (error) {
        return jsonResponse(
          { ok: false, kind: "source-proxy", detail: String((error as Error)?.message ?? error) },
          500,
        );
      }
    }

    if (path.startsWith("/api/proxy/")) {
      const name = decodeURIComponent(path.slice("/api/proxy/".length));
      const dir = proxyCacheDir(repo);
      return serveFile(join(dir, name), dir, req);
    }

    // ── Render artifacts (still / full video) ───────────────────────────────
    // Both route through the SAME `render.still` / `render.video` actions the CLI
    // uses; the server only picks a cache path, ensures it exists, and serves the
    // produced file (mirroring /api/proxy-render). The artifact lands under the
    // gitignored .vean/cache/render so it never pollutes the project tree.
    if (path === "/api/still" && req.method === "POST") {
      let body: { route?: string; frame?: number } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        // empty body is fine — defaults
      }
      const route = body.route ?? defaultRoute ?? undefined;
      const frame = Number.isInteger(body.frame) ? (body.frame as number) : 0;
      const read = readTimeline(repo, route);
      if ("error" in read) return read.error;
      const dir = join(repo, ".vean", "cache", "render");
      mkdirSync(dir, { recursive: true });
      const name = `still-${frame}.png`;
      const ctx = createActionContext({
        cwd: repo,
        surface: "tauri",
        project: repo,
        env: process.env,
      });
      const envelope = await executeAction(
        "render.still",
        { uri: read.resolvedPath, frame, out: join(dir, name) },
        ctx,
      );
      const result = (envelope.ok ? envelope.output : envelope) as {
        ok?: boolean;
        detail?: string;
      };
      if (!envelope.ok || result?.ok === false) {
        return jsonResponse(
          { ok: false, kind: "still", detail: result?.detail ?? "render failed" },
          500,
        );
      }
      return jsonResponse({ ok: true, stillUrl: `/api/render-out/${name}`, frame });
    }

    if (path === "/api/render" && req.method === "POST") {
      let body: { route?: string } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        // empty body is fine — defaults
      }
      const route = body.route ?? defaultRoute ?? undefined;
      const read = readTimeline(repo, route);
      if ("error" in read) return read.error;
      const dir = join(repo, ".vean", "cache", "render");
      mkdirSync(dir, { recursive: true });
      const name = "render.mp4";
      const ctx = createActionContext({
        cwd: repo,
        surface: "tauri",
        project: repo,
        env: process.env,
      });
      const envelope = await executeAction(
        "render.video",
        { uri: read.resolvedPath, out: join(dir, name) },
        ctx,
      );
      const result = (envelope.ok ? envelope.output : envelope) as {
        ok?: boolean;
        detail?: string;
      };
      if (!envelope.ok || result?.ok === false) {
        return jsonResponse(
          { ok: false, kind: "render", detail: result?.detail ?? "render failed" },
          500,
        );
      }
      return jsonResponse({
        ok: true,
        videoUrl: `/api/render-out/${name}`,
        route: route ?? "timeline:main",
      });
    }

    if (path.startsWith("/api/render-out/")) {
      const name = decodeURIComponent(path.slice("/api/render-out/".length));
      const dir = join(repo, ".vean", "cache", "render");
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

    // ── Live Vite dev server (HMR, the default) or the static dist snapshot ──
    if (opts.dev) {
      // Reverse-proxy non-/api routes to the Vite dev server. `startPreviewServer`
      // starts a managed Vite and passes its port as `opts.vitePort`; if that's
      // absent (a hand-started `bun run viewer:dev`) fall back to the convention:
      // `port + 1` for a fixed --port, else the viewer's configured dev port.
      const vitePort = opts.vitePort ?? (opts.port > 0 ? opts.port + 1 : 5175);
      const viteUrl = `http://127.0.0.1:${vitePort}${path}${url.search}`;
      try {
        const proxied = await fetch(viteUrl, {
          method: req.method,
          headers: req.headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
        });
        return new Response(proxied.body, { status: proxied.status, headers: proxied.headers });
      } catch {
        return new Response(
          `Live viewer (Vite) not reachable on 127.0.0.1:${vitePort}. It is normally auto-started; run \`bun run viewer:dev\` to debug, or pass \`--prod\` to serve the viewer/dist snapshot.`,
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

  // Stamp cross-origin isolation on EVERY response so the served viewer reports
  // `crossOriginIsolated === true` (the gate for WebCodecs-in-workers +
  // SharedArrayBuffer the live-preview compositor needs — DESIGN-LIVE-PREVIEW §8.5).
  return withCrossOriginIsolation(handle);
}

/** Start the preview server on 127.0.0.1:port. Returns a handle with the URL and
 *  a `stop()`. The caller (the `preview.serve` action) keeps the process alive.
 *
 *  In dev mode (the default) this also starts and owns a managed Vite dev server
 *  so the live HMR viewer "just works" with no second terminal — `stop()` tears
 *  down BOTH the HTTP server and Vite. It is async because it waits for Vite to be
 *  ready before binding, so "ready" means the UI is ready, not just the API. */
export async function startPreviewServer(opts: PreviewServerOptions): Promise<PreviewServerHandle> {
  const veanRoot = opts.veanRoot ?? veanRepoRoot();

  // Dev (default): bring up a managed Vite child and proxy to its actual port.
  // Prod (--prod): no Vite — serve the viewer/dist snapshot.
  let vite: ViteDevHandle | null = null;
  if (opts.dev) {
    const { ensureViteDevServer } = await import("./viteDev");
    vite = await ensureViteDevServer({ veanRoot });
  }

  const handle = createPreviewHandler({
    ...opts,
    veanRoot,
    ...(vite ? { vitePort: vite.port } : {}),
  });
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
    stop: () => {
      server.stop(true);
      vite?.stop();
    },
  };
}
