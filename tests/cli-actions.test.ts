import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
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
    maxBuffer: 10 * 1024 * 1024,
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

  it("keeps old explicit-uri apply-op form and new discovery commands action-backed", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vean-action-parity-project-"));
    const configHome = mkdtempSync(join(tmpdir(), "vean-action-parity-config-"));
    const neutralCwd = mkdtempSync(join(tmpdir(), "vean-action-parity-cwd-"));
    const env = { VEAN_CONFIG_HOME: configHome };
    const fixture = resolve(repo, "corpus", "vean-multitrack.mlt");
    const doc = join(projectRoot, "main.mlt");
    cpSync(fixture, doc);

    json(["project", "init", "--repo", projectRoot, "--json"], { env });

    const applied = json<{
      ok: true;
      invocation: { op: string };
      touchedUris: string[];
      health?: unknown;
      diagnostics?: unknown;
    }>(
      ["timeline", "apply-op", doc, "gain", "--args-json", '{"uuid":"clip-5","db":-6}', "--json"],
      { env },
    );
    expect(applied.ok).toBe(true);
    expect(applied.invocation.op).toBe("gain");
    expect(applied.touchedUris).toEqual([doc]);
    expect(applied.health).toBeUndefined();
    expect(applied.diagnostics).toBeUndefined();

    const discoverCli = json<{ results: Array<{ canonicalOp?: string }> }>(
      ["discover", "duck audio", "--kind", "op", "--json"],
      { env },
    );
    const discoverAction = json<{
      ok: true;
      output: { results: Array<{ canonicalOp?: string }> };
    }>(
      [
        "action",
        "run",
        "discover.search",
        "--input-json",
        '{"query":"duck audio","kind":"op","limit":10}',
      ],
      { env },
    );
    expect(discoverCli.results.map((result) => result.canonicalOp)).toEqual(
      discoverAction.output.results.map((result) => result.canonicalOp),
    );

    const opsCli = json<{ operations: Array<{ op: string }> }>(
      ["timeline", "ops", "list", "--json"],
      { env },
    );
    const opsAction = json<{ ok: true; output: { operations: Array<{ op: string }> } }>(
      ["action", "run", "timeline.ops.list", "--input-json", "{}"],
      { env },
    );
    expect(opsCli.operations.map((op) => op.op)).toEqual(
      opsAction.output.operations.map((op) => op.op),
    );

    const useCli = json<{ activeTimeline: { resolvedPath: string } }>(
      ["--cwd", neutralCwd, "timeline", "use", doc, "--json"],
      { env },
    );
    const currentCli = json<{ activeTimeline: { resolvedPath: string } }>(
      ["--cwd", neutralCwd, "timeline", "current", "--json"],
      { env },
    );
    const currentAction = json<{
      ok: true;
      output: { activeTimeline: { resolvedPath: string } };
    }>(["--cwd", neutralCwd, "action", "run", "timeline.current", "--input-json", "{}"], {
      env,
    });
    expect(useCli.activeTimeline.resolvedPath).toBe(doc);
    expect(currentCli.activeTimeline.resolvedPath).toBe(doc);
    expect(currentAction.output.activeTimeline.resolvedPath).toBe(doc);
  });
});
