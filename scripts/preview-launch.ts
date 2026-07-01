#!/usr/bin/env bun
/**
 * preview-launch — the Claude Desktop preview adapter (.claude/launch.json → vean preview).
 *
 * The desktop app's preview pane launches this script in the foreground and points its
 * embedded browser at the port from `.claude/launch.json`. Its port contract: the
 * configured port is the default, and when `autoPort` resolves a conflict the app passes
 * the reassigned port via the `PORT` env var (https://code.claude.com/docs/en/desktop.md
 * → Configure preview servers). vean's own port chain (--port → VEAN_PREVIEW_PORT →
 * ephemeral) knows nothing about `PORT`, so this adapter translates: bind PORT when set,
 * else the launch.json default.
 *
 * Project precedence mirrors scripts/drive.ts: the worktree's recorded default pointer
 * (.vean/worktree.json defaultProject) → this checkout. Runs `vean preview` in the
 * foreground (live Vite + HMR of THIS worktree's viewer) and forwards signals so the
 * app's stop button tears the whole chain down.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const CLI = join(REPO, "src", "cli.ts");

/** launch.json's configured port — keep in sync with .claude/launch.json. Deliberately
 *  distinct from vean's other well-known ports (5174 = `vean open --view browser`,
 *  5175 = the viewer's standalone Vite default) so the desktop preview coexists with
 *  a running `vean open` instead of tripping autoPort on every launch. */
const DEFAULT_PORT = 5176;

function launchPort(): number {
  const envPort = Number.parseInt(process.env.PORT ?? "", 10);
  return Number.isInteger(envPort) && envPort > 0 && envPort <= 65_535 ? envPort : DEFAULT_PORT;
}

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

const project = resolve(readDefaultProject() ?? REPO);
const port = launchPort();

const child = Bun.spawn(
  ["bun", CLI, "preview", "--no-open", "--port", String(port), "--repo", project],
  { cwd: project, stdio: ["inherit", "inherit", "inherit"] },
);
const forward = (sig: NodeJS.Signals) => {
  try {
    child.kill(sig);
  } catch {}
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));
process.exit(await child.exited);
