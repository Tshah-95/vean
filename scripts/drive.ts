#!/usr/bin/env bun
// The DRIVE harness lifecycle helper (the `drive` skill's one real primitive).
//
// Why this exists: the local Mac app is a thin Tauri shell whose WKWebView just
// NAVIGATES to a `vean preview` sidecar on a loopback port (see
// `app/src-tauri/src/lib.rs`). WKWebView speaks no CDP, so a Chromium agent can't
// attach to the *native window* — but it doesn't need to: the real UI is the
// `viewer/` web app served over plain http on 127.0.0.1, and it talks to the
// backend over same-origin HTTP (`viewer/src/api.ts`), NOT `invoke`. So pointing
// `agent-browser` at the same URL drives the byte-identical frontend + backend the
// app renders — headless, scriptable, and recordable.
//
// This helper owns only the server LIFECYCLE so the agent doesn't hand-roll
// free-port + wait-for-health + teardown on every run. Everything else (click,
// snapshot, screenshot, record) is raw `agent-browser` — see the `drive` skill.
//
// Usage (`--name` defaults to this worktree's slug — see below):
//   bun scripts/drive.ts up [--project <path>] [--timeline <route>] [--port <n>] [--name <s>]
//   bun scripts/drive.ts url   [--name <s>]   # bare URL on stdout (chainable)
//   bun scripts/drive.ts status[--name <s>]   # health JSON (slug/name/port/url) on stdout
//   bun scripts/drive.ts name  [--name <s>]   # echo the resolved name (= slug) for agent-browser
//   bun scripts/drive.ts down  [--name <s>]   # stop one sidecar, clear the session
//   bun scripts/drive.ts down --all           # reap EVERY drive sidecar (safety net)
//   bun scripts/drive.ts verify               # canonical hermetic H04 browser E2E
//
// Concurrency safety (learned the hard way: a loop calling `up` orphaned 33
// detached servers). `up` is idempotent AND race-safe: an exclusive spawn LOCK
// serializes concurrent `up`s on the same name, so a burst reuses one server
// instead of leaking a duplicate per call. The session record is written the
// instant the child is spawned — BEFORE the health wait — and every spawn is
// appended to a reap log, so no detached server is ever un-killable by `down`.
// `--name` defaults to this checkout's worktree SLUG (§4.1) — so two concurrent
// worktrees get independent drive sessions AND independent `agent-browser
// --session`s without the caller remembering to pass `--name`, instead of both
// colliding on the literal "vean" (which shares one browser tab: the second
// `open` navigates away from the first). An explicit `--name` still wins. The
// name maps 1:1 to the `agent-browser --session <name>` you drive with; distinct
// names give independent concurrent sessions.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { resolveWorktreeSlug } from "@/state/worktree";

const REPO = resolve(import.meta.dir, "..");
const CLI = join(REPO, "src", "cli.ts");
const DRIVE_DIR = join(REPO, ".vean", "drive");

/** This checkout's worktree slug — the default `--name` / `agent-browser
 *  --session` (§4.1). Resolved once against THIS script's own tree (not cwd), so
 *  the default is stable no matter where the harness is invoked from. */
const WORKTREE_SLUG = resolveWorktreeSlug(REPO).slug;

/** The `--name` to use: explicit flag wins, else the worktree slug. */
function resolveName(flags: Record<string, string>): string {
  return flags.name ?? WORKTREE_SLUG;
}
/** Env marker stamped on every drive-spawned sidecar (identifies our processes). */
const DRIVE_TAG = "VEAN_DRIVE";
/** Append-only log of every pid we spawn, so `down --all` can reap even a session
 *  whose JSON record was lost/overwritten. */
const SPAWN_LOG = join(DRIVE_DIR, "spawned.jsonl");

