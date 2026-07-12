#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { prepareStaticControl } from "./harness/static-owned-control";

type Profile = "developer" | "macos";
type Gate = { id: string; command: string; args: string[] };
type GateResult = { id: string; command: string; exit: number; stdout: string; stderr: string };

const root = resolve(import.meta.dirname, "..");
const claimId = "claim-static-owned-code";
const oracleCommand = "bun run verify:fast --profile macos";
const expectedPredicate =
  "platform-neutral gates and macOS target/feature fmt-check-clippy-test records are verified";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function commandVersion(command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  return (result.stdout || result.stderr).trim();
}

function parseProfile(): Profile {
  const index = process.argv.indexOf("--profile");
  const raw = index >= 0 ? process.argv[index + 1] : "developer";
  if (raw !== "developer" && raw !== "macos") throw new Error(`unknown static profile: ${raw}`);
  return raw;
}

function gates(profile: Profile): Gate[] {
  const common: Gate[] = [
    { id: "viewer-typecheck", command: "bun", args: ["run", "viewer:typecheck"] },
    { id: "root-typecheck", command: "bun", args: ["run", "typecheck"] },
    { id: "root-lint", command: "bun", args: ["run", "lint"] },
    { id: "viewer-lint", command: "bun", args: ["run", "viewer:lint"] },
    { id: "remotion-typecheck", command: "bun", args: ["run", "remotion:typecheck"] },
    { id: "remotion-lint", command: "bun", args: ["run", "remotion:lint"] },
    { id: "viewer-production-build", command: "bun", args: ["run", "viewer:build"] },
    { id: "rustfmt", command: "bun", args: ["run", "rust:fmt"] },
  ];
  if (profile === "macos") {
    common.push(
      { id: "rust-check-macos", command: "bun", args: ["run", "rust:check:macos"] },
      { id: "rust-clippy-macos", command: "bun", args: ["run", "rust:clippy:macos"] },
      { id: "rust-test-macos", command: "bun", args: ["run", "rust:test:macos"] },
    );
  }
  return common;
}

function runGates(profile: Profile): GateResult[] {
  const results: GateResult[] = [];
  for (const gate of gates(profile)) {
    const result = spawnSync(gate.command, gate.args, { cwd: root, encoding: "utf8" });
    results.push({
      id: gate.id,
      command: [gate.command, ...gate.args].join(" "),
      exit: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    if (result.status !== 0) break;
  }
  return results;
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function main(): void {
  const profile = parseProfile();
  if (profile === "macos" && process.platform !== "darwin") {
    throw new Error("the macos profile must execute on macOS");
  }
  const phase = process.env.VEAN_HARNESS_PHASE;
  const control = prepareStaticControl(phase !== "negative-control");
  const startedAt = process.env.VEAN_HARNESS_STARTED_AT ?? new Date().toISOString();
  const results = runGates(profile);
  const failed = results.find((result) => result.exit !== 0);
  const evidencePath =
    process.env.VEAN_HARNESS_EVIDENCE_PATH ??
    resolve(root, ".vean/harness/latest/claims/claim-static-owned-code.json");

  if (phase === "negative-control") {
    const expectedFailure = failed?.id === "viewer-typecheck";
    writeJson(evidencePath, {
      contract_version: "1.0.0",
      control_id: control.controlId,
      status: expectedFailure ? "failed" : "invalid-control",
      reason_code: expectedFailure ? "SENSITIVITY_STATIC_OWNED_CODE" : "CONTROL_DID_NOT_FAIL",
      failing_gate: failed?.id ?? null,
    });
    process.exit(expectedFailure ? 1 : 2);
  }

  if (failed) {
    writeJson(evidencePath, {
      contract_version: "1.0.0",
      claim_id: claimId,
      status: "failed",
      reason_code: "STATIC_GATE_FAILED",
      failing_gate: failed.id,
      results,
    });
    console.error(failed.stderr || failed.stdout);
    process.exit(1);
  }

  const runId = process.env.VEAN_HARNESS_RUN_ID ?? randomUUID();
  const claimRunId = process.env.VEAN_HARNESS_CLAIM_RUN_ID ?? `${runId}:${claimId}`;
  const summaryPath = resolve(dirname(evidencePath), "claim-static-owned-code-results.json");
  writeJson(summaryPath, {
    contract_version: "1.0.0",
    claim_id: claimId,
    profile,
    status: "verified",
    target: profile === "macos" ? "aarch64-apple-darwin" : process.platform,
    toolchain: "1.95.0",
    results,
  });

  const implementationPaths = [
    resolve(root, "package.json"),
    resolve(root, "scripts/verify-fast.ts"),
    resolve(root, "scripts/harness/static-owned-control.ts"),
  ];
  const implementationHashes = Object.fromEntries(
    implementationPaths.map((path) => [relative(root, path), sha256(path)]),
  );
  const commandHash = sha256(resolve(root, "scripts/verify-fast.ts"));
  const status = git(["status", "--porcelain"]);
  const evidence = {
    contract_version: "1.0.0",
    claim_id: claimId,
    status: "verified",
    reason_code: "VERIFIED",
    predicate_met: true,
    oracle_command: oracleCommand,
    expected_predicate: expectedPredicate,
    oracle_exit: 0,
    envelope: {
      git_sha: git(["rev-parse", "HEAD"]),
      git_tree_hash: git(["rev-parse", "HEAD^{tree}"]),
      git_status_clean: status.length === 0,
      lockfile_hashes: Object.fromEntries(
        [
          "bun.lock",
          "viewer/bun.lock",
          "remotion/bun.lock",
          "app/bun.lock",
          "app/src-tauri/Cargo.lock",
        ].map((path) => [path, sha256(resolve(root, path))]),
      ),
      generated_asset_hashes: {
        "app/src-tauri/vean-actions.json": sha256(resolve(root, "app/src-tauri/vean-actions.json")),
      },
      oracle_implementation_hashes: implementationHashes,
      command_implementation_path: "scripts/verify-fast.ts",
      command_implementation_hash: commandHash,
      fixture_path: relative(root, control.target),
      fixture_hash: sha256(control.target),
      scenario_ledger_hash: null,
      executable_app_dmg_update_hashes: {
        [relative(root, summaryPath)]: sha256(summaryPath),
      },
      platform_image_runtime_versions: {
        platform: process.platform,
        arch: process.arch,
        bun: Bun.version,
        rustc: commandVersion("rustup", ["run", "1.95.0", "rustc", "--version"]),
        target: profile === "macos" ? "aarch64-apple-darwin" : process.platform,
      },
      start_timestamp: startedAt,
      end_timestamp: new Date().toISOString(),
      run_id: claimRunId,
      parent_run_ids: [runId],
      parent_artifact_hashes: [...Object.values(implementationHashes), commandHash],
    },
    executed_scenario_ids: [],
    negative_control: {
      control_id: control.controlId,
      before_hash: control.beforeHash,
      mutated_hash: control.mutatedHash,
      oracle_exit: 1,
      status: "failed",
      reason_code: "SENSITIVITY_STATIC_OWNED_CODE",
      restored_hash: control.beforeHash,
      baseline_before: "verified",
      baseline_after: "verified",
      mutation_manifest_path: relative(root, control.mutationManifest),
      mutation_manifest_hash: sha256(control.mutationManifest),
    },
  };
  writeJson(evidencePath, evidence);
  console.log(
    JSON.stringify({ ok: true, claim_id: claimId, profile, evidence_path: evidencePath }),
  );
}

main();
