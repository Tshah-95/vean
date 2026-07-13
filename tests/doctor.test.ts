import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("audits a consumer project without treating it as the VEAN runtime checkout", async () => {
    const project = mkdtempSync(resolve(tmpdir(), "vean-doctor-consumer-"));
    writeFileSync(resolve(project, ".gitignore"), ".vean/\n");
    try {
      const report = await runDoctor({
        repo: project,
        host: "codex",
        surface: "cli",
        probe: false,
      });
      expect(report.ok).toBe(true);
      expect(report.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "project:root", status: "pass", detail: project }),
          expect.objectContaining({ name: "runtime:root", status: "pass", detail: repo }),
          expect.objectContaining({ name: "state:db", status: "warn" }),
          expect.objectContaining({ name: "cli:path", status: "pass" }),
        ]),
      );
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  });
});
