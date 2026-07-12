#!/usr/bin/env bun
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hashPath, writeControlFailure, writeVerifiedEvidence } from "./harness/evidence";
import {
  activeMediaScenarioControl,
  isMediaClaimControlId,
  mediaOracleImplementationPaths,
  prepareMediaControl,
} from "./harness/media-control";
import { verifyExternalMediaEvidence } from "./harness/media-domain-truth";

const repo = resolve(import.meta.dirname, "..");
const valueAfter = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const suite = valueAfter("--suite") ?? "all";
const acceptedSuites = [
  "all",
  "baseline",
  "live",
  "render",
  "resilience",
  "performance",
  "live-export-parity",
] as const;
if (!acceptedSuites.includes(suite as (typeof acceptedSuites)[number])) {
  throw new Error(`E_MEDIA_UNKNOWN_SUITE:${suite}`);
}
const noAccept = process.argv.includes("--no-accept");
const matrixPath = resolve(repo, "artifacts/specs/media-runtime-matrix.json");
const goldenPath = resolve(repo, "artifacts/specs/media-golden-policy.json");
const performancePath = resolve(
  repo,
  valueAfter("--policy") ?? "artifacts/specs/media-performance-policy.json",
);
const matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
const golden = JSON.parse(readFileSync(goldenPath, "utf8"));
const performance = JSON.parse(readFileSync(performancePath, "utf8"));
const policies = [matrix, golden, performance];
const policyPaths = [matrixPath, goldenPath, performancePath];
const policySha256s = Object.fromEntries(
  policies.map((policy, index) => [policy.policy_id, hashPath(policyPaths[index] as string)]),
);
const accepting = suite !== "baseline" || !noAccept;
if (suite === "baseline" && !noAccept)
  throw new Error("baseline requires --no-accept so measurements cannot become acceptance");
