import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Case = { id: string; expected_exit: number; expected_code: string | null };
type EvidenceFixture = {
  contract_version: string;
  claim_id: string;
  status: string;
  reason_code: string;
  predicate_met: boolean;
  oracle_command: string;
  expected_predicate: string;
  oracle_exit: number;
  envelope: {
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
    platform_image_runtime_versions: Record<string, string>;
    start_timestamp: string;
    end_timestamp: string;
    run_id: string;
    parent_run_ids: string[];
    parent_artifact_hashes: string[];
  };
  executed_scenario_ids: string[];
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

const repoRoot = resolve(import.meta.dirname, "..");
const corpusRoot = join(import.meta.dirname, "fixtures/harness-contract");
const evaluator = join(repoRoot, "scripts/verify-harness.ts");
const cases = JSON.parse(readFileSync(join(corpusRoot, "cases.json"), "utf8")) as Case[];
const temporaryRoots: string[] = [];

function hash(path: string): string {
  const digest = createHash("sha256");
  if (lstatSync(path).isDirectory()) {
    for (const entry of readdirSync(path).sort()) {
      digest.update(`entry\0${entry}\0${hash(join(path, entry))}\0`);
    }
    return digest.digest("hex");
  }
  return digest.update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function fixture(testCase: Case): { root: string; manifest: string; evidenceDir: string } {
  const root = mkdtempSync(join(tmpdir(), `vean-harness-${testCase.id}-`));
  temporaryRoots.push(root);
  const evidenceDir = join(root, "evidence");
  const claimDir = join(evidenceDir, "claims");
  const templatePath = join(evidenceDir, "template.json");
  mkdirSync(claimDir, { recursive: true });
  writeFileSync(join(root, ".gitignore"), "evidence/\n");
  for (const name of ["manifest.json", "scenario-ledger.json"]) {
    cpSync(join(corpusRoot, name), join(root, name));
  }

  const lockfile = join(root, "bun.lock");
  const generated = join(root, "generated.json");
  const artifact = join(root, "Vean.app");
  const inputFixture = join(root, "fixture.mlt");
  const beforeSnapshot = join(root, "fixture.before.mlt");
  const mutatedSnapshot = join(root, "fixture.mutated.mlt");
  const command = join(root, "fixture-oracle.ts");
  const controlCommand = join(root, "fixture-control.ts");
  const mutationManifest = join(root, "mutation.json");
  writeFileSync(lockfile, "lock-v1\n");
  writeFileSync(generated, "generated-v1\n");
  if (testCase.id === "directory-artifact") {
    mkdirSync(artifact);
    writeFileSync(join(artifact, "Contents"), "app-v1\n");
  } else {
    writeFileSync(artifact, "app-v1\n");
  }
  writeFileSync(inputFixture, "<mlt/>\n");
  writeFileSync(beforeSnapshot, "<mlt/>\n");
  writeFileSync(mutatedSnapshot, "<mlt mutant='true'/>\n");
  writeFileSync(
    command,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      "const path = process.env.VEAN_HARNESS_EVIDENCE_PATH;",
      "const templatePath = process.env.VEAN_EVIDENCE_TEMPLATE;",
      "const runId = process.env.VEAN_HARNESS_RUN_ID;",
      "const claimRunId = process.env.VEAN_HARNESS_CLAIM_RUN_ID;",
      "const startedAt = process.env.VEAN_HARNESS_STARTED_AT;",
      "const caseId = process.env.VEAN_CASE_ID;",
      "const phase = process.env.VEAN_HARNESS_PHASE;",
      "if (!path || !templatePath || !runId || !claimRunId || !startedAt) process.exit(2);",
      'if (phase === "negative-control") {',
      '  const reason = caseId === "actual-wrong-reason" ? "WRONG_ACTUAL_REASON" : "SENSITIVITY_DEMO";',
      '  writeFileSync(path, `${JSON.stringify({ control_id: "nc-demo", status: "failed", reason_code: reason }, null, 2)}\\n`);',
      "  process.exit(1);",
      "}",
      "try {",
      '  const evidence = JSON.parse(readFileSync(templatePath, "utf8"));',
      '  if (caseId !== "missing-parent-run") evidence.envelope.parent_run_ids = [runId];',
      "  evidence.envelope.run_id = claimRunId;",
      '  if (caseId !== "stale-result") {',
      "    evidence.envelope.start_timestamp = startedAt;",
      "    evidence.envelope.end_timestamp = new Date().toISOString();",
      "  }",
      "  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\\n`);",
      "} catch {",
      "  writeFileSync(path, readFileSync(templatePath));",
      "}",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  writeFileSync(
    controlCommand,
    [
      'import { cpSync } from "node:fs";',
      'import { join } from "node:path";',
      "const mode = process.argv[2];",
      "const caseId = process.env.VEAN_CASE_ID;",
      "const root = import.meta.dirname;",
      'if (mode === "setup") { if (caseId !== "setup-noop") cpSync(join(root, "fixture.mutated.mlt"), join(root, "fixture.mlt")); }',
      'else if (mode === "cleanup") cpSync(join(root, "fixture.before.mlt"), join(root, "fixture.mlt"));',
      "else process.exit(2);",
      "",
    ].join("\n"),
  );
  writeJson(mutationManifest, {
    control_id: "nc-demo",
    before_hash: hash(beforeSnapshot),
    mutated_hash: hash(mutatedSnapshot),
    changed_paths: [
      {
        path: basename(inputFixture),
        before_snapshot_path: basename(beforeSnapshot),
        mutated_snapshot_path: basename(mutatedSnapshot),
        before_hash: hash(beforeSnapshot),
        mutated_hash: hash(mutatedSnapshot),
        restored_hash: hash(inputFixture),
      },
    ],
  });

  const evidence: EvidenceFixture = {
    contract_version: "1.0.0",
    claim_id: "claim-demo",
    status: "verified",
    reason_code: "VERIFIED",
    predicate_met: true,
    oracle_command: "bun fixture-oracle.ts",
    expected_predicate: "fixture passes",
    oracle_exit: 0,
    envelope: {
      git_sha: "pending",
      git_tree_hash: "pending",
      git_status_clean: true,
      lockfile_hashes: { [lockfile]: hash(lockfile) },
      generated_asset_hashes: { [generated]: hash(generated) },
      oracle_implementation_hashes: {
        [command]: hash(command),
        [controlCommand]: hash(controlCommand),
      },
      command_implementation_path: command,
      command_implementation_hash: hash(command),
      fixture_path: inputFixture,
      fixture_hash: hash(inputFixture),
      scenario_ledger_hash: hash(join(root, "scenario-ledger.json")),
      executable_app_dmg_update_hashes: { [artifact]: hash(artifact) },
      platform_image_runtime_versions: { os: "fixture", bun: "fixture" },
      start_timestamp: new Date(Date.now() - 1_000).toISOString(),
      end_timestamp: new Date().toISOString(),
      run_id: "run-demo",
      parent_run_ids: [],
      parent_artifact_hashes: [hash(command), hash(controlCommand)],
    },
    executed_scenario_ids: ["demo-flow"],
    negative_control: {
      control_id: "nc-demo",
      before_hash: hash(beforeSnapshot),
      mutated_hash: hash(mutatedSnapshot),
      oracle_exit: 1,
      status: "failed",
      reason_code: "SENSITIVITY_DEMO",
      restored_hash: hash(beforeSnapshot),
      baseline_before: "verified",
      baseline_after: "verified",
      mutation_manifest_path: mutationManifest,
      mutation_manifest_hash: hash(mutationManifest),
    },
  };

  if (testCase.id === "dirty") evidence.envelope.git_status_clean = false;
  if (testCase.id === "no-op-control") {
    evidence.negative_control.mutated_hash = evidence.negative_control.before_hash;
  }
  if (testCase.id === "wrong-reason") evidence.negative_control.reason_code = "WRONG_REASON";
  if (testCase.id === "missing-scenario") evidence.executed_scenario_ids = [];
  if (testCase.id === "forged-command") evidence.oracle_command = "bun forged.ts";
  if (testCase.id === "forged-predicate") evidence.expected_predicate = "forged";
  if (testCase.id === "empty-hash-map") evidence.envelope.generated_asset_hashes = {};
  if (testCase.id === "missing-parent-artifact") evidence.envelope.parent_artifact_hashes = [];
  if (testCase.id === "stale-result") {
    evidence.envelope.start_timestamp = "2000-01-01T00:00:00Z";
    evidence.envelope.end_timestamp = "2000-01-01T00:00:30Z";
  }
  if (testCase.id === "implicit-skip") {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
      aggregate_profiles: { developer: { implicit_skips_allowed: boolean } };
    };
    manifest.aggregate_profiles.developer.implicit_skips_allowed = true;
    writeJson(join(root, "manifest.json"), manifest);
  }
  if (testCase.id === "empty-profile") {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
      aggregate_profiles: { developer: { required_claims: string[] } };
    };
    manifest.aggregate_profiles.developer.required_claims = [];
    writeJson(join(root, "manifest.json"), manifest);
  }
  if (testCase.id === "removed-profile") {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
      aggregate_profiles: Record<string, unknown>;
    };
    const { developer: _removed, ...remainingProfiles } = manifest.aggregate_profiles;
    manifest.aggregate_profiles = remainingProfiles;
    writeJson(join(root, "manifest.json"), manifest);
  }
  if (testCase.id === "broken-inheritance") {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
      aggregate_profiles: { release: { inherits: string } };
    };
    manifest.aggregate_profiles.release.inherits = "developer";
    writeJson(join(root, "manifest.json"), manifest);
  }
  if (testCase.id === "malformed-manifest") writeFileSync(join(root, "manifest.json"), "{bad\n");
  if (testCase.id === "malformed-ledger")
    writeFileSync(join(root, "scenario-ledger.json"), "{bad\n");
  if (testCase.id === "no-scenario-valid") {
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
      claims: Array<{ scenario_manifest: string | null }>;
    };
    const claim = manifest.claims[0];
    if (!claim) throw new Error("fixture claim missing");
    claim.scenario_manifest = null;
    writeJson(join(root, "manifest.json"), manifest);
    evidence.envelope.scenario_ledger_hash = null;
    evidence.executed_scenario_ids = [];
  }

  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "harness@example.invalid"]);
  git(root, ["config", "user.name", "Harness Contract"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "contract fixture"]);
  evidence.envelope.git_sha = git(root, ["rev-parse", "HEAD"]);
  evidence.envelope.git_tree_hash = git(root, ["rev-parse", "HEAD^{tree}"]);
  if (testCase.id === "stale-sha") evidence.envelope.git_sha = "sha-old";
  if (testCase.id === "stale-tree") evidence.envelope.git_tree_hash = "tree-old";

  writeJson(templatePath, evidence);
  if (testCase.id === "malformed-evidence") {
    writeFileSync(templatePath, "{not-json\n");
  }
  if (testCase.id === "null-evidence") writeFileSync(templatePath, "null\n");
  if (testCase.id === "malformed-object") writeJson(templatePath, { envelope: {} });
  if (testCase.id === "malformed-types") {
    const malformed = { ...evidence, envelope: { ...evidence.envelope } } as Record<
      string,
      unknown
    >;
    (malformed.envelope as Record<string, unknown>).executable_app_dmg_update_hashes = [];
    writeJson(templatePath, malformed);
  }
  if (testCase.id === "substituted-artifact") writeFileSync(artifact, "app-substituted\n");
  if (testCase.id === "fake-mutation") writeFileSync(mutatedSnapshot, "forged mutant\n");
  return { root, manifest: join(root, "manifest.json"), evidenceDir };
}

