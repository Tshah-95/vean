#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

export const EVALUATOR_CONTRACT_VERSION = "1.0.0";

const REQUIRED_PROFILE_HIERARCHY: Record<string, string | null> = {
  developer: null,
  macos: "developer",
  "release-candidate": "macos",
  release: "release-candidate",
};

type JsonObject = Record<string, unknown>;

type HarnessIssue = {
  code: string;
  detail: string;
  claimId?: string;
  path?: string;
};

type Claim = {
  claim_id: string;
  oracle_command: string;
  expected_predicate: string;
  canonical_artifact_paths: string[];
  oracle_implementation_paths: string[];
  scenario_manifest?: string | null;
  negative_control: {
    control_id: string;
    setup_command: string;
    cleanup_command: string;
    expected_oracle_exit: number;
    expected_status: string;
    expected_reason_code: string;
  };
};

type Profile = {
  contract_version: string;
  inherits?: string;
  required_claims: string[];
  implicit_skips_allowed: boolean;
};

type TruthManifest = {
  program: string;
  contract_version: string;
  evidence_envelope_required_fields: string[];
  aggregate_profiles: Record<string, Profile>;
  claims: Claim[];
};

type EvidenceEnvelope = {
  git_sha: string;
  git_tree_hash: string;
  git_status_clean: boolean;
  lockfile_hashes: Record<string, string>;
  generated_asset_hashes: Record<string, string>;
  oracle_implementation_hashes: Record<string, string>;
  command_implementation_path: string;
  command_implementation_hash: string;
  fixture_path: string;
  fixture_hash: string;
  scenario_ledger_hash: string | null;
  executable_app_dmg_update_hashes: Record<string, string>;
  platform_image_runtime_versions: JsonObject;
  start_timestamp: string;
  end_timestamp: string;
  run_id: string;
  parent_run_ids: string[];
  parent_artifact_hashes: string[];
};

type ClaimEvidence = {
  contract_version: string;
  claim_id: string;
  status: string;
  reason_code: string;
  predicate_met: boolean;
  oracle_command: string;
  expected_predicate: string;
  oracle_exit: number;
  envelope: EvidenceEnvelope;
  executed_scenario_ids?: string[];
  negative_control: {
    control_id: string;
    before_hash: string;
    mutated_hash: string;
    oracle_exit: number;
    status: string;
    reason_code: string;
    restored_hash: string;
    baseline_before: string;
    baseline_after: string;
    mutation_manifest_path: string;
    mutation_manifest_hash: string;
  };
};

const evidenceEnvelopeSchema = z.object({
  git_sha: z.string().min(1),
  git_tree_hash: z.string().min(1),
  git_status_clean: z.boolean(),
  lockfile_hashes: z.record(z.string()),
  generated_asset_hashes: z.record(z.string()),
  oracle_implementation_hashes: z.record(z.string()),
  command_implementation_path: z.string().min(1),
  command_implementation_hash: z.string().min(1),
  fixture_path: z.string().min(1),
  fixture_hash: z.string().min(1),
  scenario_ledger_hash: z.string().min(1).nullable(),
  executable_app_dmg_update_hashes: z.record(z.string()),
  platform_image_runtime_versions: z.record(z.unknown()),
  start_timestamp: z.string().min(1),
  end_timestamp: z.string().min(1),
  run_id: z.string().min(1),
  parent_run_ids: z.array(z.string()),
  parent_artifact_hashes: z.array(z.string()),
});

const claimEvidenceSchema = z.object({
  contract_version: z.string(),
  claim_id: z.string(),
  status: z.string(),
  reason_code: z.string(),
  predicate_met: z.boolean(),
  oracle_command: z.string(),
  expected_predicate: z.string(),
  oracle_exit: z.number().int(),
  envelope: evidenceEnvelopeSchema,
  executed_scenario_ids: z.array(z.string()).optional(),
  negative_control: z.object({
    control_id: z.string(),
    before_hash: z.string(),
    mutated_hash: z.string(),
    oracle_exit: z.number().int(),
    status: z.string(),
    reason_code: z.string(),
    restored_hash: z.string(),
    baseline_before: z.string(),
    baseline_after: z.string(),
    mutation_manifest_path: z.string(),
    mutation_manifest_hash: z.string(),
  }),
});

type OracleInvocation = {
  exit: number | null;
  runId: string;
  claimRunId: string;
  startedAt: string;
  endedAt: string;
  baselineBeforeExit: number | null;
  controlExit: number | null;
  controlStatus: string | null;
  controlReasonCode: string | null;
  cleanupExit: number | null;
};

export type HarnessEvaluationOptions = {
  manifestPath: string;
  evidenceDir: string;
  profile: string;
  repoRoot: string;
  expectedSha?: string;
  expectedTree?: string;
  expectedClean?: boolean;
  now?: string;
  maxAgeMs?: number;
  skipRepoCheck?: boolean;
  runId?: string;
  runOracles?: boolean;
  validationClock?: () => string;
};

export type HarnessEvaluation = {
  ok: boolean;
  program: string;
  profile: string;
  run_id: string;
  evidence_dir: string;
  evaluator_contract_version: string;
  required_claim_ids: string[];
  verified_claim_ids: string[];
  open_claim_ids: string[];
  issues: HarnessIssue[];
};

function sha256(path: string): string {
  const stat = lstatSync(path);
  const digest = createHash("sha256");
  if (stat.isSymbolicLink()) {
    digest.update(`symlink\0${readFileSync(path, "utf8")}`);
    return digest.digest("hex");
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      const child = join(path, entry);
      digest.update(`entry\0${entry}\0${sha256(child)}\0`);
    }
    return digest.digest("hex");
  }
  digest.update(readFileSync(path));
  return digest.digest("hex");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return true;
  return object(value);
}