if (accepting) {
  for (const policy of policies) {
    if (policy.status !== "approved" || !policy.approved_by || !policy.approved_at) {
      throw new Error(`E_MEDIA_POLICY_UNAPPROVED:${policy.policy_id}`);
    }
  }
  if (
    !Array.isArray(performance.baseline_run_ids) ||
    performance.baseline_run_ids.length === 0 ||
    performance.baseline_run_ids.some((id: unknown) => typeof id !== "string" || id.length === 0)
  )
    throw new Error("E_MEDIA_APPROVED_BASELINE_LINEAGE_REQUIRED");
  if (golden.generation?.acceptance_may_generate !== false)
    throw new Error("E_MEDIA_ACCEPTANCE_GENERATION_ENABLED");
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
const claimBySuite = {
  live: {
    claimId: "claim-live-media",
    controlId: "nc-live-media",
    predicate:
      "every predeclared required cell reports supported/unsupported/fallback as approved using exact fixture bytes, engine/binary identity, decode timestamps/seek, nonblank content, and in-scope audio signal",
  },
  render: {
    claimId: "claim-render-fidelity",
    controlId: "nc-render-fidelity",
    predicate:
      "approved immutable Remotion and final MLT frames bind source, versions, decoded RGBA/PCM, alpha, audio, and semantic/perceptual diffs",
  },
  resilience: {
    claimId: "claim-media-resilience",
    controlId: "nc-media-resilience",
    predicate:
      "owned resource ledger, browser stress, buffering/errors/context-loss, queue drain, and cleanup pass without hidden leaks or silent fallback",
  },
  performance: {
    claimId: "claim-performance-budget",
    controlId: "nc-performance-budget",
    predicate:
      "pre-approved browser and optimized-package distributions satisfy exact environment, sampling, latency, memory, queue, crash, and instrumentation bounds",
  },
  "live-export-parity": {
    claimId: "claim-live-export-semantic-parity",
    controlId: "nc-live-export-semantic-parity",
    predicate:
      "one canonical corpus binds .mlt/IR frame, composition, props/assets/version hashes and approved semantic/perceptual markers across live, renderStill, and final MLT output",
  },
} as const;
const claim = claimBySuite[suite as keyof typeof claimBySuite];
const negativePhase = process.env.VEAN_HARNESS_PHASE === "negative-control";
const requestedControl = process.env.VEAN_HARNESS_CONTROL_ID;
if (negativePhase && (!claim || requestedControl !== claim.controlId)) {
  throw new Error(`unexpected media negative control ${requestedControl ?? "none"} for ${suite}`);
}
const controlPlan = claim ? prepareMediaControl(claim.controlId, !negativePhase) : undefined;
const scenarioControl = activeMediaScenarioControl();
if (
  negativePhase &&
  (!requestedControl || !isMediaClaimControlId(requestedControl) || !scenarioControl)
) {
  throw new Error("media negative control is not mapped to an active scenario control");
}
const manifestPath = resolve(repo, golden.fixture_manifest);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const byId = new Map(manifest.entries.map((entry: { id: string }) => [entry.id, entry]));
const fixtureAlias: Record<string, string> = {
  "committed-avc-proxy": "avc-all-intra-yuv420p-mp4",
  "committed-vp9-alpha-proxy": "vp9-yuva420p-webm",
};
const missing: string[] = [];
for (const cell of matrix.required_cells as Array<{
  id: string;
  source: string;
  derived: string;
}>) {
  if (
    cell.source.startsWith("mlt-filter") ||
    cell.derived === "one-mlt-still" ||
    cell.derived === "none"
  )
    continue;
  if (cell.derived === "unchanged") {
    if (!byId.has(fixtureAlias[cell.source] ?? cell.source))
      missing.push(`${cell.id}:${cell.source}`);
  } else if (!byId.has(cell.source) || !byId.has(cell.derived))
    missing.push(`${cell.id}:${cell.source}->${cell.derived}`);
}
if (missing.length) throw new Error(`E_MEDIA_REQUIRED_CELL_MISSING:${missing.join(",")}`);
for (const entry of manifest.entries as Array<{
  relative_path: string;
  source_sha256: string;
  byte_length: number;
}>) {
  const path = resolve(dirname(manifestPath), entry.relative_path);
  if (hash(path) !== entry.source_sha256 || statSync(path).size !== entry.byte_length)
    throw new Error(`E_MEDIA_FIXTURE_DRIFT:${entry.relative_path}`);
}

const runId = process.env.VEAN_HARNESS_CLAIM_RUN_ID ?? randomUUID();
const artifactDir = resolve(
  repo,
  process.env.VEAN_MEDIA_ARTIFACT_DIR ?? `.vean/harness/media-runs/${runId}`,
);
mkdirSync(artifactDir, { recursive: true });
const build = Bun.spawnSync(["bun", "run", "viewer:build"], {
  cwd: repo,
  env: process.env,
  stdout: "pipe",
  stderr: "pipe",
});
if (build.exitCode !== 0)
  throw new Error(`media viewer build failed\n${build.stdout}${build.stderr}`);
const browserResultPath = join(artifactDir, "browser-result.json");
const child = Bun.spawn(["bun", "e2e/media/media.spec.ts"], {
  cwd: repo,
  env: {
    ...process.env,
    CI: "1",
    VEAN_MEDIA_SUITE: suite,
    VEAN_MEDIA_ARTIFACT_DIR: artifactDir,
    VEAN_MEDIA_RESULT_PATH: browserResultPath,
    VEAN_MEDIA_CONTROL: scenarioControl ?? "none",
    VEAN_MEDIA_MEASURED_RUNS: String(performance.sampling.measured_fresh_process_runs),
    VEAN_MEDIA_SAMPLES_PER_RUN: String(performance.sampling.steady_state_composite_samples_per_run),
  },
  stdout: "pipe",
  stderr: "pipe",
});
const [childExit, childStdout, childStderr] = await Promise.all([
  child.exited,
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
]);
writeFileSync(join(artifactDir, "runner.log"), `${childStdout}${childStderr}`);
if (childExit !== 0) {
  if (negativePhase && claim) {
    writeControlFailure(
      `SENSITIVITY_${claim.claimId
        .replace(/^claim-/, "")
        .replaceAll("-", "_")
        .toUpperCase()}`,
      claim.controlId,
    );
  }
  process.stderr.write(`${childStdout}${childStderr}`);
  throw new Error(`media Chrome runner failed with exit ${childExit}`);
}
if (!Bun.file(browserResultPath).size) throw new Error("media runner omitted result artifact");
const browserResult = JSON.parse(readFileSync(browserResultPath, "utf8"));
const candidateManifest = join(repo, "corpus/harness/media/candidate-goldens/manifest.json");
const fixtureManifestSha256 = hash(manifestPath);
let approvedGolden: { path: string; sha256: string; manifest: Record<string, unknown> } | undefined;
let wkwebviewEvidence: unknown = {
  status: "requires_h05_guest_provider",
  substitute_allowed: false,
};
let releaseEvidence: unknown = {
  status: "requires_h08_optimized_package",
  substitute_allowed: false,
};
if (accepting) {
  const requireExternalEvidence = (
    flag: string,
    reason: string,
    kind: "wkwebview-media-runtime" | "release-package-performance",
  ) => {
    const path = valueAfter(flag);
    if (!path) throw new Error(reason);
    return verifyExternalMediaEvidence({
      evidencePath: resolve(repo, path),
      kind,
      fixtureManifestSha256,
      policySha256s,
      requiredCellOutcomes:
        kind === "wkwebview-media-runtime"
          ? Object.fromEntries(
              matrix.required_cells.map((cell: { id: string; wkwebview: string }) => [
                cell.id,
                cell.wkwebview,
              ]),
            )
          : undefined,
      performanceSampling:
        kind === "release-package-performance"
          ? {
              warmupRuns: performance.sampling.warmup_runs,
              measuredRuns: performance.sampling.measured_fresh_process_runs,
              samplesPerRun: performance.sampling.steady_state_composite_samples_per_run,
            }
          : undefined,
      performanceBudgets:
        kind === "release-package-performance"
          ? performance.proposed_user_visible_budgets.release_wkwebview
          : undefined,
      functionalCaps:
        kind === "release-package-performance" ? performance.functional_caps : undefined,
    });
  };
  if (["all", "live"].includes(suite)) {
    wkwebviewEvidence = requireExternalEvidence(
      "--wkwebview-result",
      "E_MEDIA_WKWEBVIEW_EVIDENCE_REQUIRED",
      "wkwebview-media-runtime",
    );
  }
  if (["all", "performance"].includes(suite)) {
    releaseEvidence = requireExternalEvidence(
      "--release-result",
      "E_MEDIA_RELEASE_PERFORMANCE_EVIDENCE_REQUIRED",
      "release-package-performance",
    );
  }
  if (["all", "render", "live-export-parity"].includes(suite)) {
    const approvedManifest = golden.approved_manifest as string | undefined;
    if (!approvedManifest || approvedManifest.includes("candidate-goldens"))
      throw new Error("E_MEDIA_APPROVED_GOLDEN_MANIFEST_REQUIRED");
    const approvedPath = resolve(repo, approvedManifest);
    if (hash(approvedPath) !== golden.approved_manifest_sha256)
      throw new Error("E_MEDIA_APPROVED_GOLDEN_DRIFT");
    const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as Record<string, unknown>;
    if (approved.status !== "approved" || approved.acceptance_eligible !== true) {
      throw new Error("E_MEDIA_GOLDEN_MANIFEST_NOT_APPROVED");
    }
    approvedGolden = {
      path: approvedManifest,
      sha256: golden.approved_manifest_sha256,
      manifest: approved,
    };
  }
  if (["all", "performance"].includes(suite)) {
    const budget = performance.proposed_user_visible_budgets.chrome;
    const approvedEnvironment = performance.approved_environments?.chrome;
    if (!approvedEnvironment) throw new Error("E_MEDIA_APPROVED_CHROME_ENVIRONMENT_REQUIRED");
    for (const [key, expected] of Object.entries(approvedEnvironment)) {
      if (JSON.stringify(browserResult.runtime[key]) !== JSON.stringify(expected))
        throw new Error(`E_MEDIA_CHROME_ENVIRONMENT_MISMATCH:${key}`);
    }
    const distributions = browserResult.performance.distributions as Array<{
      p95: number;
      max: number;
      rawSamples: number[];
    }>;
    if (
      distributions.length !== performance.sampling.measured_fresh_process_runs ||
      distributions.some(
        (distribution) =>
          distribution.rawSamples.length !==
          performance.sampling.steady_state_composite_samples_per_run,
      )
    )
      throw new Error("E_MEDIA_PERFORMANCE_DISTRIBUTION_INCOMPLETE");
    if (
      Math.max(...distributions.map((distribution) => distribution.p95)) > budget.composite_p95_ms
    )
      throw new Error("E_MEDIA_CHROME_COMPOSITE_P95_BUDGET");
    if (
      Math.max(...distributions.map((distribution) => distribution.max)) > budget.composite_max_ms
    )
      throw new Error("E_MEDIA_CHROME_COMPOSITE_MAX_BUDGET");
  }
}
const result = {
  schema_version: "1.0.0",
  status: accepting ? "verified" : "baseline_only",
  acceptance: accepting,
  suite,
  run_id: runId,
  policy: policies.map((policy) => ({
    id: policy.policy_id,
    status: policy.status,
    sha256: hash(policy === matrix ? matrixPath : policy === golden ? goldenPath : performancePath),
  })),
  fixtures: {
    manifest_path: golden.fixture_manifest,
    manifest_sha256: fixtureManifestSha256,
    count: manifest.entries.length,
    all_required_cells_in_denominator: true,
  },
  sections: {
    "live.chrome": { media: browserResult.live, player: browserResult.player },
    "live.wkwebview": wkwebviewEvidence,
    "render.remotion": {
      status: approvedGolden ? "verified_approved_golden" : "candidate_only",
      manifest: approvedGolden?.path ?? candidateManifest,
      manifest_sha256: approvedGolden?.sha256 ?? null,
      exists:
        Bun.file(approvedGolden ? resolve(repo, approvedGolden.path) : candidateManifest).size > 0,
    },
    "render.mlt": {
      status: approvedGolden ? "verified_approved_golden" : "candidate_only",
      manifest: approvedGolden?.path ?? candidateManifest,
      manifest_sha256: approvedGolden?.sha256 ?? null,
      exists:
        Bun.file(approvedGolden ? resolve(repo, approvedGolden.path) : candidateManifest).size > 0,
    },
    resilience: browserResult.resilience,
    performance: browserResult.performance,
    "performance.release-package": releaseEvidence,
    "live-export-parity": {
      status: approvedGolden ? "verified_approved_golden" : "candidate_only",
      case: golden.parity_case,
      manifest: approvedGolden?.path ?? candidateManifest,
      manifest_sha256: approvedGolden?.sha256 ?? null,
      live: browserResult.player,
    },
  },
  runtime: browserResult.runtime,
};
const resultPath = join(artifactDir, "result.json");
writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
writeFileSync(
  join(artifactDir, "performance-raw.json"),
  `${JSON.stringify(browserResult.performance, null, 2)}\n`,
);
if (accepting && claim && controlPlan) {
  const scenarioLedger = JSON.parse(
    readFileSync(resolve(repo, "artifacts/specs/harness-scenarios/media.json"), "utf8"),
  ) as { scenarios: Array<{ id: string }> };
  writeVerifiedEvidence({
    repo,
    claimId: claim.claimId,
    oracleCommand: `bun run verify:media --suite ${suite}${
      suite === "performance" ? " --policy artifacts/specs/media-performance-policy.json" : ""
    }`,
    expectedPredicate: claim.predicate,
    controlId: claim.controlId,
    fixturePath: manifestPath,
    commandPath: resolve(repo, "scripts/verify-media.ts"),
    implementationPaths: mediaOracleImplementationPaths.map((path) => resolve(repo, path)),
    generatedPaths: ["viewer/dist", "corpus/harness/media/manifest.json"],
    artifactPaths: [resultPath, join(artifactDir, "runner.log"), browserResultPath],
    result,
    controlPlan: {
      control_id: controlPlan.control_id,
      before_hash: controlPlan.before_hash,
      mutated_hash: controlPlan.mutated_hash,
      manifestPath: controlPlan.manifestPath,
      manifestHash: hashPath(controlPlan.manifestPath),
    },
    scenarioPath: resolve(repo, "artifacts/specs/harness-scenarios/media.json"),
    executedScenarioIds: scenarioLedger.scenarios.map((scenario) => scenario.id),
  });
}
console.log(JSON.stringify({ status: result.status, artifactDir, result }));
