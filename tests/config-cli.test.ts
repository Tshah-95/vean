// `vean config` end-to-end — the storage round-trip the unit test can't cover
// (state modules import bun:sqlite, unavailable in vitest), so this spawns the real
// CLI against a temp repo, exactly like tests/state-cli.test.ts.
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "..");

function run(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync("bun", ["src/cli.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe("vean config CLI", () => {
  it("lists defaults, sets + reads back an override, validates, and unsets", () => {
    const target = mkdtempSync(join(tmpdir(), "vean-config-"));

    // Defaults before any override.
    const before = JSON.parse(run(["config", "list", "--repo", target, "--json"]).stdout) as {
      settings: { key: string; value: unknown; isDefault: boolean }[];
    };
    const autod = before.settings.find((s) => s.key === "fps.autodetect");
    expect(autod).toMatchObject({ value: "confirm", isDefault: true });

    // Set a valid override → persisted + typed.
    expect(run(["config", "set", "fps.autodetect", "auto", "--repo", target]).status).toBe(0);
    expect(run(["config", "set", "fps.vfrTolerance", "0.01", "--repo", target]).status).toBe(0);
    expect(run(["config", "get", "fps.autodetect", "--repo", target]).stdout.trim()).toBe("auto");

    const got = JSON.parse(
      run(["config", "get", "fps.vfrTolerance", "--repo", target, "--json"]).stdout,
    ) as { value: unknown; isDefault: boolean };
    expect(got).toMatchObject({ value: 0.01, isDefault: false }); // a number, not "0.01"

    // Invalid value rejected (non-zero exit, message on stderr).
    const bad = run(["config", "set", "fps.autodetect", "nope", "--repo", target]);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toMatch(/one of/);

    // Unset → back to default.
    expect(run(["config", "unset", "fps.autodetect", "--repo", target]).status).toBe(0);
    expect(run(["config", "get", "fps.autodetect", "--repo", target]).stdout.trim()).toBe(
      "confirm",
    );
  });

  it("rejects an unknown setting key", () => {
    const r = run(["config", "get", "bogus.key"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/unknown setting/);
  });
});
