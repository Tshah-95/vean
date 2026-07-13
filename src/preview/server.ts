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
//   GET  /api/timeline?route=timeline:main→ parsed IR + { resolvedPath, fps, totalFrames };
//                                            each footage clip is enriched with
//                                            audioStreams/hasAudio from the ffprobe probe
//   GET  /api/diagnostics?route=…         → { health, diagnostics }
//   GET  /api/peaks?path=&route=&bins=    → { sampleRate, binFrames, bins, peaks:[min,max…] }
//                                            downsampled audio waveform (ffmpeg, cached)
//   GET  /api/transcript?route=&clipId=   → { words:[…], transcript } for the clip's source,
//     (or &path=)                           or { words:[], transcript:null } when none exists
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
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { createActionContext, executeAction } from "../actions";
import { collectDiagnostics, summarize } from "../diagnostics";
import { probeSource } from "../driver/probe";
import { collectProbeDiagnostics } from "../driver/probeDiagnostics";
import { VERSION } from "../index";
import { fromMlt } from "../ir/parse";
import { hasAudio as clipDecodesAudio } from "../ir/types";
import type { OpInvocation } from "../ops";
import { listKnownProjects, resolveProject } from "../project/context";
import type { ResolvedProject } from "../project/context";
import { transcriptFromJobs } from "../query/transcript-read";
import { runtimeResourceRoot } from "../runtime/layout";
import { TRANSCRIBE_JOB_KIND } from "../state/job-types";
import { listJobsByKind } from "../state/jobs";
import { listMediaRoots } from "../state/media";
import { findByOutPath, remotionCacheDir } from "../state/remotionCache";
import { resolveTimelineTarget } from "../state/timeline";
import { listTimelines } from "../state/timeline";
import { extractPeaks } from "./peaks";
import { buildFootageProxy, proxyCacheDir, totalFrames } from "./proxy";
import {
  MUTATION_PATHS,
  type MutationAuthority,
  type PreviewPolicyProfile,
  applyPreviewPolicy,
  authorizeMutation,
  createNonceConsumer,
} from "./security";
import {
  SessionStore,
  applyOp,
  markSaved,
  redoSession,
  serializeSession,
  undoSession,
} from "./session";
import type { EditOptions, TimelineSession } from "./session";
import type { ViteDevHandle } from "./viteDev";

/** Actions that block their caller indefinitely and so must not be invoked through
 *  the synchronous `/api/action` bridge (the viewer is already hosted by a preview
 *  server; `preview.serve` would spin a second one and hang this request). */
const BLOCKING_ACTIONS = new Set<string>(["preview.serve"]);

/** Project the optional `author` / `allowCrossAuthor` fields of an edit request body
 *  onto the session {@link EditOptions}. A request with neither field falls back to
 *  the human author with a private (never-crossed) undo stack — the existing GUI
 *  behavior — so this is a backward-compatible add. */
function editAuthorOpts(body: { author?: string; allowCrossAuthor?: boolean }): EditOptions {
  const opts: EditOptions = {};
  if (typeof body.author === "string" && body.author.length > 0) opts.author = body.author;
  if (body.allowCrossAuthor === true) opts.allowCrossAuthor = true;
  return opts;
}

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
  /** Launch-scoped authority for mutating routes. Omitted only by legacy/read-only
   * callers; release/test launchers must supply it. The secret is never serialized. */
  mutationAuthority?: MutationAuthority;
  policyProfile?: PreviewPolicyProfile;
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
  const packagedViewer = runtimeResourceRoot("viewer");
  return packagedViewer
    ? resolve(packagedViewer, "..")
    : resolve(new URL("../..", import.meta.url).pathname);
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
  profile: PreviewPolicyProfile,
  authority?: MutationAuthority,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    const response = applyPreviewPolicy(applyCrossOriginIsolation(await handler(req)), profile);
    if (authority && req.method === "GET" && new URL(req.url).pathname === "/") {
      response.headers.set(
        "Set-Cookie",
        `vean-authority=${authority.token}; Path=/; HttpOnly; SameSite=Strict`,
      );
    }
    return response;
  };
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

