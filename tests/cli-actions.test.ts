import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const cli = join(repo, "src", "cli.ts");

function run(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const result = spawnSync("bun", [cli, ...args], {
    cwd: options.cwd ?? repo,
    env: { ...process.env, ...options.env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed: bun ${cli} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`,
    );
  }
  return result.stdout;
}

function json<T>(args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): T {
  return JSON.parse(run(args, options)) as T;
}

describe("action-backed CLI", () => {
  it("exposes action list/describe/run and resolves an active project", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vean-action-project-"));
    const configHome = mkdtempSync(join(tmpdir(), "vean-action-config-"));
    const neutralCwd = mkdtempSync(join(tmpdir(), "vean-action-cwd-"));
    const env = { VEAN_CONFIG_HOME: configHome };

    const actions = json<Array<{ id: string; mcpAnnotations: { readOnlyHint: boolean } }>>(
      ["action", "list", "--json"],
      { env },
    );
    expect(actions.map((action) => action.id)).toContain("project.use");
    expect(
      actions.find((action) => action.id === "state.status")?.mcpAnnotations.readOnlyHint,
    ).toBe(true);

    const project = json<{ id: string; rootPath: string }>(
      ["project", "init", "--repo", projectRoot, "--json"],
      { env },
    );
    expect(project.rootPath).toBe(projectRoot);

    const current = json<{ project: { rootPath: string; source: string } }>(
      ["--cwd", neutralCwd, "project", "current", "--json"],
      { env },
    );
    expect(current.project.rootPath).toBe(projectRoot);
    expect(current.project.source).toBe("active");

    const envelope = json<{
      ok: true;
      actionId: string;
      project: { rootPath: string; source: string };
      output: { exists: boolean; dbPath: string };
    }>(["--cwd", neutralCwd, "action", "run", "state.status", "--input-json", "{}"], { env });
    expect(envelope.ok).toBe(true);
    expect(envelope.actionId).toBe("state.status");
    expect(envelope.project.rootPath).toBe(projectRoot);
    expect(envelope.project.source).toBe("active");
    expect(envelope.output.exists).toBe(true);

    const known = json<{ projects: Array<{ id: string; rootPath: string }> }>(
      ["project", "list", "--json"],
      { env },
    );
    expect(known.projects).toContainEqual(
      expect.objectContaining({ id: project.id, rootPath: projectRoot }),
    );
  });

  it("runs timeline actions through Commander without diagnostic flooding", () => {
    const fixture = resolve(repo, "corpus", "vean-multitrack.mlt");
    const preview = json<{
      ok: true;
      consequences: { clipsTrimmed: unknown[] };
      inverse: unknown;
      touchedUris: string[];
      health?: unknown;
      diagnostics?: unknown;
    }>([
      "timeline",
      "preview-op",
      fixture,
      "gain",
      "--args-json",
      '{"uuid":"clip-5","db":-6}',
      "--json",
    ]);
    expect(preview.ok).toBe(true);
    expect(preview.consequences.clipsTrimmed.length).toBeGreaterThan(0);
    expect(preview.inverse).toBeDefined();
    expect(preview.touchedUris).toContain(fixture);
    expect(preview.health).toBeUndefined();
    expect(preview.diagnostics).toBeUndefined();
  });
});
