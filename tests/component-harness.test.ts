import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareComponentControl } from "../scripts/harness/component-control";

const repo = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(repo, path), "utf8");
const hash = (path: string) => createHash("sha256").update(read(path)).digest("hex");

describe("H03 real-browser component harness contract", () => {
  it("pins the viewer-local Browser Mode stack without upgrading root Vitest", () => {
    const viewer = JSON.parse(read("viewer/package.json"));
    const root = JSON.parse(read("package.json"));
    expect(viewer.dependencies).toMatchObject({
      react: "19.2.7",
      remotion: "4.0.484",
      "@remotion/player": "4.0.484",
    });
    expect(viewer.devDependencies).toMatchObject({
      vitest: "4.1.10",
      "@vitest/browser-playwright": "4.1.10",
      playwright: "1.61.1",
      "vitest-browser-react": "2.2.0",
      "axe-core": "4.12.1",
    });
    expect(root.devDependencies.vitest).toBe("^2.1.0");
  });

  it("hard-codes headless Chromium, loopback strict-port authority, traces, and screenshots", () => {
    const config = read("viewer/vitest.browser.config.ts");
    expect(config).toContain('host: "127.0.0.1"');
    expect(config).toContain("strictPort: true");
    expect(config).toContain("headless: true");
    expect(config).toContain('browser: "chromium"');
    expect(config).toContain('mode: "retain-on-failure"');
    expect(config).toContain("screenshotFailures: true");
    expect(read("vitest.config.ts")).toContain('"viewer/test/**"');
  });

  it("binds all preflight scenarios to the immutable approved product contract", () => {
    const ledger = JSON.parse(read("artifacts/specs/harness-scenarios/component.json"));
    expect(ledger.interaction_contract).toEqual({
      version: "timeline-a11y-v1",
      path: "artifacts/specs/timeline-keyboard-accessibility-contract-v1.md",
      sha256: "90e92872cc4df0dc12705ee560d2e2e5e3a916210c2a2eebb73e2cbd15c9a6d1",
    });
    expect(hash(ledger.interaction_contract.path)).toBe(ledger.interaction_contract.sha256);
    expect(new Set(ledger.scenarios.map((scenario: { id: string }) => scenario.id)).size).toBe(23);
  });

  it.each(["nc-react-components", "nc-dom-accessibility"] as const)(
    "%s mutates real product source with distinct/restorable hashes",
    (controlId) => {
      const control = prepareComponentControl(controlId);
      expect(control.before_hash).not.toBe(control.mutated_hash);
      const manifest = JSON.parse(readFileSync(control.manifestPath, "utf8"));
      expect(manifest.changed_paths).toHaveLength(1);
      expect(manifest.changed_paths[0].restored_hash).toBe(control.before_hash);
      expect(manifest.semantic_mutation).toBeTruthy();
    },
  );

  it("requires browser reporter coverage and independent SessionStore/.mlt truth", () => {
    const verifier = read("scripts/verify-component.ts");
    for (const needle of [
      "missingBrowserScenarios",
      "SessionStore",
      "serializeSession",
      "fromMlt",
      "beforeHash === afterHash",
      "cleanup.detected.length",
      "PLAYWRIGHT_BROWSERS_PATH",
      "pointer-keyboard-parity-truth.json",
      "browser-pointer-keyboard-parity.json",
      "inverse_restored_exact_ir: true",
      "sourceCorpusUnchanged: true",
      "developerCanaryUnchanged: true",
    ]) {
      expect(verifier).toContain(needle);
    }
    expect(verifier).toContain('["move", "slip", "slide", "trimIn", "trimOut", "roll", "move"]');
  });

  it("records parity through a fixed browser endpoint with no arbitrary file authority", () => {
    const config = read("viewer/vitest.browser.config.ts");
    expect(config).toContain('"/__vean_component_parity"');
    expect(config).toContain('"a11y.timeline.pointer-keyboard-parity"');
    expect(config).toContain('resolve("test-results/component-browser/parity.json")');
    expect(config).not.toContain("body.path");
    expect(config).not.toContain("body.file");
  });
});