interface Session {
  name: string;
  pid: number;
  port: number;
  url: string;
  project: string;
  timeline?: string;
  startedAt: string;
  /** "starting" between spawn and first healthy /api/health; "ready" after. */
  status?: "starting" | "ready";
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Optional default `--project` pointer for `up` (§4.4a/§4.7 item 5):
 *  `worktree-init` may record which shared project this code-worktree previews,
 *  as a `defaultProject` key on `.vean/worktree.json`. Read defensively — the
 *  field is optional and the state file is owned by `src/state/worktree.ts`;
 *  absent/malformed → null and `up` falls back to today's cwd behavior. */
function readDefaultProject(): string | null {
  const path = join(REPO, ".vean", "worktree.json");
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { defaultProject?: unknown };
    return typeof parsed.defaultProject === "string" && parsed.defaultProject.trim()
      ? parsed.defaultProject
      : null;
  } catch {
    return null;
  }
}

function sessionPath(name: string): string {
  return join(DRIVE_DIR, `${name}.json`);
}

function lockPath(name: string): string {
  return join(DRIVE_DIR, `${name}.lock`);
}

function readSession(name: string): Session | null {
  const path = sessionPath(name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Session;
  } catch {
    return null;
  }
}

/** True if the process is still alive (signal 0 probes without killing). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  }
}

/** A live, healthy session for `name`, or null. */
async function reuseIfHealthy(name: string): Promise<Session | null> {
  const s = readSession(name);
  if (s && alive(s.pid) && (await healthy(s.url))) return s;
  return null;
}

function driveHint(s: Session): string {
  return `agent-browser --headed false --session ${s.name} open ${s.url}`;
}

function printReuse(s: Session): void {
  process.stderr.write(
    `drive: reusing healthy session "${s.name}" (pid ${s.pid})\n  project: ${s.project}\n  drive it: ${driveHint(s)}\n`,
  );
  process.stdout.write(`${s.url}\n`);
}

/** Atomically claim the spawn lock for `name` (O_EXCL). Returns the fd, or null if
 *  another `up` already holds it. */
function acquireLock(name: string): number | null {
  try {
    return openSync(lockPath(name), "wx");
  } catch {
    return null;
  }
}

/** A lock older than 30s is stale — its `up` crashed before releasing. */
function lockStale(name: string): boolean {
  try {
    return Date.now() - statSync(lockPath(name)).mtimeMs > 30_000;
  } catch {
    return true; // gone → not held
  }
}

function releaseLock(name: string, fd: number): void {
  try {
    closeSync(fd);
  } catch {}
  try {
    rmSync(lockPath(name), { force: true });
  } catch {}
}

/** Ask the OS for a free loopback port (bind :0, read it back, release). */
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

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a?.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "true";
      }
    }
  }
  return out;
}

