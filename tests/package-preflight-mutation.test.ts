import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type H07Lineage,
  generateRequiredClosurePolicy,
  verifyRequiredClosurePolicy,
} from "../scripts/harness/required-closure-policy";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const h07: H07Lineage = {
  fixture_manifest_sha256: "1".repeat(64),
  semantic_oracle_version: "1",
  semantic_oracle_sha256: "2".repeat(64),
  runtime_matrix_sha256: "3".repeat(64),
  expected_output_set_sha256: "4".repeat(64),
};

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "vean-package-mutant-"));
  roots.push(root);
  for (const path of [
    "core/vean-core.txt",
    "viewer/dist/index.html",
    "drizzle/0000.sql",
    "skills/catalog.json",
    "sidecars/share/mlt/profile",
    "node/LICENSE",
    "remotion/src/index.ts",
    "browser/resources.pak",
    "compliance/SPDX.json",
  ]) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, path);
  }
  return root;
}

describe("package preflight adversarial protocol", () => {
  it("runs baseline → one integrity mutation → attributed rejection → restore → baseline for every file", () => {
    const root = fixture();
    const baseline = generateRequiredClosurePolicy(root, "a".repeat(40), h07).policy;
    expect(() => verifyRequiredClosurePolicy(root, baseline)).not.toThrow();
    for (const entry of baseline.entries.filter((entry) => entry.type === "file")) {
      const path = join(root, entry.relative_path);
      const bytes = readFileSync(path);
      writeFileSync(path, Buffer.concat([bytes, Buffer.from("integrity-mutant")]));
      expect(() => verifyRequiredClosurePolicy(root, baseline), entry.relative_path).toThrowError(
        new RegExp(
          `E_CLOSURE_REQUIRED_MISMATCH: ${entry.relative_path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
      writeFileSync(path, bytes);
      expect(() => verifyRequiredClosurePolicy(root, baseline), entry.relative_path).not.toThrow();
    }
  });

  it("keeps fixed policy identity across coherent startup and operation-lazy mutants", () => {
    const root = fixture();
    const baseline = generateRequiredClosurePolicy(root, "a".repeat(40), h07);
    const classes = ["startup-required", "operation-lazy"] as const;
    for (const requirement of classes) {
      const entry = baseline.policy.entries.find(
        (candidate) => candidate.type === "file" && candidate.requirement === requirement,
      );
      if (!entry) throw new Error(`missing ${requirement}`);
      const path = join(root, entry.relative_path);
      const bytes = readFileSync(path);
      rmSync(path);
      expect(() => verifyRequiredClosurePolicy(root, baseline.policy)).toThrowError(
        new RegExp(
          `E_CLOSURE_REQUIRED_MISSING: ${entry.relative_path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        ),
      );
      const coherent = generateRequiredClosurePolicy(root, "a".repeat(40), h07);
      expect(coherent.sha256).not.toBe(baseline.sha256);
      expect(() => readFileSync(path)).toThrow();
      writeFileSync(path, bytes);
      expect(() => verifyRequiredClosurePolicy(root, baseline.policy)).not.toThrow();
    }
  });

  it("uses the external fixed-policy oracle for every distribution-only file", () => {
    const root = fixture();
    const baseline = generateRequiredClosurePolicy(root, "a".repeat(40), h07).policy;
    for (const entry of baseline.entries.filter(
      (candidate) => candidate.type === "file" && candidate.requirement === "distribution-only",
    )) {
      const path = join(root, entry.relative_path);
      const bytes = readFileSync(path);
      rmSync(path);
      expect(() => verifyRequiredClosurePolicy(root, baseline)).toThrowError(
        /E_CLOSURE_REQUIRED_MISSING/,
      );
      writeFileSync(path, bytes);
      expect(() => verifyRequiredClosurePolicy(root, baseline)).not.toThrow();
    }
  });
});