function git(repoRoot: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function actualRepoIdentity(repoRoot: string): {
  sha: string | null;
  tree: string | null;
  clean: boolean;
} {
  return {
    sha: git(repoRoot, ["rev-parse", "HEAD"]),
    tree: git(repoRoot, ["rev-parse", "HEAD^{tree}"]),
    clean: (git(repoRoot, ["status", "--porcelain"]) ?? "unavailable").length === 0,
  };
}

function parseManifest(raw: unknown): TruthManifest {
  if (!object(raw)) throw new Error("manifest must be an object");
  const profiles = raw.aggregate_profiles;
  const claims = raw.claims;
  const required = raw.evidence_envelope_required_fields;
  if (typeof raw.program !== "string") throw new Error("manifest.program must be a string");
  if (raw.contract_version !== EVALUATOR_CONTRACT_VERSION) {
    throw new Error(`manifest.contract_version must be ${EVALUATOR_CONTRACT_VERSION}`);
  }
  if (!object(profiles)) throw new Error("manifest.aggregate_profiles must be an object");
  const actualProfileNames = Object.keys(profiles).sort();
  const requiredProfileNames = Object.keys(REQUIRED_PROFILE_HIERARCHY).sort();
  if (actualProfileNames.join("\0") !== requiredProfileNames.join("\0")) {
    throw new Error(
      `manifest profiles must be exactly ${requiredProfileNames.join(",")}; got ${actualProfileNames.join(",")}`,
    );
  }
  if (!Array.isArray(claims)) throw new Error("manifest.claims must be an array");
  if (claims.length === 0) throw new Error("manifest.claims must not be empty");
  if (!Array.isArray(required) || !required.every((item) => typeof item === "string")) {
    throw new Error("manifest.evidence_envelope_required_fields must be string[]");
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (
      !object(profile) ||
      profile.contract_version !== EVALUATOR_CONTRACT_VERSION ||
      !Array.isArray(profile.required_claims) ||
      !profile.required_claims.every((id) => typeof id === "string") ||
      profile.required_claims.length === 0
    ) {
      throw new Error(`manifest profile ${name} is invalid or empty`);
    }
    const expectedParent = REQUIRED_PROFILE_HIERARCHY[name];
    const actualParent = typeof profile.inherits === "string" ? profile.inherits : null;
    if (actualParent !== expectedParent) {
      throw new Error(`manifest profile ${name} must inherit ${String(expectedParent)}`);
    }
  }
  for (const claim of claims) {
    if (
      !object(claim) ||
      typeof claim.claim_id !== "string" ||
      typeof claim.oracle_command !== "string" ||
      typeof claim.expected_predicate !== "string" ||
      !Array.isArray(claim.canonical_artifact_paths) ||
      claim.canonical_artifact_paths.length === 0 ||
      !Array.isArray(claim.oracle_implementation_paths) ||
      claim.oracle_implementation_paths.length === 0 ||
      !claim.oracle_implementation_paths.every((path) => typeof path === "string") ||
      !object(claim.negative_control) ||
      typeof claim.negative_control.setup_command !== "string" ||
      typeof claim.negative_control.cleanup_command !== "string"
    ) {
      throw new Error("manifest claim schema is invalid");
    }
  }
  return raw as unknown as TruthManifest;
}

function resolveProfile(
  manifest: TruthManifest,
  name: string,
  issues: HarnessIssue[],
  stack: string[] = [],
): string[] {
  const profile = manifest.aggregate_profiles[name];
  if (!profile) {
    issues.push({ code: "E_PROFILE_UNKNOWN", detail: `unknown profile ${name}` });
    return [];
  }
  if (stack.includes(name)) {
    issues.push({ code: "E_PROFILE_CYCLE", detail: [...stack, name].join(" -> ") });
    return [];
  }
  if (profile.implicit_skips_allowed !== false) {
    issues.push({
      code: "E_PROFILE_IMPLICIT_SKIP",
      detail: `${name} must set implicit_skips_allowed=false`,
    });
  }
  const inherited = profile.inherits
    ? resolveProfile(manifest, profile.inherits, issues, [...stack, name])
    : [];
  return [...new Set([...inherited, ...profile.required_claims])];
}

function validateProfileCoverage(manifest: TruthManifest, issues: HarnessIssue[]): void {
  const claimIds = new Set(manifest.claims.map((claim) => claim.claim_id));
  if (claimIds.size !== manifest.claims.length) {
    issues.push({ code: "E_CLAIM_DUPLICATE", detail: "claim ids must be unique" });
  }
  const covered = new Set<string>();
  for (const name of Object.keys(manifest.aggregate_profiles)) {
    for (const id of resolveProfile(manifest, name, issues)) {
      covered.add(id);
      if (!claimIds.has(id)) {
        issues.push({
          code: "E_PROFILE_CLAIM_UNKNOWN",
          detail: `${name} references unknown claim ${id}`,
          claimId: id,
        });
      }
    }
  }
  for (const id of claimIds) {
    if (!covered.has(id)) {
      issues.push({
        code: "E_PROFILE_COVERAGE",
        detail: `${id} belongs to no profile`,
        claimId: id,
      });
    }
  }
}

function evidencePath(evidenceDir: string, claimId: string): string {
  return join(evidenceDir, "claims", `${claimId}.json`);
}

function validateHashMap(
  map: unknown,
  label: string,
  repoRoot: string,
  claimId: string,
  issues: HarnessIssue[],
): void {
  if (!object(map)) {
    issues.push({ code: "E_HASH_MAP", detail: `${label} must be an object`, claimId });
    return;
  }
  if (Object.keys(map).length === 0) {
    issues.push({ code: "E_HASH_MAP_EMPTY", detail: `${label} must not be empty`, claimId });
    return;
  }
  for (const [rawPath, expected] of Object.entries(map)) {
    if (typeof expected !== "string" || expected.length === 0) {
      issues.push({ code: "E_HASH_VALUE", detail: `${label}.${rawPath} must be sha256`, claimId });
      continue;
    }
    const path = isAbsolute(rawPath) ? rawPath : resolve(repoRoot, rawPath);
    if (!existsSync(path)) {
      issues.push({ code: "E_ARTIFACT_MISSING", detail: `${label}: ${path}`, claimId, path });
      continue;
    }
    if (sha256(path) !== expected) {
      issues.push({ code: "E_ARTIFACT_HASH", detail: `${label}: ${path}`, claimId, path });
    }
  }
}

function scenarioIds(
  claim: Claim,
  manifestPath: string,
  repoRoot: string,
  expectedHash: string | null,
  issues: HarnessIssue[],
): string[] {
  if (!claim.scenario_manifest) return [];
  const repoRelative = resolve(repoRoot, claim.scenario_manifest);
  const manifestRelative = resolve(dirname(manifestPath), claim.scenario_manifest);
  const path = isAbsolute(claim.scenario_manifest)
    ? claim.scenario_manifest
    : existsSync(repoRelative)
      ? repoRelative
      : manifestRelative;
  if (!existsSync(path)) {
    issues.push({
      code: "E_SCENARIO_LEDGER_MISSING",
      detail: `scenario ledger missing: ${path}`,
      claimId: claim.claim_id,
      path,
    });
    return [];
  }
  const actualHash = sha256(path);
  if (expectedHash !== actualHash) {
    issues.push({
      code: "E_SCENARIO_LEDGER_HASH",
      detail: `scenario ledger hash mismatch: ${path}`,
      claimId: claim.claim_id,
      path,
    });
  }
  let raw: unknown;
  try {
    raw = readJson(path);
  } catch (error) {
    issues.push({
      code: "E_SCENARIO_LEDGER_JSON",
      detail: String(error),
      claimId: claim.claim_id,
      path,
    });
    return [];
  }
  if (!object(raw) || !Array.isArray(raw.scenarios)) {
    issues.push({ code: "E_SCENARIO_LEDGER_SCHEMA", detail: path, claimId: claim.claim_id });
    return [];
  }
  const ids = raw.scenarios.flatMap((item) =>
    object(item) && typeof item.id === "string" ? [item.id] : [],
  );
  if (ids.length !== raw.scenarios.length || new Set(ids).size !== ids.length) {
    issues.push({ code: "E_SCENARIO_LEDGER_IDS", detail: path, claimId: claim.claim_id });
  }
  return ids.sort();
}

function validateEvidence(
  claim: Claim,
  evidence: ClaimEvidence,
  manifest: TruthManifest,
  options: HarnessEvaluationOptions,
  expected: { sha: string; tree: string; clean: boolean },
  invocation: OracleInvocation,
  issues: HarnessIssue[],
): boolean {
  const before = issues.length;
  if (evidence.claim_id !== claim.claim_id) {
    issues.push({ code: "E_CLAIM_MISMATCH", detail: evidence.claim_id, claimId: claim.claim_id });
  }
  if (evidence.contract_version !== EVALUATOR_CONTRACT_VERSION) {
    issues.push({
      code: "E_CONTRACT_VERSION",
      detail: String(evidence.contract_version),
      claimId: claim.claim_id,
    });
  }
  if (evidence.status !== "verified" || evidence.predicate_met !== true) {
    issues.push({
      code: evidence.status === "skipped" ? "E_IMPLICIT_SKIP" : "E_STATUS_NOT_VERIFIED",
      detail: `${evidence.status}/${String(evidence.predicate_met)}`,
      claimId: claim.claim_id,
    });
  }
  if (evidence.reason_code !== "VERIFIED") {
    issues.push({
      code: "E_SUCCESS_REASON",
      detail: String(evidence.reason_code),
      claimId: claim.claim_id,
    });
  }
  if (evidence.oracle_command !== claim.oracle_command) {
    issues.push({
      code: "E_ORACLE_COMMAND",
      detail: String(evidence.oracle_command),
      claimId: claim.claim_id,
    });
  }
  if (evidence.expected_predicate !== claim.expected_predicate) {
    issues.push({
      code: "E_EXPECTED_PREDICATE",
      detail: String(evidence.expected_predicate),
      claimId: claim.claim_id,
    });
  }
  if (invocation.exit !== 0 || evidence.oracle_exit !== invocation.exit) {
    issues.push({
      code: "E_ORACLE_EXIT",
      detail: `${invocation.exit}/${evidence.oracle_exit}`,
      claimId: claim.claim_id,
    });
  }
  if (!object(evidence.envelope)) {
    issues.push({ code: "E_ENVELOPE", detail: "missing envelope", claimId: claim.claim_id });
    return false;
  }
  for (const field of manifest.evidence_envelope_required_fields) {
    if (field === "scenario_ledger_hash" && !claim.scenario_manifest) continue;
    if (!nonEmpty(evidence.envelope[field as keyof EvidenceEnvelope])) {
      issues.push({
        code: "E_ENVELOPE_MISSING_FIELD",
        detail: field,
        claimId: claim.claim_id,
      });
    }
  }
  if (!claim.scenario_manifest && evidence.envelope.scenario_ledger_hash !== null) {
    issues.push({
      code: "E_SCENARIO_NOT_APPLICABLE",
      detail: String(evidence.envelope.scenario_ledger_hash),
      claimId: claim.claim_id,
    });
  }
  if (evidence.envelope.git_sha !== expected.sha) {
    issues.push({
      code: "E_EVIDENCE_STALE_SHA",
      detail: evidence.envelope.git_sha,
      claimId: claim.claim_id,
    });
  }
  if (evidence.envelope.git_tree_hash !== expected.tree) {
    issues.push({
      code: "E_EVIDENCE_STALE_TREE",
      detail: evidence.envelope.git_tree_hash,
      claimId: claim.claim_id,
    });
  }
  if (evidence.envelope.git_status_clean !== expected.clean || expected.clean !== true) {
    issues.push({
      code: "E_EVIDENCE_DIRTY",
      detail: String(evidence.envelope.git_status_clean),
      claimId: claim.claim_id,
    });
  }
  const start = Date.parse(evidence.envelope.start_timestamp);
  const end = Date.parse(evidence.envelope.end_timestamp);
  const now = Date.parse(options.now ?? options.validationClock?.() ?? new Date().toISOString());
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end > now + 60_000) {
    issues.push({
      code: "E_RESULT_TIME",
      detail: `${start}/${end}/${now}`,
      claimId: claim.claim_id,
    });
  }
  if (options.maxAgeMs !== undefined && now - end > options.maxAgeMs) {
    issues.push({ code: "E_RESULT_STALE", detail: String(now - end), claimId: claim.claim_id });
  }
  validateHashMap(
    evidence.envelope.lockfile_hashes,
    "lockfile_hashes",
    options.repoRoot,
    claim.claim_id,
    issues,
  );
  validateHashMap(
    evidence.envelope.generated_asset_hashes,
    "generated_asset_hashes",
    options.repoRoot,
    claim.claim_id,
    issues,
  );
  validateHashMap(
    evidence.envelope.oracle_implementation_hashes,
    "oracle_implementation_hashes",
    options.repoRoot,
    claim.claim_id,
    issues,
  );
  const expectedImplementations = claim.oracle_implementation_paths
    .map((path) => resolve(options.repoRoot, path))
    .sort();
  const actualImplementations = Object.keys(evidence.envelope.oracle_implementation_hashes)
    .map((path) => (isAbsolute(path) ? path : resolve(options.repoRoot, path)))
    .sort();
  if (expectedImplementations.join("\0") !== actualImplementations.join("\0")) {
    issues.push({
      code: "E_ORACLE_IMPLEMENTATION_SET",
      detail: `expected=${expectedImplementations.join(",")} actual=${actualImplementations.join(",")}`,
      claimId: claim.claim_id,
    });
  }
  validateHashMap(
    evidence.envelope.executable_app_dmg_update_hashes,
    "executable_app_dmg_update_hashes",
    options.repoRoot,
    claim.claim_id,
    issues,
  );
  for (const [label, rawPath, expectedHash] of [
    [
      "command_implementation",
      evidence.envelope.command_implementation_path,
      evidence.envelope.command_implementation_hash,
    ],
    ["fixture", evidence.envelope.fixture_path, evidence.envelope.fixture_hash],
  ] as const) {
    if (typeof rawPath !== "string" || typeof expectedHash !== "string") {
      issues.push({ code: "E_ENVELOPE_MISSING_FIELD", detail: label, claimId: claim.claim_id });
      continue;
    }
    const path = isAbsolute(rawPath) ? rawPath : resolve(options.repoRoot, rawPath);
    if (label === "command_implementation") {
      const owned = claim.oracle_implementation_paths.some((canonical) => {
        const canonicalPath = resolve(options.repoRoot, canonical);
        const relation = relative(canonicalPath, path);
        return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
      });
      if (!owned) {
        issues.push({ code: "E_ORACLE_IMPLEMENTATION", detail: path, claimId: claim.claim_id });
      }
    }
    if (!existsSync(path)) {
      issues.push({
        code: "E_ARTIFACT_MISSING",
        detail: `${label}: ${path}`,
        claimId: claim.claim_id,
      });
    } else if (sha256(path) !== expectedHash) {
      issues.push({
        code: "E_ARTIFACT_HASH",
        detail: `${label}: ${path}`,
        claimId: claim.claim_id,
      });
    }
  }
  if (!evidence.envelope.parent_run_ids.includes(invocation.runId)) {
    issues.push({ code: "E_PARENT_RUN", detail: invocation.runId, claimId: claim.claim_id });
  }
  if (evidence.envelope.run_id !== invocation.claimRunId) {
    issues.push({
      code: "E_RUN_ID",
      detail: `${evidence.envelope.run_id}/${invocation.claimRunId}`,
      claimId: claim.claim_id,
    });
  }
  if (
    evidence.envelope.start_timestamp !== invocation.startedAt ||
    Date.parse(evidence.envelope.end_timestamp) < Date.parse(invocation.startedAt) ||
    Date.parse(evidence.envelope.end_timestamp) > Date.parse(invocation.endedAt) + 1_000
  ) {
    issues.push({
      code: "E_INVOCATION_TIME",
      detail: `${evidence.envelope.start_timestamp}/${evidence.envelope.end_timestamp}`,
      claimId: claim.claim_id,
    });
  }
  for (const implementationHash of Object.values(evidence.envelope.oracle_implementation_hashes)) {
    if (!evidence.envelope.parent_artifact_hashes.includes(implementationHash)) {
      issues.push({
        code: "E_PARENT_ARTIFACT",
        detail: implementationHash,
        claimId: claim.claim_id,
      });
    }
  }
  if (
    !evidence.envelope.parent_artifact_hashes.includes(
      evidence.envelope.command_implementation_hash,
    )
  ) {
    issues.push({
      code: "E_PARENT_ARTIFACT",
      detail: evidence.envelope.command_implementation_hash,
      claimId: claim.claim_id,
    });
  }
  const requiredScenarios = scenarioIds(
    claim,
    options.manifestPath,
    options.repoRoot,
    evidence.envelope.scenario_ledger_hash,
    issues,
  );
  const executed = [...new Set(evidence.executed_scenario_ids ?? [])].sort();
  if (requiredScenarios.join("\0") !== executed.join("\0")) {
    issues.push({
      code: "E_SCENARIO_COVERAGE",
      detail: `required=${requiredScenarios.join(",")} executed=${executed.join(",")}`,
      claimId: claim.claim_id,
    });
  }
  const control = evidence.negative_control;
  if (!object(control) || control.control_id !== claim.negative_control.control_id) {
    issues.push({
      code: "E_CONTROL_ID",
      detail: String(control?.control_id),
      claimId: claim.claim_id,
    });
  } else {
    if (control.before_hash === control.mutated_hash) {
      issues.push({ code: "E_CONTROL_NOOP", detail: control.control_id, claimId: claim.claim_id });
    }
    if (control.oracle_exit !== claim.negative_control.expected_oracle_exit) {
      issues.push({
        code: "E_CONTROL_EXIT",
        detail: String(control.oracle_exit),
        claimId: claim.claim_id,
      });
    }
    if (control.oracle_exit !== invocation.controlExit) {
      issues.push({
        code: "E_CONTROL_EXIT_OBSERVED",
        detail: `${control.oracle_exit}/${invocation.controlExit}`,
        claimId: claim.claim_id,
      });
    }
    if (control.status !== claim.negative_control.expected_status) {
      issues.push({ code: "E_CONTROL_STATUS", detail: control.status, claimId: claim.claim_id });
    }
    if (control.status !== invocation.controlStatus) {
      issues.push({
        code: "E_CONTROL_STATUS_OBSERVED",
        detail: `${control.status}/${invocation.controlStatus}`,
        claimId: claim.claim_id,
      });
    }
    if (control.reason_code !== claim.negative_control.expected_reason_code) {
      issues.push({
        code: "E_CONTROL_REASON",
        detail: control.reason_code,
        claimId: claim.claim_id,
      });
    }
    if (control.reason_code !== invocation.controlReasonCode) {
      issues.push({
        code: "E_CONTROL_REASON_OBSERVED",
        detail: `${control.reason_code}/${invocation.controlReasonCode}`,
        claimId: claim.claim_id,
      });
    }
    if (control.restored_hash !== control.before_hash) {
      issues.push({
        code: "E_CONTROL_RESTORE",
        detail: control.control_id,
        claimId: claim.claim_id,
      });
    }
    if (control.baseline_before !== "verified" || control.baseline_after !== "verified") {
      issues.push({
        code: "E_CONTROL_BASELINE",
        detail: control.control_id,
        claimId: claim.claim_id,
      });
    }
    if (
      invocation.baselineBeforeExit !== 0 ||
      invocation.exit !== 0 ||
      invocation.cleanupExit !== 0
    ) {
      issues.push({
        code: "E_CONTROL_PASS_FAIL_PASS",
        detail: `${invocation.baselineBeforeExit}/${invocation.controlExit}/${invocation.cleanupExit}/${invocation.exit}`,
        claimId: claim.claim_id,
      });
    }
    const mutationManifestPath = control.mutation_manifest_path;
    const mutationManifestHash = control.mutation_manifest_hash;
    if (typeof mutationManifestPath !== "string" || typeof mutationManifestHash !== "string") {
      issues.push({
        code: "E_CONTROL_MUTATION_MANIFEST",
        detail: "missing mutation manifest path or hash",
        claimId: claim.claim_id,
      });
    } else {
      const mutationPath = isAbsolute(mutationManifestPath)
        ? mutationManifestPath
        : resolve(options.repoRoot, mutationManifestPath);
      if (!existsSync(mutationPath) || sha256(mutationPath) !== mutationManifestHash) {
        issues.push({
          code: "E_CONTROL_MUTATION_MANIFEST",
          detail: mutationPath,
          claimId: claim.claim_id,
        });
      } else {
        let mutation: unknown;
        try {
          mutation = readJson(mutationPath);
        } catch (error) {
          issues.push({
            code: "E_CONTROL_MUTATION_JSON",
            detail: String(error),
            claimId: claim.claim_id,
          });
        }
        const changedPaths = object(mutation) ? mutation.changed_paths : undefined;
        const validMutation =
          object(mutation) &&
          mutation.control_id === control.control_id &&
          mutation.before_hash === control.before_hash &&
          mutation.mutated_hash === control.mutated_hash &&
          Array.isArray(changedPaths) &&
          changedPaths.length > 0;
        if (!validMutation || !Array.isArray(changedPaths)) {
          issues.push({
            code: "E_CONTROL_MUTATION_SCHEMA",
            detail: mutationPath,
            claimId: claim.claim_id,
          });
        } else {
          for (const changed of changedPaths) {
            if (
              !object(changed) ||
              typeof changed.path !== "string" ||
              typeof changed.before_snapshot_path !== "string" ||
              typeof changed.mutated_snapshot_path !== "string" ||
              typeof changed.before_hash !== "string" ||
              typeof changed.mutated_hash !== "string" ||
              typeof changed.restored_hash !== "string"
            ) {
              issues.push({
                code: "E_CONTROL_MUTATION_SCHEMA",
                detail: mutationPath,
                claimId: claim.claim_id,
              });
              continue;
            }
            const target = resolve(dirname(mutationPath), changed.path);
            const beforeSnapshot = resolve(dirname(mutationPath), changed.before_snapshot_path);
            const mutatedSnapshot = resolve(dirname(mutationPath), changed.mutated_snapshot_path);
            if (
              !existsSync(target) ||
              !existsSync(beforeSnapshot) ||
              !existsSync(mutatedSnapshot) ||
              sha256(beforeSnapshot) !== changed.before_hash ||
              sha256(mutatedSnapshot) !== changed.mutated_hash ||
              changed.before_hash === changed.mutated_hash
            ) {
              issues.push({
                code: "E_CONTROL_MUTATION_ARTIFACT",
                detail: changed.path,
                claimId: claim.claim_id,
              });
              continue;
            }
            const restored = sha256(target);
            if (restored !== changed.restored_hash || restored !== changed.before_hash) {
              issues.push({
                code: "E_CONTROL_RESTORE",
                detail: changed.path,
                claimId: claim.claim_id,
              });
            }
          }
        }
      }
    }
  }
  return issues.length === before;
}