async function up(flags: Record<string, string>): Promise<void> {
  const name = resolveName(flags);
  mkdirSync(DRIVE_DIR, { recursive: true });

  // Fast path: a healthy session already exists → reuse without locking.
  const fast = await reuseIfHealthy(name);
  if (fast) return printReuse(fast);

  // Serialize concurrent `up`s on the SAME name behind an exclusive spawn lock, so
  // a burst (a loop, parallel agents) reuses one server instead of leaking a
  // duplicate per call — the bug that orphaned 33 detached servers.
  let fd = acquireLock(name);
  let waited = 0;
  while (fd === null) {
    if (lockStale(name)) {
      rmSync(lockPath(name), { force: true });
      fd = acquireLock(name);
      continue;
    }
    await sleep(200);
    waited += 200;
    const ready = await reuseIfHealthy(name); // the lock holder may have finished
    if (ready) return printReuse(ready);
    if (waited > 20_000) {
      throw new Error(`another \`drive up --name ${name}\` is still starting (lock held)`);
    }
  }

  try {
    // Re-check under the lock — a holder may have started one just before us.
    const ready = await reuseIfHealthy(name);
    if (ready) return printReuse(ready);

    const stale = readSession(name);
    if (stale) await stop(stale); // dead/unhealthy record → reap before restarting

    // Project precedence (§4.4a/§4.7 item 5): explicit `--project` → the
    // worktree's recorded default pointer → today's cwd fallback.
    const project = resolve(flags.project ?? readDefaultProject() ?? process.cwd());
    const port = flags.port ? Number.parseInt(flags.port, 10) : await freePort();
    const url = `http://127.0.0.1:${port}`;

    const logPath = join(DRIVE_DIR, `${name}.log`);
    const log = openSync(logPath, "w");
    const args = [CLI, "preview", "--no-open", "--port", String(port), "--repo", project];
    if (flags.timeline) args.push("--timeline", flags.timeline);
    // Dev (live Vite + HMR) is the default so a drive always reflects THIS
    // worktree's current viewer code — proving a UI change, not a stale snapshot.
    // `--prod` opts into the viewer/dist snapshot (e.g. to reproduce the shipped app).
    if (flags.prod !== undefined) args.push("--prod");

    // Detached so the sidecar outlives this short-lived `up`; its own process group
    // lets `down` reap render/probe children with one signal. Stamped with
    // VEAN_DRIVE so it is identifiable as a drive-spawned process.
    const child = spawn("bun", args, {
      cwd: project,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, [DRIVE_TAG]: name },
    });
    child.unref();
    if (!child.pid) throw new Error("failed to spawn preview sidecar");

    // Record the session AND the spawn log IMMEDIATELY — before the health wait — so
    // `down` / `down --all` can always reap this pid even if it never becomes
    // healthy. No detached server is ever left un-killable.
    const session: Session = {
      name,
      pid: child.pid,
      port,
      url,
      project,
      timeline: flags.timeline,
      startedAt: new Date().toISOString(),
      status: "starting",
    };
    writeFileSync(sessionPath(name), `${JSON.stringify(session, null, 2)}\n`);
    appendFileSync(
      SPAWN_LOG,
      `${JSON.stringify({ pid: child.pid, port, name, at: session.startedAt })}\n`,
    );

    // Generous health window: in dev mode (the default) the preview only answers
    // /api/health AFTER its managed Vite is ready, and a first-ever Vite cold start
    // (dep pre-bundling) can take tens of seconds. A genuine failure still exits the
    // child early — `!alive` breaks the loop immediately — so the long cap only
    // applies to a slow-but-healthy boot, never to a hang.
    let ok = false;
    for (let i = 0; i < 600; i++) {
      if (await healthy(url)) {
        ok = true;
        break;
      }
      if (!alive(child.pid)) break;
      await sleep(100);
    }
    if (!ok) {
      try {
        process.kill(-child.pid);
      } catch {}
      rmSync(sessionPath(name), { force: true });
      const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-800) : "";
      throw new Error(
        `preview sidecar did not become healthy on ${url}\n--- log tail ---\n${tail}`,
      );
    }

    session.status = "ready";
    writeFileSync(sessionPath(name), `${JSON.stringify(session, null, 2)}\n`);

    const timelineLine = flags.timeline ? `  timeline: ${flags.timeline}\n` : "";
    process.stderr.write(
      `drive: up "${name}" on ${url} (pid ${child.pid})\n  project:  ${project}\n${timelineLine}  drive it: ${driveHint(session)}\n  stop it:  bun scripts/drive.ts down --name ${name}\n`,
    );
    process.stdout.write(`${url}\n`);
  } finally {
    releaseLock(name, fd);
  }
}

/** Stop a session's sidecar (process group first, then the bare pid) and clear it. */
async function stop(session: Session): Promise<void> {
  try {
    process.kill(-session.pid, "SIGTERM");
  } catch {
    try {
      process.kill(session.pid, "SIGTERM");
    } catch {}
  }
  rmSync(sessionPath(session.name), { force: true });
  rmSync(lockPath(session.name), { force: true });
}

/** Reap EVERY drive-spawned sidecar — the safety net for leaked/duplicate servers.
 *  Kills each recorded session AND every still-live pid in the spawn log, then
 *  clears all records. */
