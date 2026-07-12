import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "..");

describe("production webview policy candidate", () => {
  it("passes its bounded release-mode server/source-config gate", () => {
    const candidate = spawnSync(
      "bun",
      ["scripts/verify-webview-policy.ts", "--profile", "release"],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
    expect(candidate.status).toBe(0);
    const report = JSON.parse(candidate.stdout.trim().split("\n").at(-1) ?? "{}");
    expect(report.ok).toBe(true);
    expect(report.tauriCspNonNull).toBe(true);
    expect(report.tauriNavigationPolicyInstalled).toBe(true);
    expect(report.mutationWithoutAuthorityStatus).toBe(403);
    expect(report.navigation).toEqual({
      exactLoopback: true,
      external: false,
      localhostAlias: false,
      dnsRebinding: false,
    });
  });
});
