#!/usr/bin/env bun
// A standalone Bun helper that boots the preview server detached against a
// fixture project (timeline:main → a corpus .mlt) and probes the READ endpoints,
// printing a single JSON result line. Run under `bun` (so `bun:sqlite` resolves);
// `tests/preview-serve.test.ts` spawns it via spawnSync and asserts on the JSON.
// This keeps the HTTP integration check out of the Node/Vitest process while
// still gating it in `bun run test` (the test spawns this).
//
// Usage: bun scripts/preview-serve-probe.ts
import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createActionContext, executeAction } from "../src/actions";

const REPO = resolve(import.meta.dir, "..");

async function main() {
  const projectRoot = mkdtempSync(join(tmpdir(), "vean-preview-probe-"));
  const configHome = mkdtempSync(join(tmpdir(), "vean-preview-probe-config-"));
  const mlt = join(projectRoot, "main.mlt");
  copyFileSync(join(REPO, "corpus", "shotcut-multitrack.mlt"), mlt);

  const ctx = createActionContext({
    cwd: projectRoot,
    env: { ...process.env, VEAN_CONFIG_HOME: configHome },
    surface: "test",
  });
  await executeAction("project.init", { repo: projectRoot }, ctx);
  await executeAction("timeline.use", { repo: projectRoot, target: mlt }, ctx);

  // dev:false — this probe exercises the READ API + the dist static host, not the
  // live viewer. preview.serve now DEFAULTS to dev (auto-starts a Vite child); the
  // vitest gate must not, so opt into the prod/dist path explicitly.
  const served = await executeAction(
    "preview.serve",
    { repo: projectRoot, port: 0, open: false, detached: true, dev: false },
    ctx,
  );
  if (!served.ok) throw new Error(`preview.serve failed: ${JSON.stringify(served)}`);
  const out = served.output as { url: string; _stop: () => void };

  const getJson = async (path: string) => {
    const res = await fetch(`${out.url}${path}`);
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  /** Capture the cross-origin isolation headers a response carries. The served
   *  viewer can only reach `crossOriginIsolated === true` if the top-level document
   *  ships COOP `same-origin` + COEP `require-corp`, and every subresource ships a
   *  CORP header. We assert the headers on BOTH the HTML document (`/`) and an API
   *  response so the test gate matches what the browser actually enforces. */
  const coiHeaders = async (path: string) => {
    const res = await fetch(`${out.url}${path}`);
    // Drain the body so the connection is released before teardown.
    await res.arrayBuffer().catch(() => undefined);
    return {
      status: res.status,
      coop: res.headers.get("cross-origin-opener-policy"),
      coep: res.headers.get("cross-origin-embedder-policy"),
      corp: res.headers.get("cross-origin-resource-policy"),
    };
  };

  try {
    const health = await getJson("/api/health");
    const timeline = await getJson("/api/timeline");
    const timelines = await getJson("/api/timelines");
    const diagnostics = await getJson("/api/diagnostics");
    const bad = await fetch(`${out.url}/api/nope`);
    // The document (`/`) is what the browser checks for isolation; the API stream
    // is a representative subresource that must stay CORP-compatible under COEP.
    const isolationHtml = await coiHeaders("/");
    const isolationApi = await coiHeaders("/api/health");
    const bootstrap = await fetch(`${out.url}/`);
    await bootstrap.arrayBuffer();
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const unauthorizedMutation = await fetch(`${out.url}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: out.url },
      body: JSON.stringify({ id: "missing.action" }),
    });
    const authorizedMutation = await fetch(`${out.url}/api/action`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: out.url,
        cookie,
        "x-vean-nonce": crypto.randomUUID(),
      },
      body: JSON.stringify({ id: "missing.action" }),
    });

    const result = {
      ok: true,
      url: out.url,
      isLocal: out.url.startsWith("http://127.0.0.1:"),
      health: { status: health.status, ok: health.body?.ok, repo: health.body?.repo },
      timeline: {
        status: timeline.status,
        ok: timeline.body?.ok,
        fps: timeline.body?.fps,
        totalFrames: timeline.body?.totalFrames,
        videoTracks: timeline.body?.timeline?.tracks?.video?.length,
        audioTracks: timeline.body?.timeline?.tracks?.audio?.length,
      },
      timelines: {
        status: timelines.status,
        ok: timelines.body?.ok,
        count: timelines.body?.timelines?.length,
      },
      diagnostics: {
        status: diagnostics.status,
        ok: diagnostics.body?.ok,
        clean: diagnostics.body?.health?.clean,
      },
      badEndpointStatus: bad.status,
      isolationHtml,
      isolationApi,
      mutationAuthority: {
        bootstrapCookieHttpOnly: bootstrap.headers.get("set-cookie")?.includes("HttpOnly") ?? false,
        unauthorizedStatus: unauthorizedMutation.status,
        authorizedStatus: authorizedMutation.status,
      },
    };
    console.log(JSON.stringify(result));
  } finally {
    out._stop();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
    process.exit(1);
  });
