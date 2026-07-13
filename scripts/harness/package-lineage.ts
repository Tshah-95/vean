import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson, canonicalSha256 } from "./package-json";

export class PackageLineageError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "PackageLineageError";
  }
}

export type RuntimeManifest = {
  schema_version: "vean.runtime-manifest/1";
  source_sha: string;
  runtime_mode: "package";
  h07: Record<string, string>;
  required_closure_policy_sha256: string;
  resources: Array<Record<string, unknown>>;
};

export type AppReceipt = {
  schema_version: "vean.app-receipt/1";
  app_name: string;
  app_tree_sha256: string;
  runtime_manifest_sha256: string;
  closure_policy_sha256: string;
  signatures: Array<Record<string, unknown>>;
  signature_kind: "adhoc";
};

export type DistributionReceipt = {
  schema_version: "vean.distribution-receipt/1";
  candidate_id?: string;
  dmg_name: string;
  dmg_sha256: string;
  app_receipt_sha256: string;
  runtime_manifest_sha256: string;
  closure_policy_sha256: string;
  h07_sha256: string;
  lineage_test_sha256: string;
  mutation_policy_sha256: string;
};

export function candidateId(receipt: DistributionReceipt): string {
  const { candidate_id: _candidateId, ...without } = receipt;
  return canonicalSha256(without);
}

export function verifyLineageDocuments(input: {
  runtime: RuntimeManifest;
  runtimeBytes: string;
  app: AppReceipt;
  appBytes: string;
  distribution: DistributionReceipt;
  dmgSha256: string;
  expectedH07Sha256: string;
}): void {
  const runtimeHash = createHash("sha256").update(input.runtimeBytes).digest("hex");
  const appHash = createHash("sha256").update(input.appBytes).digest("hex");
  if (input.runtime.resources.some((entry) => entry.relative_path === "runtime-manifest.json")) {
    throw new PackageLineageError(
      "E_LINEAGE_SELF_REFERENCE",
      "runtime manifest inventories itself",
    );
  }
  if (input.app.runtime_manifest_sha256 !== runtimeHash) {
    throw new PackageLineageError(
      "E_LINEAGE_RUNTIME_PARENT",
      "app receipt runtime parent mismatch",
    );
  }
  if (input.distribution.app_receipt_sha256 !== appHash) {
    throw new PackageLineageError("E_LINEAGE_APP_PARENT", "distribution app parent mismatch");
  }
  if (input.distribution.runtime_manifest_sha256 !== runtimeHash) {
    throw new PackageLineageError(
      "E_LINEAGE_RUNTIME_PARENT",
      "distribution runtime parent mismatch",
    );
  }
  if (input.distribution.dmg_sha256 !== input.dmgSha256) {
    throw new PackageLineageError("E_LINEAGE_DMG_STALE", "DMG bytes differ");
  }
  if (input.distribution.h07_sha256 !== input.expectedH07Sha256) {
    throw new PackageLineageError("E_LINEAGE_H07_PARENT", "H07 identity differs");
  }
  if (
    !input.distribution.candidate_id ||
    input.distribution.candidate_id !== candidateId(input.distribution)
  ) {
    throw new PackageLineageError("E_LINEAGE_CANDIDATE_ID", "candidate id mismatch");
  }
}

export function parseCanonical<T>(path: string): { value: T; bytes: string } {
  const bytes = readFileSync(path, "utf8");
  const value = JSON.parse(bytes) as T;
  if (bytes !== `${canonicalJson(value)}\n`)
    throw new PackageLineageError("E_LINEAGE_NONCANONICAL", path);
  return { value, bytes };
}
