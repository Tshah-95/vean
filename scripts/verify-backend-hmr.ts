#!/usr/bin/env bun
// verify:backend-hmr — proves the dev preview server hot-reloads BACKEND code
// (src/ops) into the RUNNING process WITHOUT a restart, and PRESERVES in-memory
// session state (working IR + undo history) across that reload. This is the
// canonical `bun --hot` dev loop the project standardizes on (AGENTS: "the default
// should always be that dev servers HMR in whatever the canonical way to do this
// is"). The mechanism: the preview command re-execs under `bun --hot`; the working
// SessionStore map + the bound Bun.serve live on `globalThis`, so a reload only
// swaps a freshly-evaluated fetch handler onto the running server — edited ops take
// effect live while state persists (see src/preview/server.ts startPreviewServer).
//
// One reload, two assertions:
//   1. OPS RELOAD (no restart) — capture the `gain` op's summary via
//      /api/action → timeline.ops.describe; append a SENTINEL to that op's catalog
//      summary on disk; poll the SAME running child until it returns the sentinel.
//      A single child process we spawned (its pid never changes) returning a changed
//      response proves in-process module HMR, not a restart.
//   2. STATE SURVIVES — BEFORE the edit, apply a `gain` op on the default route
//      (builds an undo stack in the in-memory session). AFTER the reload, POST
//      /api/undo → it succeeds, proving the working IR + history survived the reload.
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..");
const CLI = join(REPO, "src", "cli.ts");
const PROJECT = join(REPO, "projects", "retire");
const CATALOG = join(REPO, "src", "ops", "catalog.ts");
const CLIP = "db100d85-8220-4a3e-a6f2-5228fa5be8cb"; // retire V1 clip 0 (from timeline show)
const SUMMARY = "Set audio gain in decibels.";
const SENTINEL = "HMR_PROBE_9f3a2c";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ApiResult = { status: number; json: Record<string, unknown> | null };

async function post(url: string, path: string, body: unknown): Promise<ApiResult> {
  const r = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await r.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: r.status, json };
}

async function healthy(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/health`);
    return r.ok;
  } catch {
    return false;
  }
}

/** The whole describe-envelope for the `gain` op, as a string to scan for the
 *  sentinel. Read-only + deterministic (no mutation), so polling is safe. */
async function gainDescribeText(url: string): Promise<string> {
  const { json } = await post(url, "/api/action", {
    id: "timeline.ops.describe",
    input: { op: "gain" },
  });
  return JSON.stringify(json);
}

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  throw new Error(message);
}

async function main(): Promise<void> {
  const original = readFileSync(CATALOG, "utf8");
  if (!original.includes(SUMMARY))
    fail(`catalog.ts no longer contains the probe anchor "${SUMMARY}"`);

  let child: ChildProcess | null = null;
  let restored = false;
  const restore = () => {
    if (!restored) {
      writeFileSync(CATALOG, original);
      restored = true;
    }
  };

  try {
    // Spawn the hot server directly (VEAN_PREVIEW_HOT=1 → no re-exec layer, so we
    // hold the exact server pid). Ephemeral port; we parse the bound URL from stderr.
    child = spawn("bun", ["--hot", CLI, "preview", "--no-open", "--repo", PROJECT], {
      cwd: REPO,
      env: { ...process.env, VEAN_PREVIEW_HOT: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    let url = "";
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      const m = stderr.match(/ready on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m?.[1]) url = m[1];
    });
    child.stdout?.on("data", () => {});

    for (let i = 0; i < 300 && !url; i++) await sleep(100);
    if (!url) fail(`server never printed a bound URL\n--- stderr ---\n${stderr}`);
    for (let i = 0; i < 300 && !(await healthy(url)); i++) await sleep(100);
    if (!(await healthy(url)))
      fail(`server never became healthy on ${url}\n--- stderr ---\n${stderr}`);
    console.log(`server up on ${url} (pid ${pid})`);

    // ── (2 setup) build in-memory session state: apply a gain op on the default route.
    const applied = await post(url, "/api/apply-op", {
      op: "gain",
      args: { uuid: CLIP, db: -6 },
    });
    if (applied.status !== 200 || applied.json?.ok !== true) {
      fail(`apply-op(gain) failed: ${JSON.stringify(applied.json)}`);
    }
    if (applied.json?.canUndo !== true)
      fail(`apply-op did not build an undo stack (canUndo=${applied.json?.canUndo})`);
    console.log("state: applied gain op → undo stack built");

    // ── (1) baseline: the sentinel is NOT present before the edit.
    if ((await gainDescribeText(url)).includes(SENTINEL))
      fail("sentinel present before the edit (stale build?)");

    // Edit the op catalog on disk → bun --hot re-evaluates it in the running process.
    writeFileSync(CATALOG, original.replace(SUMMARY, `${SUMMARY} ${SENTINEL}`));
    console.log("edited src/ops/catalog.ts (injected sentinel) — waiting for hot reload…");

    let reloaded = false;
    for (let i = 0; i < 150; i++) {
      if ((await gainDescribeText(url)).includes(SENTINEL)) {
        reloaded = true;
        break;
      }
      await sleep(200);
    }
    if (!reloaded) fail("running server never reflected the src/ops edit within ~30s (no HMR)");
    if (child.pid !== pid || child.exitCode !== null)
      fail("server process restarted (pid changed / exited) — that is NOT in-process HMR");
    console.log("✓ (1) ops reload: running server reflected the src/ops edit WITHOUT a restart");

    // ── (2) the pre-edit session state survived the reload: undo must succeed.
    const undone = await post(url, "/api/undo", {});
    if (undone.status !== 200 || undone.json?.ok !== true) {
      fail(
        `undo after reload failed — session state did NOT survive: ${JSON.stringify(undone.json)}`,
      );
    }
    console.log("✓ (2) state survives: the in-memory undo stack persisted across the hot reload");

    console.log(
      "\nOVERALL: PASS — backend HMR reflects src/ops edits live AND preserves session state.",
    );
  } finally {
    restore();
    if (child?.pid) {
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {}
    }
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