afterEach(() => {
  for (const path of temporaryRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("independent harness evaluator meta-contract", () => {
  for (const testCase of cases) {
    it(`evaluates fixed corpus case: ${testCase.id}`, () => {
      const paths = fixture(testCase);
      const identityModeArgs =
        testCase.id === "identity-override" ? ["--expected-sha", "forged"] : [];
      const invalidOptionArgs =
        testCase.id === "invalid-now"
          ? ["--now", "not-a-date"]
          : testCase.id === "invalid-max-age"
            ? ["--max-age-ms", "NaN"]
            : [];
      const result = spawnSync(
        "bun",
        [
          evaluator,
          "--manifest",
          paths.manifest,
          "--evidence-dir",
          paths.evidenceDir,
          "--repo-root",
          paths.root,
          "--profile",
          "release",
          ...identityModeArgs,
          ...invalidOptionArgs,
          "--json",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            VEAN_HARNESS_CONTRACT_TEST: "1",
            VEAN_CASE_ID: testCase.id,
            VEAN_EVIDENCE_TEMPLATE: join(paths.evidenceDir, "template.json"),
          },
        },
      );

      expect(result.status, result.stderr).toBe(testCase.expected_exit);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout) as {
        ok: boolean;
        issues: Array<{ code: string }>;
      };
      expect(report.ok).toBe(testCase.expected_exit === 0);
      const codes = report.issues.map((issue) => issue.code);
      if (testCase.expected_code) expect(codes).toContain(testCase.expected_code);
      else expect(codes).toEqual([]);
    });
  }
});
