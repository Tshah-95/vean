import { describe, expect, it } from "vitest";
import {
  assertStaticGateInventory,
  readStaticPackageScripts,
} from "../scripts/harness/static-gate-contract";
import { staticGateInventory } from "../scripts/verify-fast";

function without(profile: "developer" | "macos", id: string) {
  const inventory = staticGateInventory();
  inventory[profile] = inventory[profile].filter((gate) => gate.id !== id);
  return inventory;
}

describe("fixed static gate inventory", () => {
  it("accepts the canonical implementation inventory", () => {
    expect(() => assertStaticGateInventory(staticGateInventory())).not.toThrow();
  });

  for (const [profile, id] of [
    ["developer", "viewer-typecheck"],
    ["developer", "remotion-typecheck"],
    ["developer", "rustfmt"],
    ["developer", "rust-check-host"],
    ["developer", "rust-clippy-host"],
    ["developer", "rust-test-host"],
    ["macos", "rust-check-macos"],
    ["macos", "rust-clippy-macos"],
    ["macos", "rust-test-macos"],
  ] as const) {
    it(`rejects removal of ${profile}:${id}`, () => {
      expect(() => assertStaticGateInventory(without(profile, id))).toThrow(
        `E_STATIC_GATE_MISSING:${profile}:${id}`,
      );
    });
  }

  it("rejects substitution of a required gate command", () => {
    const inventory = staticGateInventory();
    const gate = inventory.macos.find((candidate) => candidate.id === "rust-clippy-macos");
    if (!gate) throw new Error("fixture gate missing");
    gate.command = "true";
    expect(() => assertStaticGateInventory(inventory)).toThrow(
      "E_STATIC_GATE_COMMAND:macos:rust-clippy-macos",
    );
  });

  for (const name of ["rust:check:macos", "rust:clippy:macos", "rust:test:macos"] as const) {
    it(`rejects a no-op package script substitution for ${name}`, () => {
      const scripts = structuredClone(readStaticPackageScripts());
      const rootScripts = scripts["package.json"];
      if (!rootScripts) throw new Error("root package scripts missing");
      rootScripts[name] = "true";
      expect(() => assertStaticGateInventory(staticGateInventory(), scripts)).toThrow(
        `E_STATIC_SCRIPT_BODY:package.json:${name}`,
      );
    });
  }

  it("binds nested viewer and Remotion script bodies", () => {
    const scripts = structuredClone(readStaticPackageScripts());
    const viewerScripts = scripts["viewer/package.json"];
    const remotionScripts = scripts["remotion/package.json"];
    if (!viewerScripts || !remotionScripts) throw new Error("nested package scripts missing");
    viewerScripts.typecheck = "true";
    expect(() => assertStaticGateInventory(staticGateInventory(), scripts)).toThrow(
      "E_STATIC_SCRIPT_BODY:viewer/package.json:typecheck",
    );
    viewerScripts.typecheck =
      "tsc -p tsconfig.json --noEmit && tsc -p tsconfig.worker.json --noEmit";
    remotionScripts.typecheck = "true";
    expect(() => assertStaticGateInventory(staticGateInventory(), scripts)).toThrow(
      "E_STATIC_SCRIPT_BODY:remotion/package.json:typecheck",
    );
  });
});
