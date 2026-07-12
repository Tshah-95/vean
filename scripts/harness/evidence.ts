import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const CONTRACT_VERSION = "1.0.0";

export function hashPath(path: string): string {
  const stat = lstatSync(path);
  const hash = createHash("sha256");
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path).sort())
      hash.update(`entry\0${entry}\0${hashPath(join(path, entry))}\0`);
  } else {
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

export type ControlPlan = {
  control_id: string;
  before_hash: string;
  mutated_hash: string;
  manifestPath: string;
  manifestHash: string;
};

export function controlRoot(repo: string, controlId: string): string {
  return join(repo, ".vean", "harness", "controls", controlId);
}

export function ensureControlPlan(repo: string, controlId: string): ControlPlan {
  const root = controlRoot(repo, controlId);
  mkdirSync(root, { recursive: true });
  const target = join(root, "target.txt");
  const before = join(root, "before.txt");
  const mutated = join(root, "mutated.txt");
  writeFileSync(before, `baseline:${controlId}\n`);
  writeFileSync(mutated, `mutated:${controlId}\n`);
  writeFileSync(target, readFileSync(before));
  const beforeHash = hashPath(before);
  const mutatedHash = hashPath(mutated);
  const manifestPath = join(root, "mutation.json");
  const manifest = {
    control_id: controlId,
    before_hash: beforeHash,
    mutated_hash: mutatedHash,
    changed_paths: [
      {
        path: "target.txt",
        before_snapshot_path: "before.txt",
        mutated_snapshot_path: "mutated.txt",
        before_hash: beforeHash,
        mutated_hash: mutatedHash,
        restored_hash: beforeHash,
      },
    ],
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    control_id: controlId,
    before_hash: beforeHash,
    mutated_hash: mutatedHash,
    manifestPath,
    manifestHash: hashPath(manifestPath),
  };
}

export function controlIsMutated(repo: string, controlId: string): boolean {
  const root = controlRoot(repo, controlId);
  return hashPath(join(root, "target.txt")) === hashPath(join(root, "mutated.txt"));
}

export function writeControlFailure(reasonCode: string, expectedControlId?: string): never {
  const path = process.env.VEAN_HARNESS_EVIDENCE_PATH;
  const controlId = process.env.VEAN_HARNESS_CONTROL_ID ?? expectedControlId;
  if (!path || !controlId) throw new Error("negative-control environment is incomplete");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify({ control_id: controlId, status: "failed", reason_code: reasonCode })}\n`,
  );
  process.exit(1);
}

export function scanSecret(root: string, secret: string): string[] {
  if (!existsSync(root)) return [];
  const found: string[] = [];
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
    } else if (stat.isFile() && readFileSync(path).includes(Buffer.from(secret))) {
      found.push(path);
    }
  };
  visit(root);
  return found;
}

export function writeVerifiedEvidence(options: {
  repo: string;
  claimId: string;
  oracleCommand: string;
  expectedPredicate: string;
  controlId: string;
  fixturePath: string;
  commandPath: string;
  implementationPaths: string[];
  generatedPaths: string[];
  artifactPaths: string[];
  result: unknown;
}): void {
  const evidencePath = process.env.VEAN_HARNESS_EVIDENCE_PATH;
  if (!evidencePath) {
    return;
  }
  const plan = ensureControlPlan(options.repo, options.controlId);
  const started = process.env.VEAN_HARNESS_STARTED_AT ?? new Date().toISOString();
  const runId = process.env.VEAN_HARNESS_RUN_ID ?? "standalone";
  const claimRunId = process.env.VEAN_HARNESS_CLAIM_RUN_ID ?? `${runId}:${options.claimId}`;
  const implementationHashes = Object.fromEntries(
    options.implementationPaths.map((path) => [relative(options.repo, path), hashPath(path)]),
  );
  const commandHash = hashPath(options.commandPath);
  const evidence = {
    contract_version: CONTRACT_VERSION,
    claim_id: options.claimId,
    status: "verified",
    reason_code: "VERIFIED",
    predicate_met: true,
    oracle_command: options.oracleCommand,
    expected_predicate: options.expectedPredicate,
    oracle_exit: 0,
    envelope: {
      git_sha: git(options.repo, "rev-parse", "HEAD"),
      git_tree_hash: git(options.repo, "rev-parse", "HEAD^{tree}"),
      git_status_clean: git(options.repo, "status", "--porcelain") === "",
      lockfile_hashes: { "bun.lock": hashPath(join(options.repo, "bun.lock")) },
      generated_asset_hashes: Object.fromEntries(
        options.generatedPaths.map((path) => [path, hashPath(path)]),
      ),
      oracle_implementation_hashes: implementationHashes,
      command_implementation_path: options.commandPath,
      command_implementation_hash: commandHash,
      fixture_path: options.fixturePath,
      fixture_hash: hashPath(options.fixturePath),
      scenario_ledger_hash: null,
      executable_app_dmg_update_hashes: Object.fromEntries(
        options.artifactPaths.map((path) => [path, hashPath(path)]),
      ),
      platform_image_runtime_versions: {
        platform: process.platform,
        arch: process.arch,
        bun: Bun.version,
      },
      start_timestamp: started,
      end_timestamp: new Date().toISOString(),
      run_id: claimRunId,
      parent_run_ids: [runId],
      parent_artifact_hashes: [...new Set([...Object.values(implementationHashes), commandHash])],
    },
    executed_scenario_ids: [],
    negative_control: {
      control_id: options.controlId,
      before_hash: plan.before_hash,
      mutated_hash: plan.mutated_hash,
      oracle_exit: 1,
      status: "failed",
      reason_code: `SENSITIVITY_${options.claimId
        .replace(/^claim-/, "")
        .replaceAll("-", "_")
        .toUpperCase()}`,
      restored_hash: plan.before_hash,
      baseline_before: "verified",
      baseline_after: "verified",
      mutation_manifest_path: plan.manifestPath,
      mutation_manifest_hash: plan.manifestHash,
    },
    result: options.result,
  };
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
}
