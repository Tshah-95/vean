import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OP_NAMES } from "../src/ops";

const repo = join(import.meta.dirname, "..");
const cli = join(repo, "src", "cli.ts");

function run(args: string[]) {
  return spawnSync("bun", [cli, ...args], {
    cwd: repo,
    env: process.env,
    encoding: "utf8",
  });
}

function json<T>(args: string[]): T {
  const result = run(args);
  if (result.status !== 0) {
    throw new Error(
      `command failed: bun ${cli} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

describe("vean timeline ops", () => {
  it("lists every public op and groups them by category", () => {
    const out = json<{
      operations: Array<{ op: string; category: string; inputSummary: unknown }>;
      groups: Array<{ category: string; ops: string[] }>;
    }>(["timeline", "ops", "list", "--json"]);

    expect(out.operations.map((op) => op.op)).toEqual(OP_NAMES);
    expect(out.operations.some((op) => op.op.startsWith("_"))).toBe(false);
    expect(out.groups.find((group) => group.category === "transition")?.ops).toContain("dissolve");
    expect(out.operations.find((op) => op.op === "gain")?.inputSummary).toBeDefined();
  });

  it("describes aliases with their canonical operation and examples", () => {
    const described = json<{
      canonicalOp: string;
      resolvedFrom: string;
      descriptor: { op: string; aliases: string[]; inputSummary: unknown };
    }>(["timeline", "ops", "describe", "crossfade", "--json"]);
    expect(described.canonicalOp).toBe("dissolve");
    expect(described.resolvedFrom).toBe("crossfade");
    expect(described.descriptor.op).toBe("dissolve");
    expect(described.descriptor.aliases).toContain("crossfade");
    expect(described.descriptor.inputSummary).toBeDefined();

    const examples = json<{ canonicalOp: string; resolvedFrom: string; examples: unknown[] }>([
      "timeline",
      "ops",
      "examples",
      "volume",
      "--json",
    ]);
    expect(examples).toMatchObject({ canonicalOp: "gain", resolvedFrom: "volume" });
    expect(examples.examples.length).toBeGreaterThan(0);
  });

  it("does not expose internal inverse ops through discovery or execution edges", () => {
    const search = json<{ results: unknown[] }>(["discover", "_unlift", "--kind", "op", "--json"]);
    expect(search.results).toEqual([]);

    const described = run(["timeline", "ops", "describe", "_unlift", "--json"]);
    expect(described.status).not.toBe(0);
    expect(JSON.parse(described.stdout)).toMatchObject({
      ok: false,
      actionId: "timeline.ops.describe",
    });

    const fixture = resolve(repo, "corpus", "vean-multitrack.mlt");
    for (const verb of ["apply-op", "preview-op"]) {
      const result = run(["timeline", verb, fixture, "_unlift", "--args-json", "{}", "--json"]);
      expect(result.status).not.toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        kind: "non-public-op",
      });
    }
  });
});