export function evaluateHarness(options: HarnessEvaluationOptions): HarnessEvaluation {
  const issues: HarnessIssue[] = [];
  const manifest = parseManifest(readJson(options.manifestPath));
  validateProfileCoverage(manifest, issues);
  const requiredClaimIds = resolveProfile(manifest, options.profile, issues).sort();
  const claims = new Map(manifest.claims.map((claim) => [claim.claim_id, claim]));
  if (
    !options.skipRepoCheck &&
    (options.expectedSha !== undefined ||
      options.expectedTree !== undefined ||
      options.expectedClean !== undefined)
  ) {
    issues.push({
      code: "E_REPO_IDENTITY_OVERRIDE",
      detail: "expected identity overrides are test-only and require --skip-repo-check",
    });
  }
  const repo = options.skipRepoCheck
    ? {
        sha: options.expectedSha ?? null,
        tree: options.expectedTree ?? null,
        clean: options.expectedClean ?? true,
      }
    : actualRepoIdentity(options.repoRoot);
  const expected = {
    sha: options.skipRepoCheck ? (options.expectedSha ?? repo.sha ?? "") : (repo.sha ?? ""),
    tree: options.skipRepoCheck ? (options.expectedTree ?? repo.tree ?? "") : (repo.tree ?? ""),
    clean: options.skipRepoCheck ? (options.expectedClean ?? repo.clean) : repo.clean,
  };
  if (!expected.sha || !expected.tree) {
    issues.push({ code: "E_REPO_IDENTITY", detail: "could not resolve source identity" });
  }
  const verified: string[] = [];
  const open: string[] = [];
  const runId = options.runId ?? randomUUID();
  const invocations = new Map<string, OracleInvocation>();
  if (options.runOracles !== false) {
    for (const claimId of requiredClaimIds) {
      const claim = claims.get(claimId);
      if (!claim) continue;
      const targetEvidencePath = evidencePath(options.evidenceDir, claimId);
      mkdirSync(dirname(targetEvidencePath), { recursive: true });
      const invokeOracle = (phase: string, path: string, suffix: string) => {
        rmSync(path, { force: true });
        const claimRunId = `${runId}:${claimId}:${suffix}`;
        const startedAt = new Date().toISOString();
        const result = spawnSync("sh", ["-lc", claim.oracle_command], {
          cwd: options.repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            VEAN_HARNESS_RUN_ID: runId,
            VEAN_HARNESS_CLAIM_ID: claimId,
            VEAN_HARNESS_CLAIM_RUN_ID: claimRunId,
            VEAN_HARNESS_CONTROL_ID: claim.negative_control.control_id,
            VEAN_HARNESS_STARTED_AT: startedAt,
            VEAN_HARNESS_PHASE: phase,
            VEAN_HARNESS_EVIDENCE_DIR: options.evidenceDir,
            VEAN_HARNESS_EVIDENCE_PATH: path,
          },
        });
        return {
          process: result,
          claimRunId,
          startedAt,
          endedAt: new Date().toISOString(),
        };
      };

      const baselineBefore = invokeOracle("baseline-before", targetEvidencePath, "baseline-before");
      if (baselineBefore.process.status !== 0) {
        issues.push({
          code: "E_ORACLE_EXIT",
          detail: `baseline-before ${claim.oracle_command} exited ${baselineBefore.process.status}`,
          claimId,
        });
      }
      const controlledPaths: Array<{
        path: string;
        beforeHash: string;
        mutatedHash: string;
      }> = [];
      let baselineBeforeEvidence: ClaimEvidence | null = null;
      try {
        const baselineEvidence = readJson(targetEvidencePath);
        const parsedBaselineEvidence = claimEvidenceSchema.safeParse(baselineEvidence);
        if (!parsedBaselineEvidence.success) {
          throw new Error(`baseline evidence schema: ${parsedBaselineEvidence.error.message}`);
        }
        baselineBeforeEvidence = parsedBaselineEvidence.data as ClaimEvidence;
        const mutationManifestPath = baselineBeforeEvidence.negative_control.mutation_manifest_path;
        if (typeof mutationManifestPath !== "string") {
          throw new Error("baseline evidence has no mutation manifest path");
        }
        const resolvedMutationPath = isAbsolute(mutationManifestPath)
          ? mutationManifestPath
          : resolve(options.repoRoot, mutationManifestPath);
        const mutationManifest = readJson(resolvedMutationPath);
        if (!object(mutationManifest) || !Array.isArray(mutationManifest.changed_paths)) {
          throw new Error("mutation manifest has no changed_paths");
        }
        for (const changed of mutationManifest.changed_paths) {
          if (
            !object(changed) ||
            typeof changed.path !== "string" ||
            typeof changed.before_hash !== "string" ||
            typeof changed.mutated_hash !== "string"
          ) {
            throw new Error("mutation changed_path is invalid");
          }
          const path = resolve(dirname(resolvedMutationPath), changed.path);
          controlledPaths.push({
            path,
            beforeHash: changed.before_hash,
            mutatedHash: changed.mutated_hash,
          });
          if (!existsSync(path) || sha256(path) !== changed.before_hash) {
            issues.push({ code: "E_CONTROL_BASELINE_ARTIFACT", detail: path, claimId });
          }
        }
        if (controlledPaths.length === 0) throw new Error("mutation has no controlled paths");
      } catch (error) {
        issues.push({ code: "E_CONTROL_PLAN", detail: String(error), claimId });
      }

      const controlDir = join(options.evidenceDir, "negative-controls");
      mkdirSync(controlDir, { recursive: true });
      const controlPath = join(controlDir, `${claim.negative_control.control_id}.json`);
      const controlEnvironment = {
        ...process.env,
        VEAN_HARNESS_RUN_ID: runId,
        VEAN_HARNESS_CLAIM_ID: claimId,
        VEAN_HARNESS_CONTROL_ID: claim.negative_control.control_id,
        VEAN_HARNESS_PHASE: "negative-control",
      };
      const setup = spawnSync("sh", ["-lc", claim.negative_control.setup_command], {
        cwd: options.repoRoot,
        encoding: "utf8",
        env: controlEnvironment,
      });
      if (setup.status !== 0) {
        issues.push({ code: "E_CONTROL_SETUP", detail: setup.stderr.trim(), claimId });
      }
      for (const controlled of controlledPaths) {
        if (!existsSync(controlled.path) || sha256(controlled.path) !== controlled.mutatedHash) {
          issues.push({ code: "E_CONTROL_SETUP_NOOP", detail: controlled.path, claimId });
        }
      }
      const control = invokeOracle("negative-control", controlPath, "negative-control");
      let controlStatus: string | null = null;
      let controlReasonCode: string | null = null;
      try {
        const rawControl = readJson(controlPath);
        if (!object(rawControl)) throw new Error("control result must be an object");
        controlStatus = typeof rawControl.status === "string" ? rawControl.status : null;
        controlReasonCode =
          typeof rawControl.reason_code === "string" ? rawControl.reason_code : null;
        if (rawControl.control_id !== claim.negative_control.control_id) {
          issues.push({ code: "E_CONTROL_ID", detail: String(rawControl.control_id), claimId });
        }
      } catch (error) {
        issues.push({ code: "E_CONTROL_RESULT_JSON", detail: String(error), claimId });
      }
      if (control.process.status !== claim.negative_control.expected_oracle_exit) {
        issues.push({
          code: "E_CONTROL_EXIT",
          detail: `${control.process.status}/${claim.negative_control.expected_oracle_exit}`,
          claimId,
        });
      }
      if (
        controlStatus !== claim.negative_control.expected_status ||
        controlReasonCode !== claim.negative_control.expected_reason_code
      ) {
        issues.push({
          code: "E_CONTROL_RESULT",
          detail: `${controlStatus}/${controlReasonCode}`,
          claimId,
        });
      }

      const cleanup = spawnSync("sh", ["-lc", claim.negative_control.cleanup_command], {
        cwd: options.repoRoot,
        encoding: "utf8",
        env: controlEnvironment,
      });
      if (cleanup.status !== 0) {
        issues.push({ code: "E_CONTROL_CLEANUP", detail: cleanup.stderr.trim(), claimId });
      }
      for (const controlled of controlledPaths) {
        if (!existsSync(controlled.path) || sha256(controlled.path) !== controlled.beforeHash) {
          issues.push({ code: "E_CONTROL_CLEANUP_RESTORE", detail: controlled.path, claimId });
        }
      }
      const baselineAfter = invokeOracle("baseline-after", targetEvidencePath, "baseline-after");
      if (baselineAfter.process.status !== 0) {
        issues.push({
          code: "E_ORACLE_EXIT",
          detail: `baseline-after ${claim.oracle_command} exited ${baselineAfter.process.status}`,
          claimId,
        });
      }
      invocations.set(claimId, {
        exit: baselineAfter.process.status,
        runId,
        claimRunId: baselineAfter.claimRunId,
        startedAt: baselineAfter.startedAt,
        endedAt: baselineAfter.endedAt,
        baselineBeforeExit: baselineBefore.process.status,
        controlExit: control.process.status,
        controlStatus,
        controlReasonCode,
        cleanupExit: cleanup.status,
      });
      if (baselineBeforeEvidence) {
        validateEvidence(
          claim,
          baselineBeforeEvidence,
          manifest,
          options,
          expected,
          {
            exit: baselineBefore.process.status,
            runId,
            claimRunId: baselineBefore.claimRunId,
            startedAt: baselineBefore.startedAt,
            endedAt: baselineBefore.endedAt,
            baselineBeforeExit: baselineBefore.process.status,
            controlExit: control.process.status,
            controlStatus,
            controlReasonCode,
            cleanupExit: cleanup.status,
          },
          issues,
        );
      } else {
        issues.push({ code: "E_BASELINE_EVIDENCE", detail: claimId, claimId });
      }
    }
    if (!options.skipRepoCheck) {
      const after = actualRepoIdentity(options.repoRoot);
      if (after.sha !== expected.sha || after.tree !== expected.tree || after.clean !== true) {
        issues.push({
          code: "E_ORACLE_MUTATED_SOURCE",
          detail: `${after.sha}/${after.tree}/clean=${after.clean}`,
        });
      }
    }
  }
  for (const claimId of requiredClaimIds) {
    const claim = claims.get(claimId);
    if (!claim) continue;
    const path = evidencePath(options.evidenceDir, claimId);
    if (!existsSync(path)) {
      issues.push({ code: "E_EVIDENCE_MISSING", detail: path, claimId, path });
      open.push(claimId);
      continue;
    }
    let evidence: ClaimEvidence;
    try {
      const rawEvidence = readJson(path);
      const parsedEvidence = claimEvidenceSchema.safeParse(rawEvidence);
      if (!parsedEvidence.success) {
        issues.push({
          code: "E_EVIDENCE_SCHEMA",
          detail: parsedEvidence.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; "),
          claimId,
          path,
        });
        open.push(claimId);
        continue;
      }
      evidence = parsedEvidence.data as ClaimEvidence;
    } catch (error) {
      issues.push({ code: "E_EVIDENCE_JSON", detail: String(error), claimId, path });
      open.push(claimId);
      continue;
    }
    const invocation = invocations.get(claimId) ?? {
      exit: null,
      runId,
      claimRunId: `${runId}:${claimId}`,
      startedAt: "",
      endedAt: "",
      baselineBeforeExit: null,
      controlExit: null,
      controlStatus: null,
      controlReasonCode: null,
      cleanupExit: null,
    };
    if (validateEvidence(claim, evidence, manifest, options, expected, invocation, issues))
      verified.push(claimId);
    else open.push(claimId);
  }
  return {
    ok: issues.length === 0 && verified.length === requiredClaimIds.length,
    program: manifest.program,
    profile: options.profile,
    run_id: runId,
    evidence_dir: options.evidenceDir,
    evaluator_contract_version: EVALUATOR_CONTRACT_VERSION,
    required_claim_ids: requiredClaimIds,
    verified_claim_ids: verified.sort(),
    open_claim_ids: open.sort(),
    issues,
  };
}

