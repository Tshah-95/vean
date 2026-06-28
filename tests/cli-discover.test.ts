import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const cli = join(repo, "src", "cli.ts");

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bun", [cli, ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

function json<T>(args: string[], env: NodeJS.ProcessEnv = {}): T {
  const result = run(args, env);
  if (result.status !== 0) {
    throw new Error(
      `command failed: bun ${cli} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

describe("vean discover", () => {
  it("returns a structured manifest", () => {
    const manifest = json<{
      project: unknown;
      activeTimeline: unknown;
      actions: Array<{ id: string }>;
      commands: Array<{ command: string }>;
      opFamilies: Array<{ category: string; ops: string[] }>;
      routes: Array<{ namespace: string }>;
      next: string[];
    }>(["discover", "--json"]);

    expect(manifest.commands.map((command) => command.command)).toContain("timeline ops list");
    expect(manifest.actions.map((action) => action.id)).toContain("discover.search");
    expect(manifest.opFamilies.flatMap((family) => family.ops)).toContain("dissolve");
    expect(manifest.routes.map((route) => route.namespace)).toContain("timeline");
    expect(manifest.next).toContain("vean timeline ops list --json");
  });

  it("maps golden prompts to canonical op results with stable shape", () => {
    const cases: Array<[string, string]> = [
      ["crossfade clips", "dissolve"],
      ["delete but leave a gap", "lift"],
      ["ripple delete", "remove"],
      ["duck audio", "gain"],
      ["trim tail shorter", "trimOut"],
    ];

    for (const [query, op] of cases) {
      const search = json<{ results: Array<Record<string, unknown>> }>([
        "discover",
        query,
        "--kind",
        "op",
        "--json",
      ]);
      expect(search.results[0]).toMatchObject({
        kind: "op",
        canonicalOp: op,
        title: expect.any(String),
        aliases: expect.any(Array),
        describeCommand: expect.stringContaining("vean timeline ops describe"),
        rank: 1,
        score: expect.any(Number),
        reason: expect.any(String),
      });
    }
  });

  it("is deterministic and supports kind/limit plus route namespace results", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vean-discover-project-"));
    const configHome = mkdtempSync(join(tmpdir(), "vean-discover-config-"));
    const env = { VEAN_CONFIG_HOME: configHome };
    json(["project", "init", "--repo", projectRoot, "--json"], env);
    json(
      ["route", "set", "timeline:main", "timeline/main.mlt", "--repo", projectRoot, "--json"],
      env,
    );

    const first = json<{ results: Array<{ kind: string; canonicalId?: string }> }>(
      [
        "--project",
        projectRoot,
        "discover",
        "timeline",
        "--kind",
        "route",
        "--limit",
        "1",
        "--json",
      ],
      env,
    );
    const second = json<typeof first>(
      [
        "--project",
        projectRoot,
        "discover",
        "timeline",
        "--kind",
        "route",
        "--limit",
        "1",
        "--json",
      ],
      env,
    );
    expect(second).toEqual(first);
    expect(first.results).toHaveLength(1);
    expect(first.results[0]).toMatchObject({ kind: "route", canonicalId: "timeline:main" });
  });

  it("disambiguates bare delete instead of picking one mutating op", () => {
    const search = json<{ ambiguous: boolean; results: Array<{ canonicalOp?: string }> }>([
      "discover",
      "delete",
      "--kind",
      "op",
      "--json",
    ]);
    expect(search.ambiguous).toBe(true);
    expect(search.results.map((result) => result.canonicalOp)).toEqual(
      expect.arrayContaining(["lift", "remove"]),
    );
  });

  it("emits parseable JSON failures for invalid search inputs", () => {
    for (const args of [
      ["discover", " ", "--json"],
      ["discover", "x", "--kind", "bogus", "--json"],
      ["discover", "x", "--limit", "0", "--json"],
      ["discover", "x", "--limit", "-1", "--json"],
      ["discover", "x", "--limit", "abc", "--json"],
      ["discover", "x", "--limit", "51", "--json"],
    ]) {
      const result = run(args);
      expect(result.status).not.toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: false; kind: string; detail: string };
      expect(parsed.ok).toBe(false);
      expect(parsed.kind).toBeDefined();
      expect(parsed.detail).toBeDefined();
    }
  });
});
