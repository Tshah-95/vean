#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(import.meta.dirname, "../..");
const policyPath = resolve(import.meta.dirname, "media-control-policy.json");

export const mediaClaimControlIds = [
  "nc-live-media",
  "nc-render-fidelity",
  "nc-media-resilience",
  "nc-performance-budget",
  "nc-live-export-semantic-parity",
] as const;
export type MediaClaimControlId = (typeof mediaClaimControlIds)[number];

export const mediaScenarioControlIds = [
  "opaque-alpha-substitution",
  "missing-imagebitmap-close",
  "injected-long-task",
  "wrong-frame-timestamp",
  "lower-third-source",
  "one-frame-offset",
  "export-only-props",
  "asset-resolution",
  "modified-golden",
  "boundary-absence",
] as const;
export type MediaScenarioControlId = (typeof mediaScenarioControlIds)[number];

export const mediaOracleImplementationPaths = [
  "scripts/verify-media.ts",
  "scripts/harness/media-control.ts",
  "scripts/harness/media-control-policy.json",
  "scripts/harness/media-domain-truth.ts",
  "scripts/harness/media-performance-domain-truth.ts",
  "e2e/media/media.spec.ts",
  "e2e/media/product-media.ts",
  "e2e/media/performance-sample.ts",
  "viewer/src/components/FootageStage.tsx",
  "viewer/src/decode/parallelDecoder.ts",
  "viewer/src/decode/frameCache.ts",
  "viewer/src/test-bridge/resourceLedger.ts",
  "viewer/src/main.tsx",
  "scripts/media-fixtures.ts",
  "scripts/media-goldens.ts",
  "scripts/media-render-truth.ts",
] as const;

type MediaControlPolicy = {
  contract_version: "1.0.0";
  active_control: MediaScenarioControlId | null;
  claim_controls: Record<MediaClaimControlId, MediaScenarioControlId>;
};

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parsePolicy(contents: string): MediaControlPolicy {
  const policy = JSON.parse(contents) as Partial<MediaControlPolicy>;
  if (policy.contract_version !== "1.0.0" || typeof policy.claim_controls !== "object") {
    throw new Error("invalid media control policy");
  }
  for (const id of mediaClaimControlIds) {
    if (!mediaScenarioControlIds.includes(policy.claim_controls[id])) {
      throw new Error(`media control ${id} has no canonical scenario mapping`);
    }
  }
  if (
    policy.active_control !== null &&
    !mediaScenarioControlIds.includes(policy.active_control as MediaScenarioControlId)
  ) {
    throw new Error("media control policy has an unknown active control");
  }
  return policy as MediaControlPolicy;
}

export function isMediaClaimControlId(value: string): value is MediaClaimControlId {
  return mediaClaimControlIds.includes(value as MediaClaimControlId);
}

export function activeMediaScenarioControl(): MediaScenarioControlId | null {
  return parsePolicy(readFileSync(policyPath, "utf8")).active_control;
}

export function prepareMediaControl(controlId: MediaClaimControlId, requireBaseline = true) {
  const source = readFileSync(policyPath, "utf8");
  const current = parsePolicy(source);
  if (requireBaseline && current.active_control !== null) {
    throw new Error(`${controlId} baseline media control policy is not inactive`);
  }
  const baselinePolicy =
    current.active_control === null ? current : { ...current, active_control: null };
  const mutatedPolicy = {
    ...baselinePolicy,
    active_control: baselinePolicy.claim_controls[controlId],
  };
  const before = `${JSON.stringify(baselinePolicy, null, 2)}\n`;
  const mutated = `${JSON.stringify(mutatedPolicy, null, 2)}\n`;
  if (before === mutated) throw new Error(`${controlId} media control mutation was a no-op`);

  const root = resolve(repo, ".vean/harness/controls", controlId);
  const beforeSnapshot = resolve(root, "media-control-policy.before.json");
  const mutatedSnapshot = resolve(root, "media-control-policy.mutated.json");
  const manifestPath = resolve(root, "mutation.json");
  mkdirSync(root, { recursive: true });
  writeFileSync(beforeSnapshot, before);
  writeFileSync(mutatedSnapshot, mutated);
  const beforeHash = hash(beforeSnapshot);
  const mutatedHash = hash(mutatedSnapshot);
  const changedPaths = [
    {
      path: relative(root, policyPath),
      before_snapshot_path: relative(root, beforeSnapshot),
      mutated_snapshot_path: relative(root, mutatedSnapshot),
      before_hash: beforeHash,
      mutated_hash: mutatedHash,
      restored_hash: beforeHash,
    },
  ];
  if (controlId === "nc-media-resilience") {
    const cachePath = resolve(repo, "viewer/src/decode/frameCache.ts");
    const cacheBeforeSnapshot = resolve(root, "frameCache.before.ts");
    const cacheMutatedSnapshot = resolve(root, "frameCache.mutated.ts");
    const cacheBefore =
      !requireBaseline && existsSync(cacheBeforeSnapshot)
        ? readFileSync(cacheBeforeSnapshot, "utf8")
        : readFileSync(cachePath, "utf8");
    const cleanup = `    for (const e of this.cache.values()) {\n      e.bitmap.close();\n      this.ledger?.close("image-bitmap", e.key);\n    }`;
    if (!cacheBefore.includes(cleanup))
      throw new Error(
        "nc-media-resilience could not find the real FrameCache.clear cleanup branch",
      );
    const cacheAfter = cacheBefore.replace(
      cleanup,
      "    // nc-media-resilience: the real cache clear branch intentionally omits\n    // ImageBitmap.close and ownership-ledger close. The product runner must fail.",
    );
    writeFileSync(cacheBeforeSnapshot, cacheBefore);
    writeFileSync(cacheMutatedSnapshot, cacheAfter);
    const cacheBeforeHash = hash(cacheBeforeSnapshot);
    const cacheMutatedHash = hash(cacheMutatedSnapshot);
    changedPaths.push({
      path: relative(root, cachePath),
      before_snapshot_path: relative(root, cacheBeforeSnapshot),
      mutated_snapshot_path: relative(root, cacheMutatedSnapshot),
      before_hash: cacheBeforeHash,
      mutated_hash: cacheMutatedHash,
      restored_hash: cacheBeforeHash,
    });
  }
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        contract_version: "1.0.0",
        control_id: controlId,
        before_hash: beforeHash,
        mutated_hash: mutatedHash,
        scenario_control: mutatedPolicy.active_control,
        semantic_mutation: `activate the ${mutatedPolicy.active_control} media scenario control`,
        changed_paths: changedPaths,
      },
      null,
      2,
    )}\n`,
  );
  return {
    control_id: controlId,
    scenario_control: mutatedPolicy.active_control,
    target: policyPath,
    manifestPath,
    before_hash: beforeHash,
    mutated_hash: mutatedHash,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controlId = process.argv[2];
  if (!controlId || !isMediaClaimControlId(controlId)) {
    throw new Error("media claim control id required");
  }
  console.log(
    JSON.stringify(prepareMediaControl(controlId, !process.argv.includes("--allow-mutated"))),
  );
}