/** Is `resolved` inside one of the project's registered MEDIA ROOTS? The media
 *  transport serves the project BIN (imported-but-not-yet-placed media — the
 *  Media panel's tiles + the source monitor), not just timeline-referenced
 *  resources. Roots are registered state (`vean media root add`), so this stays
 *  an allow-list — never arbitrary disk. */
function underMediaRoot(repo: string, resolved: string): boolean {
  try {
    for (const root of listMediaRoots(repo)) {
      const base = resolve(root.path);
      if (resolved === base || resolved.startsWith(`${base}/`)) return true;
    }
  } catch {
    // No state DB / no roots — fall through to "not allowed".
  }
  return false;
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

/** True iff a clip `resource` is a real media FILE (not a `color`/synthetic
 *  producer, whose resource is a hex/named color). Peaks/transcript/audioStreams
 *  are file facts, so color producers are skipped (they have no source on disk). */
function isFileResource(item: { kind: string; resource?: string; service?: string }): boolean {
  if (item.kind !== "clip" || !item.resource) return false;
  if (item.service === "color") return false;
  // A color spec is a hex (#RRGGBB / #AARRGGBB) or a bare color word/number — never
  // a path. Anything with a path separator or a media extension is a file.
  if (/^#[0-9a-fA-F]+$/.test(item.resource)) return false;
  return true;
}

/** Find a clip by stable id across all tracks and return it plus its absolute
 *  resource path (resolved relative to the .mlt's own directory, mirroring
 *  `enrichWithComposition`). Returns null when the id is unknown or the clip is a
 *  synthetic (non-file) producer. Shared by /api/peaks and /api/transcript so both
 *  address a clip by id the same way. */
function findClipSource(
  resolvedPath: string,
  timeline: ReturnType<typeof fromMlt>,
  clipId: string,
): { absResource: string } | null {
  const baseDir = dirname(resolvedPath);
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const item of track.items) {
      if (item.kind !== "clip" || item.id !== clipId) continue;
      if (!isFileResource(item)) return null;
      return { absResource: resolve(baseDir, item.resource) };
    }
  }
  return null;
}

/** The set of absolute source paths a document references, resolved against the
 *  .mlt's OWN directory (the correct base for a root-relative clip resource — the
 *  same base `enrichWithComposition`/`findClipSource` use). This is the allowlist
 *  the peaks/transcript endpoints validate a `path=` request against; unlike the
 *  cwd-relative `referencedResources`, it authorizes a relative resource by its
 *  true on-disk path, not `<cwd>/<resource>`. An absolute resource resolves to
 *  itself under either base, so this is a strict superset that never authorizes
 *  anything the timeline doesn't point at. */
function referencedResourcesForDoc(
  resolvedPath: string,
  timeline: ReturnType<typeof fromMlt>,
): Set<string> {
  const baseDir = dirname(resolvedPath);
  const out = new Set<string>();
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const item of track.items) {
      if (item.kind === "clip") out.add(resolve(baseDir, item.resource));
    }
  }
  return out;
}

/** The wire-only audio facts we surface per clip on `/api/timeline`: the source's
 *  audio-stream count and a derived `hasAudio` boolean. Sourced from the ffprobe
 *  probe (`src/driver/probe.ts`), the SAME fact the media catalog persists. Absent
 *  probe (missing file / ffprobe / no streams) ⇒ the fields are OMITTED — never
 *  guessed. This mutates only the parsed wire IR the endpoint returns; it never
 *  touches the canonical .mlt or the IR schema (determinism is unaffected — the
 *  serializer never sees these fields). */
