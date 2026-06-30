// The managed Vite dev server — what makes "dev is the default" actually *just
// work*. When the preview server runs in dev mode (the default), it owns the
// lifecycle of a `viewer/` Vite dev server so the human/agent never has to start
// one in a second terminal: this module picks a free loopback port, ensures the
// viewer's deps exist, spawns Vite on that port, waits for it to answer, and hands
// back a `{ port, stop }` the preview server reverse-proxies to (and tears down).
//
// Why a per-preview Vite (not one shared 5175):
//   • Worktree-native (DESIGN-WORKTREE §4): two checkouts can each `drive up` and
//     get an independent preview + an independent Vite on its own ephemeral port,
//     so neither HMR stream nor browser tab collides with the other.
//   • Self-contained teardown: the child is spawned in the preview process's OWN
//     process group (NOT detached), so when `drive down` group-kills the preview
//     sidecar (`kill(-pid)`) Vite dies with it, and the preview's `stop()` also
//     kills it explicitly for the foreground / action-stop paths. No orphans.
//
// The viewer reads `VEAN_VIEWER_PORT` from its env (viewer/vite.config.ts) to bind
// that exact port with `strictPort` AND to point its HMR client websocket straight
// at it (`server.hmr.clientPort`). That last part is load-bearing: the page is
// served THROUGH the preview proxy on a different port, and Vite's HMR socket is
// not proxied (it's a raw ws), so the browser must dial Vite directly — the
// standard "Vite behind a proxy" configuration. Without it edits wouldn't live-push.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

export type ViteDevHandle = {
  /** The loopback port Vite bound — the preview server reverse-proxies here. */
  port: number;
  /** Kill the Vite child (and its esbuild workers via the shared group). */
  stop: () => void;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for a free loopback port (bind :0, read it back, release). The tiny
 *  TOCTOU window before Vite binds it is covered by `strictPort` — Vite exits
 *  loudly if the port was taken, which surfaces as a clear startup failure rather
 *  than silently drifting to another port the proxy wouldn't find. */
function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => (port ? res(port) : rej(new Error("could not get a free port"))));
    });
  });
}

/** True once the Vite dev server answers an HTTP request on `127.0.0.1:port`. */
async function viteReady(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    // Any HTTP answer (200 for index.html, even a 4xx) means the server is up.
    return res.status > 0;
  } catch {
    return false;
  }
}

/** The viewer is its OWN workspace (`viewer/package.json` + `viewer/bun.lock`), so
 *  the root `bun install` does NOT populate `viewer/node_modules`. A fresh worktree
 *  that never ran `viewer:install` would otherwise fail Vite on first dev launch.
 *  Install once, synchronously, when absent — the "just works" guarantee. */
function ensureViewerDeps(viewerDir: string, log: (m: string) => void): void {
  if (existsSync(join(viewerDir, "node_modules"))) return;
  log("vean preview: installing viewer deps (first dev run, one-time)…");
  const r = spawnSync("bun", ["install"], { cwd: viewerDir, stdio: "inherit" });
  if (r.status !== 0 || r.error) {
    throw new Error(
      `failed to install viewer deps in ${viewerDir} — run \`bun run viewer:install\` and retry`,
    );
  }
}

/**
 * Start a managed Vite dev server for `<veanRoot>/viewer`, bound to a fresh
 * ephemeral loopback port, and resolve once it answers. Throws (with the Vite
 * output visible on the inherited stderr) if it dies early or never becomes ready,
 * so the preview server exits non-zero and the caller (`drive up`) reports it.
 */
export async function ensureViteDevServer(opts: {
  veanRoot: string;
  /** Where to route the child's startup line (default: process.stderr). */
  log?: (message: string) => void;
}): Promise<ViteDevHandle> {
  const log = opts.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const viewerDir = join(opts.veanRoot, "viewer");
  if (!existsSync(viewerDir)) {
    throw new Error(`viewer workspace not found at ${viewerDir}`);
  }
  ensureViewerDeps(viewerDir, log);

  const port = await freePort();
  log(`vean preview: starting live viewer (Vite, HMR) on 127.0.0.1:${port}…`);

  // NOT detached: the child joins the preview process's group so a group-kill of
  // the preview sidecar (`drive down`) reaps Vite too. stdio inherited so its logs
  // flow wherever the preview's logs go (the drive log file, or the terminal).
  const child: ChildProcess = spawn("bun", ["run", "dev"], {
    cwd: viewerDir,
    stdio: ["ignore", "inherit", "inherit"],
    env: { ...process.env, VEAN_VIEWER_PORT: String(port) },
  });

  let exited = false;
  child.on("exit", () => {
    exited = true;
  });

  const stop = () => {
    try {
      child.kill("SIGTERM");
    } catch {}
  };

  // Cold start + first-run dep pre-bundling can take a while; poll generously.
  for (let i = 0; i < 200; i++) {
    if (exited) {
      throw new Error(
        "vite dev server exited before becoming ready (see viewer log above; try `bun run viewer:dev` to debug)",
      );
    }
    if (await viteReady(port)) return { port, stop };
    await sleep(150);
  }
  stop();
  throw new Error(`vite dev server did not become ready on 127.0.0.1:${port} within ~30s`);
}
