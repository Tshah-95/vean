#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type BrowserControlId,
  browserOracleImplementationPaths,
  isBrowserControlId,
  prepareBrowserControl,
} from "./harness/browser-control";
import { hashPath, writeControlFailure, writeVerifiedEvidence } from "./harness/evidence";

const repo = resolve(import.meta.dirname, "..");
const claimId = "claim-browser-editor";
const oracleCommand = "bun run verify:browser";
const expectedPredicate =
  "required browser scenario ledger is complete and every mutation matches action ID/input/envelope, touched URI, independent persisted .mlt hash/parsed IR, diagnostics, desktop text-selection policy, DOM, and cleanup";
const scenarioPath = join(repo, "artifacts/specs/harness-scenarios/browser.json");
const ledger = JSON.parse(readFileSync(scenarioPath, "utf8")) as {
  runtime?: { headless?: boolean; host?: string; strict_port?: boolean };
  legacy_live_script_mapping?: Record<string, string>;
  scenarios?: Array<{ id?: string }>;
};
if (
  ledger.runtime?.headless !== true ||
  ledger.runtime.host !== "127.0.0.1" ||
  ledger.runtime.strict_port !== true
) {
  throw new Error("browser ledger must hardcode headless Chromium on strict 127.0.0.1 ports");
}
const expectedLegacy = [
  "scripts/verify-live-overlay.ts",
  "scripts/verify-live-comp.ts",
  "scripts/verify-live-hmr.ts",
  "scripts/verify-live-multi.ts",
  "scripts/verify-live-error.ts",
];
if (
  Object.keys(ledger.legacy_live_script_mapping ?? {})
    .sort()
    .join("\0") !== expectedLegacy.sort().join("\0")
) {
  throw new Error("all five legacy live scripts must map one-to-one into H04");
}
const scenarioIds = (ledger.scenarios ?? []).map((entry) => entry.id);
if (scenarioIds.length !== 6 || scenarioIds.some((id) => !id) || new Set(scenarioIds).size !== 6) {
  throw new Error("browser scenario ledger must contain six unique scenario IDs");
}

const negativePhase = process.env.VEAN_HARNESS_PHASE === "negative-control";
const requested = process.env.VEAN_HARNESS_CONTROL_ID;
if (negativePhase && (!requested || !isBrowserControlId(requested))) {
  throw new Error(`unexpected browser negative control ${requested ?? "none"}`);
}
const activeControl: BrowserControlId = isBrowserControlId(requested ?? "")
  ? (requested as BrowserControlId)
  : "nc-browser-editor";
const control = prepareBrowserControl(activeControl, !negativePhase);
const build = Bun.spawnSync(["bun", "run", "viewer:build"], {
  cwd: repo,
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});
if (build.exitCode !== 0) {
  process.stderr.write(`${build.stdout}${build.stderr}`);
  throw new Error(`viewer build failed with exit ${build.exitCode}`);
}

const evidenceBase = process.env.VEAN_HARNESS_EVIDENCE_PATH
  ? dirname(process.env.VEAN_HARNESS_EVIDENCE_PATH)
  : join(repo, ".vean/harness/browser-runs");
const runId = (
  process.env.VEAN_HARNESS_CLAIM_RUN_ID ?? `standalone-${Date.now().toString(36)}`
).replace(/[^A-Za-z0-9_.-]/g, "_");
const artifactDir = join(evidenceBase, `${claimId}-artifacts`, runId);
mkdirSync(artifactDir, { recursive: true });
const run = Bun.spawnSync(["bun", "e2e/browser/editor.spec.ts"], {
  cwd: repo,
  env: {
    ...process.env,
    CI: "1",
    FORCE_COLOR: "0",
    VEAN_BROWSER_ARTIFACT_DIR: artifactDir,
  },
  stdout: "pipe",
  stderr: "pipe",
});
const runLog = `${run.stdout.toString()}${run.stderr.toString()}`;
writeFileSync(join(artifactDir, "runner.log"), runLog);
if (negativePhase) {
  if (run.exitCode === 0) throw new Error(`${activeControl} did not fail the real browser oracle`);
  writeControlFailure(
    activeControl === "nc-browser-current-uri"
      ? "SENSITIVITY_BROWSER_CURRENT_URI"
      : "SENSITIVITY_BROWSER_EDITOR",
    activeControl,
  );
}
if (run.exitCode !== 0) {
  process.stderr.write(runLog);
  throw new Error(`headless browser editor suite failed with exit ${run.exitCode}`);
}
const line = run.stdout.toString().trim().split("\n").filter(Boolean).at(-1);
if (!line) throw new Error("browser runner omitted its result envelope");
const result = JSON.parse(line) as {
  status?: string;
  browser?: string;
  host?: string;
  executedScenarioIds?: string[];
  cleanupFindings?: unknown[];
};
if (
  result.status !== "verified" ||
  result.browser !== "playwright/chromium/headless" ||
  result.host !== "127.0.0.1" ||
  (result.cleanupFindings?.length ?? -1) !== 0
) {
  throw new Error(`browser result envelope is incomplete: ${JSON.stringify(result)}`);
}
const actualIds = [...(result.executedScenarioIds ?? [])].sort();
if (actualIds.join("\0") !== (scenarioIds as string[]).sort().join("\0")) {
  throw new Error("browser runner did not execute the exact approved scenario set");
}

const resultPath = join(artifactDir, "result.json");
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
writeVerifiedEvidence({
  repo,
  claimId,
  oracleCommand,
  expectedPredicate,
  controlId: "nc-browser-editor",
  fixturePath: join(repo, "corpus/shotcut-single.mlt"),
  commandPath: join(repo, "scripts/verify-browser.ts"),
  implementationPaths: browserOracleImplementationPaths.map((path) => join(repo, path)),
  generatedPaths: ["viewer/dist"],
  artifactPaths: [
    join(artifactDir, "runner.log"),
    join(artifactDir, "browser.log"),
    join(artifactDir, "mutation-truth.json"),
    join(artifactDir, "scenario-results.json"),
    resultPath,
  ],
  result: {
    ...result,
    legacyFlowsMigrated: expectedLegacy,
    devAndProductionDistDistinct: true,
    adversarialControls: [
      { id: "nc-browser-editor", reasonCode: "SENSITIVITY_BROWSER_EDITOR" },
      { id: "nc-browser-current-uri", reasonCode: "SENSITIVITY_BROWSER_CURRENT_URI" },
    ],
  },
  controlPlan: {
    control_id: control.control_id,
    before_hash: control.before_hash,
    mutated_hash: control.mutated_hash,
    manifestPath: control.manifestPath,
    manifestHash: hashPath(control.manifestPath),
  },
  scenarioPath,
  executedScenarioIds: actualIds,
});
console.log(JSON.stringify({ status: "verified", claimId, artifactDir, result }));