async function enrichWithAudioStreams(
  resolvedPath: string,
  timeline: ReturnType<typeof fromMlt>,
): Promise<void> {
  const baseDir = dirname(resolvedPath);
  // Probe each DISTINCT source once (probeSource is in-process cached, but dedupe
  // the await fan-out too so a timeline reusing one source doesn't spawn N probes).
  const byPath = new Map<string, Promise<number | null>>();
  const probeAudio = (abs: string): Promise<number | null> => {
    let p = byPath.get(abs);
    if (!p) {
      p = probeSource(abs).then((probe) => probe?.audioStreams ?? null);
      byPath.set(abs, p);
    }
    return p;
  };
  const pending: Promise<void>[] = [];
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const item of track.items) {
      if (item.kind !== "clip" || !isFileResource(item)) continue;
      const clip = item as typeof item & { audioStreams?: number; hasAudio?: boolean };
      const abs = resolve(baseDir, clip.resource);
      pending.push(
        probeAudio(abs).then((count) => {
          // Absent probe (null) ⇒ omit both fields; present ⇒ surface the count +
          // the derived boolean (≥1 stream = carries audio).
          if (count == null) return;
          clip.audioStreams = count;
          clip.hasAudio = count > 0 && clipDecodesAudio(item);
        }),
      );
    }
  }
  await Promise.all(pending);
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
  sessions: SessionStore = new SessionStore(),
): (req: Request) => Promise<Response> {
  const repo = opts.repo;
  const veanRoot = opts.veanRoot ?? veanRepoRoot();
  const distDir = join(veanRoot, "viewer", "dist");
  const defaultRoute = opts.timeline;
  // The working-copy store (route → in-memory IR + undo/redo history). INJECTABLE so
  // the `bun --hot` dev server passes a store backed by a globalThis-held map whose
  // working state survives a reload while this handler is rebuilt with freshly-
  // evaluated op code. A fresh store per instance otherwise (tests, prod, detached).

  const handle = async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === "POST" && MUTATION_PATHS.has(path) && opts.mutationAuthority) {
      const authorized = authorizeMutation(req, opts.mutationAuthority);
      if (!authorized.ok) {
        // Deliberately uniform: no route, credential, or parser detail is exposed.
        return jsonResponse(
          { ok: false, kind: "unauthorized", detail: "mutation authority required" },
          403,
        );
      }
    }

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
      // Surface each footage clip's source audio-stream count + a derived hasAudio
      // (from the ffprobe probe) on the wire IR — the timeline's linked-audio lane
      // needs to know which clips carry embedded audio. Wire-only; the .mlt and the
      // IR schema are untouched. A probe failure degrades to omitting the fields (a
      // clip without a probe simply carries no audioStreams), never blocking the read.
      try {
        await enrichWithAudioStreams(resolvedPath, timeline);
      } catch {
        // ffprobe unavailable / unreadable source → no audio facts, still serve.
      }
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
      let body: { route?: string; op?: string; args?: unknown; author?: string } = {};
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
      // `author` tags the undo entry so a later undo can refuse to cross authorship
      // (the GUI omits it → the human author; an agent passes its session id).
      const outcome = applyOp(got.session, invocation, editAuthorOpts(body));
      return jsonResponse(outcome, outcome.ok ? 200 : 422);
    }

    if (path === "/api/undo" && req.method === "POST") {
      let body: { route?: string; author?: string; allowCrossAuthor?: boolean } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        // empty body is fine — fall back to the default route
      }
      const route = body.route ?? defaultRoute ?? undefined;
      const got = getSession(sessions, repo, route);
      if ("error" in got) return got.error;
      const outcome = undoSession(got.session, editAuthorOpts(body));
      return jsonResponse(outcome, outcome.ok ? 200 : 422);
    }

    if (path === "/api/redo" && req.method === "POST") {
      let body: { route?: string; author?: string; allowCrossAuthor?: boolean } = {};
      try {
        body = (await req.json()) as typeof body;
      } catch {
        // empty body is fine — fall back to the default route
      }
      const route = body.route ?? defaultRoute ?? undefined;
      const got = getSession(sessions, repo, route);
      if ("error" in got) return got.error;
      const outcome = redoSession(got.session, editAuthorOpts(body));
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
      // Timeline-referenced resources AND the project's registered media roots (the
      // BIN — imported media previews before it's placed).
      if (!allow.has(resolved) && !underMediaRoot(repo, resolved)) {
        return jsonResponse(
          {
            ok: false,
            kind: "forbidden",
            detail: "path is not referenced by this timeline or a media root",
          },
          403,
        );
      }
      // serveFile's baseDir guard wants the served file under baseDir; the source's
      // own directory is the correct base (we've already authorized the exact path).
      return serveFile(resolved, dirname(resolved), req);
    }

    // ── Per-source validated decode proxy (the LIVE in-browser decode source) ──
    // GET /api/source-proxy?path=<abs>&route=<r>  → builds (once, cached) a small
    // short-GOP proxy of ONE source file and streams it Range-capable: H.264 for an
    // opaque source, VP9-with-alpha for a transparent source. This is
    // the source the in-browser mediabunny→WebCodecs decoder demuxes (§5, §8.2): the
    // user's footage is HEVC/ProRes, which WebCodecs can't reliably decode, so the
    // realtime decode path consumes the validated derivative. The
    // short GOP (`-g 15`) collapses worst-case seek toward a single keyframe.
    //
    // SAME ALLOWLIST as /api/media: a request may only build/stream a proxy for a
    // file the route's LIVE timeline actually references — never an arbitrary disk
    // path. The transcode shells out to `ffmpeg` once; subsequent requests hit the
    // content-addressed cache. `ffmpeg` here is a one-time prep, NOT in the scrub loop.
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
      if (!allow.has(resolvedReq) && !underMediaRoot(repo, resolvedReq)) {
        return jsonResponse(
          {
            ok: false,
            kind: "forbidden",
            detail: "path is not referenced by this timeline or a media root",
          },
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
        const { isSourceProxyError } = await import("./source-proxy");
        if (isSourceProxyError(error)) {
          return jsonResponse(
            {
              ok: false,
              kind: "source-proxy",
              code: error.code,
              sourcePath: error.sourcePath,
              detail: error.message,
            },
            error.code === "ALPHA_PROBE_UNKNOWN" ? 422 : 500,
          );
        }
        return jsonResponse(
          { ok: false, kind: "source-proxy", detail: String((error as Error)?.message ?? error) },
          500,
        );
      }
    }

    // ── Audio peaks (the waveform lane; DESIGN-UI Phase 3b) ─────────────────
    // GET /api/peaks?clipId=<id>&route=<r>&bins=<n>   (or &path=<abs>)  → downsampled
    // [min,max] peaks for a SOURCE clip's audio, extracted once (cached under
    // .vean/cache/peaks) with ffmpeg. This is what the timeline's waveform lane
    // draws. `bins` is the target bucket count (size it to the on-screen clip width).
    //
    // A `clipId` resolves the source through the live IR (the robust address — it
    // handles a root-relative resource correctly, resolving against the .mlt dir). A
    // raw `path` is validated against the route's referenced-resource allowlist
    // (same guard as /api/media, resolved against the .mlt dir): a request may only
    // extract peaks for a file the LIVE timeline references — never an arbitrary
    // disk path. A source with no audio stream yields `{ bins:0, peaks:[] }`, never
    // a faked waveform.
    if (path === "/api/peaks") {
      const route = url.searchParams.get("route") ?? defaultRoute ?? undefined;
      const got = getSession(sessions, repo, route);
      if ("error" in got) return got.error;
      const clipId = url.searchParams.get("clipId");
      const requested = url.searchParams.get("path");
      if (!clipId && !requested) {
        return jsonResponse(
          { ok: false, kind: "invalid-args", detail: "clipId or path is required" },
          400,
        );
      }
      let sourcePath: string;
      if (clipId) {
        const src = findClipSource(got.session.uri, got.session.ir, clipId);
        if (!src) {
          // Unknown clip / synthetic (non-file) producer → no audio waveform.
          return jsonResponse({
            ok: true,
            clipId,
            sampleRate: 0,
            binFrames: 0,
            bins: 0,
            peaks: [],
          });
        }
        sourcePath = src.absResource;
      } else {
        const allow = referencedResourcesForDoc(got.session.uri, got.session.ir);
        const resolvedReq = resolve(requested as string);
        if (!allow.has(resolvedReq)) {
          return jsonResponse(
            { ok: false, kind: "forbidden", detail: "path is not referenced by this timeline" },
            403,
          );
        }
        sourcePath = resolvedReq;
      }
      const binsRaw = url.searchParams.get("bins");
      const bins = binsRaw != null && Number.isFinite(Number(binsRaw)) ? Number(binsRaw) : 1000;
      try {
        const peaks = await extractPeaks(repo, sourcePath, { bins });
        return jsonResponse({ ok: true, ...(clipId ? { clipId } : {}), ...peaks });
      } catch (error) {
        return jsonResponse(
          { ok: false, kind: "peaks", detail: String((error as Error)?.message ?? error) },
          500,
        );
      }
    }

    // ── Transcript read (the transcript peek; DESIGN-UI Phase 3b) ────────────
    // GET /api/transcript?route=<r>&clipId=<id>   (or &path=<abs>)  → the frame-
    // exact server-side Transcript (words + timings) for that clip's SOURCE, or
    // `{ words: [] }` when none exists. Transcripts live as completed `transcribe`
    // job rows keyed by source path; absent (never transcribed) ⇒ empty — NEVER
    // fabricated. Same route-scoped allowlist as /api/media.
    if (path === "/api/transcript") {
      const route = url.searchParams.get("route") ?? defaultRoute ?? undefined;
      const got = getSession(sessions, repo, route);
      if ("error" in got) return got.error;
      const clipId = url.searchParams.get("clipId");
      const requested = url.searchParams.get("path");
      if (!clipId && !requested) {
        return jsonResponse(
          { ok: false, kind: "invalid-args", detail: "clipId or path is required" },
          400,
        );
      }
      // Resolve the source path: a clipId is looked up in the live IR (and returns
      // the clip's absolute resource); a raw path is validated against the allowlist.
      let sourcePath: string;
      if (clipId) {
        const src = findClipSource(got.session.uri, got.session.ir, clipId);
        if (!src) {
          // Unknown clip / synthetic (non-file) producer → no transcript possible.
          return jsonResponse({ ok: true, clipId, words: [], transcript: null });
        }
        sourcePath = src.absResource;
      } else {
        const allow = referencedResourcesForDoc(got.session.uri, got.session.ir);
        const resolvedReq = resolve(requested as string);
        if (!allow.has(resolvedReq)) {
          return jsonResponse(
            { ok: false, kind: "forbidden", detail: "path is not referenced by this timeline" },
            403,
          );
        }
        sourcePath = resolvedReq;
      }
      try {
        const fps = got.session.ir.profile.fps;
        const jobs = listJobsByKind(repo, TRANSCRIBE_JOB_KIND).map((j) => ({
          kind: j.kind,
          status: j.status,
          payloadJson: j.payloadJson,
          resultJson: j.resultJson,
          finishedAt: j.finishedAt,
          createdAt: j.createdAt,
        }));
        const transcript = transcriptFromJobs(jobs, sourcePath, fps);
        // `words` is the flat word stream (the peek's minimal consumable); the full
        // `transcript` (segments + stable ids) is included for a richer read. Absent
        // ⇒ `{ words: [], transcript: null }` — the never-faked empty case.
        const words = transcript ? transcript.segments.flatMap((s) => s.words) : [];
        return jsonResponse({
          ok: true,
          ...(clipId ? { clipId } : { path: sourcePath }),
          words,
          transcript,
        });
      } catch (error) {
        return jsonResponse(
          { ok: false, kind: "transcript", detail: String((error as Error)?.message ?? error) },
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
  return withCrossOriginIsolation(
    handle,
    opts.policyProfile ?? (opts.dev ? "dev" : "release"),
    opts.mutationAuthority,
  );
}

// ─── Backend HMR (bun --hot) state preservation ──────────────────────────────
// Under `bun --hot`, ALL top-level code re-runs on every backend edit while
// `globalThis` persists. So the Vite child, the bound `Bun.serve`, its handle, and
// the working-copy SESSION MAP live on `globalThis` and are reused across reloads;
// each reload only rebuilds a FRESH fetch handler (closing over the re-evaluated
// `src/ops` + session code and the persisted map) and swaps it onto the running
// server via `server.reload({ fetch })`. Net: edited ops take effect live AND the
// in-memory working IR + undo/redo history survive — the canonical Bun dev loop
// (see DESIGN research: bun.com/docs/runtime/hot). Enabled only when
// `VEAN_PREVIEW_HOT=1` (set by the preview command's --hot re-exec); tests / prod /
// detached callers keep the fresh-server-per-call behavior.
type HotPreviewState = {
  vite?: ViteDevHandle | null;
  server?: ReturnType<typeof Bun.serve>;
  handle?: PreviewServerHandle;
  mutationAuthority?: MutationAuthority;
  sessionMap?: Map<string, TimelineSession>;
};
declare global {
  var __veanPreviewHot: HotPreviewState | undefined;
}

/** Start the preview server on 127.0.0.1:port. Returns a handle with the URL and
 *  a `stop()`. The caller (the `preview.serve` action) keeps the process alive.
 *
 *  In dev mode (the default) this also starts and owns a managed Vite dev server
 *  so the live HMR viewer "just works" with no second terminal — `stop()` tears
 *  down BOTH the HTTP server and Vite. It is async because it waits for Vite to be
 *  ready before binding, so "ready" means the UI is ready, not just the API.
 *
 *  Under `VEAN_PREVIEW_HOT=1` (the --hot dev re-exec) it is hot-idempotent: the
 *  Vite child, bound server, and working-copy session map persist on `globalThis`,
 *  so a reload only swaps a freshly-evaluated fetch handler (see the block above). */
export async function startPreviewServer(opts: PreviewServerOptions): Promise<PreviewServerHandle> {
  const veanRoot = opts.veanRoot ?? veanRepoRoot();
  const hot = process.env.VEAN_PREVIEW_HOT === "1";
  let g: HotPreviewState | undefined;
  if (hot) {
    globalThis.__veanPreviewHot ??= {};
    g = globalThis.__veanPreviewHot;
  }
  const mutationAuthority = opts.mutationAuthority ??
    g?.mutationAuthority ?? {
      host: `127.0.0.1:${opts.port}`,
      origin: `http://127.0.0.1:${opts.port}`,
      token: randomBytes(32).toString("base64url"),
      consumeNonce: createNonceConsumer(),
    };
  if (g) g.mutationAuthority = mutationAuthority;

  // Dev (default): bring up a managed Vite child and proxy to its actual port.
  // Prod (--prod): no Vite — serve the viewer/dist snapshot. Under --hot the Vite
  // child is spawned ONCE and reused across reloads (never re-spawned).
  let vite: ViteDevHandle | null = g?.vite ?? null;
  if (opts.dev && !vite) {
    const { ensureViteDevServer } = await import("./viteDev");
    // Per-project comp discovery: if the active project has its own Remotion
    // compositions, tell the viewer's `@project-comp` alias where to find them so
    // they render live (e.g. retire's ChatRetire) — no copy into the shared workspace.
    const projectComps = join(opts.repo, "remotion", "src", "compositions");
    vite = await ensureViteDevServer({
      veanRoot,
      ...(existsSync(projectComps) ? { projectCompsDir: projectComps } : {}),
    });
    if (g) g.vite = vite;
  }

  // The working-copy MAP survives reloads (globalThis); the SessionStore wrapping it
  // is rebuilt each call so parse/get run freshly-evaluated code, while the working
  // IR + undo history it holds persist. A private map otherwise.
  let sessionMap: Map<string, TimelineSession>;
  if (g) {
    g.sessionMap ??= new Map();
    sessionMap = g.sessionMap;
  } else {
    sessionMap = new Map();
  }
  const fetchHandler = createPreviewHandler(
    { ...opts, mutationAuthority, veanRoot, ...(vite ? { vitePort: vite.port } : {}) },
    new SessionStore(sessionMap),
  );

  // Hot reload of an already-running server: swap the freshly-built handler onto the
  // existing Bun.serve (port + Vite + session state all preserved) and reuse the
  // handle. This is where an edited op becomes live without a restart.
  if (g?.server) {
    g.server.reload({ fetch: fetchHandler });
    process.stderr.write("vean preview: backend hot-reloaded (src/ops + preview)\n");
    return g.handle as PreviewServerHandle;
  }

  const server = Bun.serve({
    port: opts.port,
    hostname: "127.0.0.1",
    fetch: fetchHandler,
    // Long renders: don't time out the proxy-render request.
    idleTimeout: 0,
  });
  const boundPort = server.port ?? opts.port;
  mutationAuthority.host = `127.0.0.1:${boundPort}`;
  mutationAuthority.origin = `http://127.0.0.1:${boundPort}`;
  const handle: PreviewServerHandle = {
    url: `http://127.0.0.1:${boundPort}`,
    port: boundPort,
    stop: () => {
      server.stop(true);
      vite?.stop();
    },
  };
  if (g) {
    g.server = server;
    g.handle = handle;
  }
  return handle;
}
