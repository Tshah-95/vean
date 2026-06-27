import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const configHome = mkdtempSync(join(tmpdir(), "vean-state-config-"));

function run(args: string[], cwd = repo) {
  const result = spawnSync("bun", ["src/cli.ts", ...args], {
    cwd,
    env: { ...process.env, VEAN_CONFIG_HOME: configHome },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed: bun src/cli.ts ${args.join(" ")}\n${result.stderr}\n${result.stdout}`,
    );
  }
  return result.stdout;
}

function json<T>(args: string[]): T {
  return JSON.parse(run(args)) as T;
}

describe("vean local state CLI", () => {
  it("initializes .vean/vean.db with migrations and WAL enabled", () => {
    const target = mkdtempSync(join(tmpdir(), "vean-state-"));
    const before = json<{ exists: boolean; migrationsApplied: number }>([
      "state",
      "status",
      "--repo",
      target,
      "--json",
    ]);
    expect(before.exists).toBe(false);
    expect(before.migrationsApplied).toBe(0);

    const after = json<{
      exists: boolean;
      migrationsApplied: number;
      journalMode?: string;
      busyTimeoutMs?: number;
    }>(["state", "init", "--repo", target, "--json"]);
    expect(after.exists).toBe(true);
    expect(after.migrationsApplied).toBe(1);
    expect(after.journalMode).toBe("wal");
    expect(after.busyTimeoutMs).toBe(5000);
  });

  it("registers a project and runs a leased job lifecycle", () => {
    const target = mkdtempSync(join(tmpdir(), "vean-project-"));
    const project = json<{ rootPath: string }>(["project", "init", "--repo", target, "--json"]);
    expect(project.rootPath).toBe(target);

    const queued = json<{ id: string; status: string; kind: string }>([
      "jobs",
      "enqueue",
      "render",
      "--repo",
      target,
      "--payload-json",
      '{"timeline":"doc.mlt"}',
      "--json",
    ]);
    expect(queued.kind).toBe("render");
    expect(queued.status).toBe("queued");

    const claimed = json<{ id: string; status: string; lockedBy: string }>([
      "jobs",
      "claim",
      "--repo",
      target,
      "--worker",
      "test-worker",
      "--json",
    ]);
    expect(claimed.id).toBe(queued.id);
    expect(claimed.status).toBe("running");
    expect(claimed.lockedBy).toBe("test-worker");

    const none = json<null>([
      "jobs",
      "claim",
      "--repo",
      target,
      "--worker",
      "other-worker",
      "--json",
    ]);
    expect(none).toBeNull();

    const done = json<{ id: string; status: string }>([
      "jobs",
      "complete",
      queued.id,
      "--repo",
      target,
      "--result-json",
      '{"ok":true}',
      "--json",
    ]);
    expect(done.status).toBe("done");
  });
});