async function downAll(): Promise<void> {
  const killed = new Set<number>();

  // 1. Recorded sessions (current source of truth).
  let names: string[] = [];
  try {
    names = readdirSync(DRIVE_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
  } catch {}
  for (const name of names) {
    const session = readSession(name);
    if (session) {
      await stop(session);
      killed.add(session.pid);
    }
    rmSync(lockPath(name), { force: true });
  }

  // 2. The spawn log — catches any pid whose JSON record was lost/overwritten.
  if (existsSync(SPAWN_LOG)) {
    for (const line of readFileSync(SPAWN_LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const { pid } = JSON.parse(line) as { pid: number };
        if (!killed.has(pid) && alive(pid)) {
          try {
            process.kill(-pid, "SIGTERM");
          } catch {
            try {
              process.kill(pid, "SIGTERM");
            } catch {}
          }
          killed.add(pid);
        }
      } catch {}
    }
    rmSync(SPAWN_LOG, { force: true });
  }

  process.stderr.write(`drive: down --all reaped ${killed.size} sidecar(s)\n`);
}

async function down(flags: Record<string, string>): Promise<void> {
  if (flags.all !== undefined) return downAll();
  const name = resolveName(flags);
  const session = readSession(name);
  if (!session) {
    process.stderr.write(`drive: no session "${name}" to stop\n`);
    return;
  }
  await stop(session);
  process.stderr.write(`drive: down "${name}" (pid ${session.pid} stopped)\n`);
}

async function url(flags: Record<string, string>): Promise<void> {
  const name = resolveName(flags);
  const session = readSession(name);
  if (!session || !alive(session.pid)) {
    process.stderr.write(
      `drive: no live session "${name}" — run \`bun scripts/drive.ts up\` first\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${session.url}\n`);
}

/** Echo the resolved drive `--name` (= worktree slug unless overridden) so the
 *  `agent-browser --session "$(bun scripts/drive.ts name)"` pairing is
 *  copy-pasteable and never drifts from `up`'s default (§4.7 item 2). */
async function name(flags: Record<string, string>): Promise<void> {
  process.stdout.write(`${resolveName(flags)}\n`);
}

async function status(flags: Record<string, string>): Promise<void> {
  const sessionName = resolveName(flags);
  const session = readSession(sessionName);
  // Echo the worktree slug even when there's no session, so a driver can confirm
  // WHICH tree it's probing (§4.7 item 3). `slug` is this checkout's identity;
  // `name` is the agent-browser `--session` (= slug unless `--name` overrides).
  if (!session) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, name: sessionName, slug: WORKTREE_SLUG, reason: "no session" })}\n`,
    );
    return;
  }
  const live = alive(session.pid);
  const ok = live && (await healthy(session.url));
  process.stdout.write(
    `${JSON.stringify({
      ok,
      name: session.name,
      slug: WORKTREE_SLUG,
      url: session.url,
      port: session.port,
      pid: session.pid,
      alive: live,
      status: session.status,
      project: session.project,
      timeline: session.timeline,
    })}\n`,
  );
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  switch (cmd) {
    case "up":
      return up(flags);
    case "down":
      return down(flags);
    case "url":
      return url(flags);
    case "status":
      return status(flags);
    case "name":
      return name(flags);
    case "verify": {
      const result = spawnSync("bun", [join(REPO, "scripts/verify-browser.ts")], {
        cwd: REPO,
        stdio: "inherit",
        env: process.env,
      });
      process.exit(result.status ?? 1);
      return;
    }
    default:
      process.stderr.write(
        "usage: bun scripts/drive.ts <up|down|url|status|name|verify> " +
          "[--project <path>] [--timeline <route>] [--port <n>] [--name <s>] [--all]\n",
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((error) => {
  process.stderr.write(`drive: ${String(error?.message ?? error)}\n`);
  process.exit(1);
});