type CliFlags = Record<string, string | boolean>;

export function explicitCliNow(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function flags(argv: string[]): CliFlags {
  const out: CliFlags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else out[key] = true;
  }
  return out;
}

function format(result: HarnessEvaluation): string {
  const lines = [
    `${result.ok ? "PASS" : "OPEN"} ${result.program} profile=${result.profile}`,
    `verified ${result.verified_claim_ids.length}/${result.required_claim_ids.length}`,
  ];
  for (const issue of result.issues) {
    lines.push(`${issue.code}${issue.claimId ? ` ${issue.claimId}` : ""}: ${issue.detail}`);
  }
  return lines.join("\n");
}

function runCli(): void {
  const root = resolve(import.meta.dirname, "..");
  const args = flags(process.argv.slice(2));
  const runId = randomUUID();
  const manifestPath = resolve(
    String(
      args.manifest ??
        join(root, "artifacts/specs/tauri-react-remotion-harness-truth-manifest.json"),
    ),
  );
  const evidenceDir = resolve(
    String(args["evidence-dir"] ?? join(root, ".vean/harness/runs", runId)),
  );
  let result: HarnessEvaluation;
  try {
    // Leave the default clock dynamic so slow real oracles are validated against
    // completion time, not the instant before baseline/control/restored runs began.
    // An explicit --now remains deterministic for the adversarial fixture corpus.
    const now = explicitCliNow(args.now);
    const maxAgeMs =
      typeof args["max-age-ms"] === "string" ? Number(args["max-age-ms"]) : 86_400_000;
    if (now !== undefined && !Number.isFinite(Date.parse(now))) {
      throw new Error("--now must be a valid timestamp");
    }
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) {
      throw new Error("--max-age-ms must be a positive finite number");
    }
    const fixtureMode = process.env.VEAN_HARNESS_CONTRACT_TEST === "1";
    const testIdentityRequested =
      args["skip-repo-check"] === true ||
      args["expected-sha"] !== undefined ||
      args["expected-tree"] !== undefined ||
      args["expected-clean"] !== undefined;
    if (testIdentityRequested && !fixtureMode) {
      throw new Error("test identity flags require VEAN_HARNESS_CONTRACT_TEST=1");
    }
    result = evaluateHarness({
      manifestPath,
      evidenceDir,
      profile: String(args.profile ?? "developer"),
      repoRoot: resolve(String(args["repo-root"] ?? root)),
      expectedSha: typeof args["expected-sha"] === "string" ? args["expected-sha"] : undefined,
      expectedTree: typeof args["expected-tree"] === "string" ? args["expected-tree"] : undefined,
      expectedClean:
        args["expected-clean"] === undefined ? undefined : args["expected-clean"] === "true",
      now,
      maxAgeMs,
      skipRepoCheck: args["skip-repo-check"] === true,
      runId,
    });
  } catch (error) {
    result = {
      ok: false,
      program: "tauri-react-remotion-harness",
      profile: String(args.profile ?? "developer"),
      run_id: runId,
      evidence_dir: evidenceDir,
      evaluator_contract_version: EVALUATOR_CONTRACT_VERSION,
      required_claim_ids: [],
      verified_claim_ids: [],
      open_claim_ids: [],
      issues: [{ code: "E_EVALUATOR_INPUT", detail: String(error) }],
    };
  }
  if (args.json === true) console.log(JSON.stringify(result, null, 2));
  else console.log(format(result));
  process.exitCode = result.ok ? 0 : 1;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (invoked === resolve(import.meta.dirname, "verify-harness.ts")) runCli();
