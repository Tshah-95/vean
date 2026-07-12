import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");

const guidance = {
  agents: read("AGENTS.md"),
  roadmap: read("ROADMAP.md"),
  readme: read("README.md"),
  contributing: read("CONTRIBUTING.md"),
  drive: read(".agents/skills/drive/SKILL.md"),
  view: read(".agents/skills/view/SKILL.md"),
};

const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;

describe("harness guidance drift contract", () => {
  it("binds every documented canonical harness command to the package facade", () => {
    expect(scripts).toMatchObject({
      "verify:harness": "bun scripts/verify-harness.ts",
      drive: "bun scripts/drive.ts",
      "verify:browser": "bun scripts/verify-browser.ts",
      "verify:tauri": "bun scripts/verify-tauri.ts",
      "verify:tauri-release-negative": "bun scripts/verify-tauri-instrumentation.ts",
      "vm:macos:status": "bun scripts/vm/macos-vm.ts status",
      "vm:macos:doctor-guest": "bun scripts/vm/macos-vm.ts doctor-guest",
      "vm:macos:verify-native": "bun scripts/vm/macos-vm.ts verify-native",
      "vm:macos:collect-evidence": "bun scripts/vm/macos-vm.ts collect-evidence",
    });

    for (const command of [
      "bun run verify:harness --profile developer --json",
      "bun run drive verify",
      "bun run verify:tauri --provider auto",
      "bun run verify:tauri-release-negative",
      "bun run vm:macos:status",
      "bun run vm:macos:doctor-guest",
      "bun run vm:macos:verify-native",
      "bun run vm:macos:collect-evidence",
    ]) {
      expect(guidance.contributing, `CONTRIBUTING documents ${command}`).toContain(command);
    }
  });

  it("keeps H04 packaged, Playwright-backed, and headless-only", () => {
    expect(guidance.agents).toContain("packaged H04 runner");
    expect(guidance.readme).toContain("pinned Playwright/Chromium");
    expect(guidance.readme).toContain("dependency in headless mode");
    expect(guidance.contributing).toContain("does not require `agent-browser`");
    expect(guidance.drive).toContain("does not\ndepend on `agent-browser`");
    expect(guidance.drive).toContain("always headless");

    for (const stale of [
      "Headless vs headed is indifferent",
      "pick whichever proves it",
      "computer-use (pixel)",
      "screencapture -v",
    ]) {
      expect(guidance.drive, `drive rejects stale guidance: ${stale}`).not.toContain(stale);
    }
  });

  it("routes native automation exclusively to the hidden Tart guest", () => {
    for (const text of [
      guidance.agents,
      guidance.readme,
      guidance.contributing,
      guidance.drive,
      guidance.view,
    ]) {
      expect(text).toContain("bun run vm:macos:verify-native");
    }
    expect(guidance.contributing).toContain(
      "Never run native UI automation or computer-use against the active host desktop.",
    );
    expect(guidance.view).toContain("This exception is human-only and is never test evidence.");
  });

  it("describes the implemented app without claiming unfinished release work", () => {
    for (const stale of [
      "the future local Tauri Mac app",
      "local Tauri Mac app built on this core (planned)",
      "The local Mac app scaffold lives in `app/`",
      "app/           ← the local Tauri Mac app (Move 4, TBD)",
    ]) {
      expect(
        `${guidance.agents}\n${guidance.readme}`,
        `rejects stale app wording: ${stale}`,
      ).not.toContain(stale);
    }

    expect(guidance.agents).toContain("package/release work remains");
    expect(guidance.readme).toContain("Package,\n> release, and remaining breadth work");
    expect(guidance.contributing).toContain(
      "H07–H10 package and release claims require their own evidence",
    );
    expect(guidance.roadmap).toContain("actions, and the Tauri app.");
    expect(guidance.roadmap).not.toContain("actions, and the future Tauri app.");
  });
});
