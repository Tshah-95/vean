import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/cli/doctor";

const repo = resolve(import.meta.dirname, "..");

describe("vean doctor", () => {
  it("uses a portable POSIX shell for PATH resolution", () => {
    const source = readFileSync(resolve(repo, "src/cli/doctor.ts"), "utf8");
    expect(source).not.toContain('spawnSync("zsh"');
    expect(source).toContain('spawnSync("sh"');
  });

  it("validates Codex resolver and setup skill wiring without stdio probes", async () => {
    const report = await runDoctor({ repo, host: "codex", probe: false });
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "skill:skills/setup/SKILL.md",
          status: "pass",
        }),
        expect.objectContaining({
          name: "skill:skills/editing/SKILL.md",
          status: "pass",
        }),
        expect.objectContaining({
          name: "codex:resolver",
          status: "pass",
        }),
      ]),
    );
  });

  it("emits machine-readable JSON from the Commander CLI", () => {
    const result = spawnSync(
      "bun",
      ["src/cli.ts", "doctor", "--host", "codex", "--surface", "lsp", "--no-probe", "--json"],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { ok: boolean };
    expect(report.ok).toBe(true);
  });
});
