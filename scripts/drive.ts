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
// Usage:
//   bun scripts/drive.ts up [--project <path>] [--timeline <route>] [--port <n>] [--name <s>]
//   bun scripts/drive.ts url   [--name <s>]   # bare URL on stdout (chainable)
//   bun scripts/drive.ts status[--name <s>]   # health JSON on stdout
//   bun scripts/drive.ts down  [--name <s>]   # stop the sidecar, clear the session
//
// `up` prints the bare URL on stdout (hints on stderr) and is idempotent: a second
// `up` reuses a still-healthy session instead of spawning a duplicate. The session
// (pid/port/url/project) lives in the vean repo's gitignored
// `.vean/drive/<name>.json`; `--name` (default "vean") maps 1:1 to the
// `agent-browser --session <name>` you drive with.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const CLI = join(REPO, "src", "cli.ts");
const DRIVE_DIR = join(REPO, ".vean", "drive");

interface Session {
  name: string;
  pid: number;
  port: number;
  url: string;
  project: string;
  timeline?: string;
  startedAt: string;
}

function sessionPath(name: string): string {
  return join(DRIVE_DIR, `${name}.json`);
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
    if (a.startsWith("--")) {
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
  const name = flags.name ?? "vean";
  mkdirSync(DRIVE_DIR, { recursive: true });

  // Idempotent: reuse a still-healthy session rather than spawn a duplicate.
  const existing = readSession(name);
  if (existing && alive(existing.pid) && (await healthy(existing.url))) {
    process.stderr.write(
      `drive: reusing healthy session "${name}" (pid ${existing.pid})\n  project: ${existing.project}\n  drive it: agent-browser --session ${name} open ${existing.url}\n`,
    );
    process.stdout.write(`${existing.url}\n`);
    return;
  }
  if (existing) await stop(existing); // stale → clean up before restarting

  const project = resolve(flags.project ?? process.cwd());
  const port = flags.port ? Number.parseInt(flags.port, 10) : await freePort();
  const url = `http://127.0.0.1:${port}`;

  const logPath = join(DRIVE_DIR, `${name}.log`);
  const log = openSync(logPath, "w");
  const args = [CLI, "preview", "--no-open", "--port", String(port), "--repo", project];
  if (flags.timeline) args.push("--timeline", flags.timeline);

  // Detached so the sidecar outlives this short-lived `up` invocation; its own
  // process group lets `down` reap any render/probe children with one signal.
  const child = spawn("bun", args, {
    cwd: project,
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  if (!child.pid) throw new Error("failed to spawn preview sidecar");

  // Wait for the server to answer /api/health (it serves viewer/dist + the API
  // the moment it's listening). ~15s budget mirrors the Tauri shell's wait.
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (await healthy(url)) {
      ready = true;
      break;
    }
    if (!alive(child.pid)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) {
    try {
      process.kill(-child.pid);
    } catch {}
    const tail = existsSync(logPath) ? readFileSync(logPath, "utf8").slice(-800) : "";
    throw new Error(`preview sidecar did not become healthy on ${url}\n--- log tail ---\n${tail}`);
  }

  const session: Session = {
    name,
    pid: child.pid,
    port,
    url,
    project,
    timeline: flags.timeline,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(sessionPath(name), `${JSON.stringify(session, null, 2)}\n`);

  const timelineLine = flags.timeline ? `  timeline: ${flags.timeline}\n` : "";
  process.stderr.write(
    `drive: up "${name}" on ${url} (pid ${child.pid})\n  project:  ${project}\n${timelineLine}  drive it: agent-browser --session ${name} open ${url}\n  stop it:  bun scripts/drive.ts down --name ${name}\n`,
  );
  process.stdout.write(`${url}\n`);
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
}

async function down(flags: Record<string, string>): Promise<void> {
  const name = flags.name ?? "vean";
  const session = readSession(name);
  if (!session) {
    process.stderr.write(`drive: no session "${name}" to stop\n`);
    return;
  }
  await stop(session);
  process.stderr.write(`drive: down "${name}" (pid ${session.pid} stopped)\n`);
}

async function url(flags: Record<string, string>): Promise<void> {
  const name = flags.name ?? "vean";
  const session = readSession(name);
  if (!session || !alive(session.pid)) {
    process.stderr.write(
      `drive: no live session "${name}" — run \`bun scripts/drive.ts up\` first\n`,
    );
    process.exit(1);
  }
  process.stdout.write(`${session.url}\n`);
}

async function status(flags: Record<string, string>): Promise<void> {
  const name = flags.name ?? "vean";
  const session = readSession(name);
  if (!session) {
    process.stdout.write(`${JSON.stringify({ ok: false, name, reason: "no session" })}\n`);
    return;
  }
  const live = alive(session.pid);
  const ok = live && (await healthy(session.url));
  process.stdout.write(
    `${JSON.stringify({ ok, name, url: session.url, pid: session.pid, alive: live, project: session.project })}\n`,
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
    default:
      process.stderr.write(
        "usage: bun scripts/drive.ts <up|down|url|status> " +
          "[--project <path>] [--timeline <route>] [--port <n>] [--name <s>]\n",
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((error) => {
  process.stderr.write(`drive: ${String(error?.message ?? error)}\n`);
  process.exit(1);
});
