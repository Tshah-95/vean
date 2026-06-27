import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Tauri app scaffold harness", () => {
  it("verifies scaffold, capabilities, and action registry linkage", () => {
    const result = spawnSync("bun", ["scripts/app-doctor.ts", "--json"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      checks: Array<{ name: string; status: string }>;
    };
    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "tauri:config", status: "pass" }),
    );
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: "actions:registry", status: "pass" }),
    );
  });
});
