import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../scripts/harness/package-json";
import { verifyDistributionIdentity } from "../scripts/harness/package-lineage-domain-truth";

describe("independent package lineage domain truth", () => {
  it("recomputes candidate identity without importing producer oracles", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../scripts/harness/package-lineage-domain-truth.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/from ["']\.\/package-(?:manifest|lineage|candidate)/);
    const receipt: Record<string, unknown> = {
      schema_version: "vean.distribution-receipt/1",
      dmg_sha256: "1".repeat(64),
    };
    receipt.candidate_id = createHash("sha256").update(canonicalJson(receipt)).digest("hex");
    // Candidate ID omits its own member; the pre-member hash above is exact.
    expect(verifyDistributionIdentity(receipt)).toBe(receipt.candidate_id);
  });

  it("rejects a producer-authored ok field with a stale candidate id", () => {
    expect(() =>
      verifyDistributionIdentity({
        candidate_id: "0".repeat(64),
        ok: true,
        dmg_sha256: "1".repeat(64),
      }),
    ).toThrowError(/E_LINEAGE_CANDIDATE_ID/);
  });
});
