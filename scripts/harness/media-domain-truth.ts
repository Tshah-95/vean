import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Stats } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  type PerformanceBudgets,
  type PerformanceCaps,
  verifyPerformanceRawArtifact,
} from "./media-performance-domain-truth";

type JsonObject = Record<string, unknown>;

export type ExternalMediaEvidenceKind = "wkwebview-media-runtime" | "release-package-performance";

export type ExternalMediaEvidenceOptions = {
  evidencePath: string;
  kind: ExternalMediaEvidenceKind;
  expectedSourceGitSha: string;
  expectedSourceGitTreeHash: string;
  fixtureManifestSha256: string;
  policySha256s: Record<string, string>;
  requiredCellOutcomes?: Record<string, string>;
  performanceSampling?: {
    warmupRuns: number;
    measuredRuns: number;
    samplesPerRun: number;
  };
  performanceBudgets?: PerformanceBudgets;
  functionalCaps?: PerformanceCaps;
};

function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`E_MEDIA_EXTERNAL_${label}`);
  return value;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sameJson(a: unknown, b: unknown): boolean {
  if (object(a) && object(b)) {
    const aEntries = Object.entries(a).sort(([left], [right]) => left.localeCompare(right));
    const bEntries = Object.entries(b).sort(([left], [right]) => left.localeCompare(right));
    return JSON.stringify(aEntries) === JSON.stringify(bEntries);
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

function assertGitObjectId(value: unknown, label: string): string {
  const id = string(value, label);
  if (!/^[a-f0-9]{40,64}$/.test(id)) throw new Error(`E_MEDIA_EXTERNAL_${label}`);
  return id;
}

function assertSourceIdentity(
  source: unknown,
  expectedGitSha: string,
  expectedGitTreeHash: string,
): string {
  if (!object(source)) throw new Error("E_MEDIA_EXTERNAL_SOURCE_IDENTITY");
  const providerGitSha = assertGitObjectId(source.git_sha, "SOURCE_SHA");
  const providerTreeHash = assertGitObjectId(source.git_tree_hash, "SOURCE_TREE");
  if (source.git_status_clean !== true) throw new Error("E_MEDIA_EXTERNAL_SOURCE_DIRTY");
  const provenance = source.archive_provenance;
  if (provenance === null) {
    if (providerGitSha !== expectedGitSha) throw new Error("E_MEDIA_EXTERNAL_SOURCE_STALE_SHA");
    if (providerTreeHash !== expectedGitTreeHash) {
      throw new Error("E_MEDIA_EXTERNAL_SOURCE_STALE_TREE");
    }
    return providerGitSha;
  }
  if (!object(provenance) || provenance.kind !== "tracked_archive") {
    throw new Error("E_MEDIA_EXTERNAL_ARCHIVE_PROVENANCE");
  }
  const archivedSha = assertGitObjectId(provenance.source_git_sha, "ARCHIVE_SOURCE_SHA");
  const archivedTree = assertGitObjectId(provenance.source_git_tree_hash, "ARCHIVE_SOURCE_TREE");
  if (archivedSha !== expectedGitSha) throw new Error("E_MEDIA_EXTERNAL_SOURCE_STALE_SHA");
  if (archivedTree !== expectedGitTreeHash) throw new Error("E_MEDIA_EXTERNAL_SOURCE_STALE_TREE");
  if (providerTreeHash !== archivedTree) {
    throw new Error("E_MEDIA_EXTERNAL_ARCHIVE_TREE_MISMATCH");
  }
  return providerGitSha;
}

function assertRuntime(kind: ExternalMediaEvidenceKind, runtime: unknown): void {
  if (!object(runtime)) throw new Error("E_MEDIA_EXTERNAL_RUNTIME");
  if (kind === "wkwebview-media-runtime") {
    if (runtime.runner !== "tauri/wkwebview") throw new Error("E_MEDIA_EXTERNAL_WK_RUNNER");
    for (const key of ["macos_build", "webkit_version", "app_sha256"]) {
      string(runtime[key], `WK_${key.toUpperCase()}`);
    }
    for (const key of ["app_bundle_id", "webdriver_session_id", "final_url", "user_agent"]) {
      string(runtime[key], `WK_${key.toUpperCase()}`);
    }
    if (!Number.isInteger(runtime.app_pid) || (runtime.app_pid as number) <= 1) {
      throw new Error("E_MEDIA_EXTERNAL_WK_APP_PID");
    }
    if (!(runtime.final_url as string).startsWith("http://127.0.0.1:")) {
      throw new Error("E_MEDIA_EXTERNAL_WK_FINAL_URL");
    }
    if (
      !object(runtime.codec_capabilities) ||
      Object.keys(runtime.codec_capabilities).length === 0
    ) {
      throw new Error("E_MEDIA_EXTERNAL_WK_CODEC_CAPABILITIES");
    }
  } else {
    if (runtime.runner !== "installed-release-package") {
      throw new Error("E_MEDIA_EXTERNAL_RELEASE_RUNNER");
    }
    for (const key of ["os_build", "webkit_version", "distribution_sha256", "app_sha256"]) {
      string(runtime[key], `RELEASE_${key.toUpperCase()}`);
    }
    if (runtime.optimized !== true || runtime.installed !== true) {
      throw new Error("E_MEDIA_EXTERNAL_RELEASE_NOT_INSTALLED_OPTIMIZED");
    }
  }
}

function assertRegularUnlinkedFile(path: string, label: string): Stats {
  const entry = lstatSync(path);
  if (entry.isSymbolicLink()) throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_SYMLINK:${label}`);
  if (!entry.isFile()) throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_NOT_REGULAR:${label}`);
  if (entry.nlink !== 1) throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_HARDLINK:${label}`);
  return statSync(path);
}

function assertNoSymlinkParents(root: string, path: string, label: string): void {
  const nested = relative(root, dirname(path));
  if (!nested) return;
  let current = root;
  for (const part of nested.split(sep)) {
    current = resolve(current, part);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink())
      throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_SYMLINK_PARENT:${label}`);
    if (!entry.isDirectory()) {
      throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_PARENT_NOT_DIRECTORY:${label}`);
    }
  }
}

function assertArtifacts(
  evidencePath: string,
  artifacts: unknown,
): Record<string, { sha256: string; path: string }> {
  if (!object(artifacts) || Object.keys(artifacts).length === 0) {
    throw new Error("E_MEDIA_EXTERNAL_ARTIFACTS_REQUIRED");
  }
  const absoluteEvidencePath = resolve(evidencePath);
  const root = dirname(absoluteEvidencePath);
  const rootEntry = lstatSync(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error("E_MEDIA_EXTERNAL_ARTIFACT_ROOT");
  }
  const realRoot = realpathSync(root);
  const evidenceStat = assertRegularUnlinkedFile(absoluteEvidencePath, "evidence");
  const verified: Record<string, { sha256: string; path: string }> = {};
  const verifiedInodes = new Set<string>();
  for (const [id, entry] of Object.entries(artifacts)) {
    if (!object(entry)) throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_SCHEMA:${id}`);
    const declaredPath = string(entry.path, `ARTIFACT_PATH:${id}`);
    if (isAbsolute(declaredPath) || declaredPath.split(/[\\/]/).includes("..")) {
      throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_PATH_ESCAPE:${id}`);
    }
    const path = resolve(root, declaredPath);
    const expected = string(entry.sha256, `ARTIFACT_SHA:${id}`);
    const escaped = relative(root, path);
    if (escaped.startsWith("..") || isAbsolute(escaped) || path === absoluteEvidencePath) {
      throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_PATH_ESCAPE:${id}`);
    }
    assertNoSymlinkParents(root, path, id);
    const artifactStat = assertRegularUnlinkedFile(path, id);
    const realPath = realpathSync(path);
    const realEscaped = relative(realRoot, realPath);
    if (
      realEscaped.startsWith("..") ||
      isAbsolute(realEscaped) ||
      realPath === realpathSync(absoluteEvidencePath)
    ) {
      throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_PATH_ESCAPE:${id}`);
    }
    const inode = `${artifactStat.dev}:${artifactStat.ino}`;
    if (
      (artifactStat.dev === evidenceStat.dev && artifactStat.ino === evidenceStat.ino) ||
      verifiedInodes.has(inode)
    ) {
      throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_ALIAS:${id}`);
    }
    verifiedInodes.add(inode);
    if (sha256(path) !== expected) {
      throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_DRIFT:${id}`);
    }
    verified[id] = { sha256: expected, path };
  }
  return verified;
}

function expectedOutcome(declaration: string): string {
  const mapping: Record<string, string> = {
    required_supported: "verified_supported",
    required_supported_via_proxy: "verified_via_proxy",
    required_attributed_failure: "verified_attributed_failure",
    required_explicit_fallback: "verified_explicit_fallback",
    required_fail_closed: "verified_fail_closed",
  };
  const outcome = mapping[declaration];
  if (!outcome) throw new Error(`E_MEDIA_EXTERNAL_UNKNOWN_DECLARATION:${declaration}`);
  return outcome;
}

function assertWkCells(
  cells: unknown,
  required: Record<string, string>,
  artifacts: Record<string, { sha256: string; path: string }>,
): void {
  if (!Array.isArray(cells)) throw new Error("E_MEDIA_EXTERNAL_WK_CELLS");
  const expectedIds = Object.keys(required).sort();
  const actualIds = cells.map((cell) => (object(cell) ? string(cell.id, "WK_CELL_ID") : "")).sort();
  if (!sameJson(actualIds, expectedIds)) throw new Error("E_MEDIA_EXTERNAL_WK_CELL_DENOMINATOR");
  for (const raw of cells) {
    if (!object(raw)) throw new Error("E_MEDIA_EXTERNAL_WK_CELL_SCHEMA");
    const id = string(raw.id, "WK_CELL_ID");
    if (raw.outcome !== expectedOutcome(required[id] ?? "")) {
      throw new Error(`E_MEDIA_EXTERNAL_WK_CELL_OUTCOME:${id}`);
    }
    if (!object(raw.observations) || Object.keys(raw.observations).length === 0) {
      throw new Error(`E_MEDIA_EXTERNAL_WK_CELL_OBSERVATIONS:${id}`);
    }
    const observations = raw.observations;
    const observationArtifactId = string(
      raw.observation_artifact_id,
      `WK_CELL_OBSERVATION_ARTIFACT:${id}`,
    );
    const observationArtifact = artifacts[observationArtifactId];
    if (!observationArtifact || observationArtifactId !== `cell:${id}`) {
      throw new Error(`E_MEDIA_EXTERNAL_WK_CELL_RAW_ARTIFACT:${id}`);
    }
    const rawObservation = JSON.parse(readFileSync(observationArtifact.path, "utf8")) as unknown;
    if (
      !object(rawObservation) ||
      rawObservation.id !== id ||
      rawObservation.outcome !== raw.outcome ||
      !sameJson(rawObservation.observations, observations)
    ) {
      throw new Error(`E_MEDIA_EXTERNAL_WK_CELL_RAW_MISMATCH:${id}`);
    }
    if (id.startsWith("ingest.") || id.startsWith("runtime.proxy")) {
      if (observations.decoder_path !== "mediabunny-canvas-sink-alpha") {
        throw new Error(`E_MEDIA_EXTERNAL_WK_PRODUCT_DECODER_PATH:${id}`);
      }
      if (!/^[a-f0-9]{64}$/.test(string(observations.fixture_sha256, `WK_FIXTURE_SHA:${id}`))) {
        throw new Error(`E_MEDIA_EXTERNAL_WK_FIXTURE_SHA:${id}`);
      }
      if (!/^[a-f0-9]{64}$/.test(string(observations.decoded_sha256, `WK_DECODED_SHA:${id}`))) {
        throw new Error(`E_MEDIA_EXTERNAL_WK_DECODED_SHA:${id}`);
      }
      const nonblackRatio = Number(observations.nonblack_ratio);
      const seekErrorSeconds = Number(observations.seek_error_seconds);
      if (
        observations.decoded !== true ||
        !Number.isFinite(nonblackRatio) ||
        nonblackRatio < 0.2 ||
        !Number.isFinite(seekErrorSeconds) ||
        seekErrorSeconds > 0.12
      ) {
        throw new Error(`E_MEDIA_EXTERNAL_WK_VIDEO_OBSERVATION:${id}`);
      }
      if (
        id.includes("alpha") &&
        (typeof observations.alpha_ratio !== "number" || observations.alpha_ratio < 0.2)
      ) {
        throw new Error(`E_MEDIA_EXTERNAL_WK_ALPHA_OBSERVATION:${id}`);
      }
      if (required[id] === "required_supported_via_proxy") {
        string(observations.derived_proxy_sha256, `WK_PROXY_SHA:${id}`);
      }
    } else if (id.startsWith("audio.")) {
      if (!/^[a-f0-9]{64}$/.test(string(observations.fixture_sha256, `WK_FIXTURE_SHA:${id}`))) {
        throw new Error(`E_MEDIA_EXTERNAL_WK_FIXTURE_SHA:${id}`);
      }
      if (
        !Array.isArray(observations.rms) ||
        observations.rms.length === 0 ||
        observations.rms.some((sample) => typeof sample !== "number") ||
        observations.rms.every((sample) => sample < 0.001)
      ) {
        throw new Error(`E_MEDIA_EXTERNAL_WK_AUDIO_OBSERVATION:${id}`);
      }
    } else if (id.startsWith("unsupported.")) {
      if (!/^[a-f0-9]{64}$/.test(string(observations.fixture_sha256, `WK_FIXTURE_SHA:${id}`))) {
        throw new Error(`E_MEDIA_EXTERNAL_WK_FIXTURE_SHA:${id}`);
      }
      if (observations.failed !== true || typeof observations.failure_reason !== "string") {
        throw new Error(`E_MEDIA_EXTERNAL_WK_FAILURE_OBSERVATION:${id}`);
      }
    } else if (id.startsWith("fallback.")) {
      if (
        observations.fallback_used !== true ||
        observations.fallback_kind !== "mlt-still" ||
        observations.nonblank !== true
      ) {
        throw new Error(`E_MEDIA_EXTERNAL_WK_FALLBACK_OBSERVATION:${id}`);
      }
    } else if (id.startsWith("probe.")) {
      if (observations.failed_closed !== true || observations.reason !== "ALPHA_PROBE_UNKNOWN") {
        throw new Error(`E_MEDIA_EXTERNAL_WK_FAIL_CLOSED_OBSERVATION:${id}`);
      }
    }
    if (
      !Array.isArray(raw.artifact_ids) ||
      raw.artifact_ids.length === 0 ||
      raw.artifact_ids.some((artifact) => typeof artifact !== "string" || !artifacts[artifact])
    ) {
      throw new Error(`E_MEDIA_EXTERNAL_WK_CELL_ARTIFACTS:${id}`);
    }
  }
}

function assertWkRuntimeArtifacts(
  runtime: JsonObject,
  artifacts: Record<string, { sha256: string; path: string }>,
  providerGitSha: string,
): void {
  const binaryId = string(runtime.app_binary_artifact_id, "WK_APP_BINARY_ARTIFACT");
  const reportId = string(runtime.provider_report_artifact_id, "WK_PROVIDER_REPORT_ARTIFACT");
  const binary = artifacts[binaryId];
  const report = artifacts[reportId];
  if (!binary || binaryId !== "runtime:app-binary") {
    throw new Error("E_MEDIA_EXTERNAL_WK_APP_BINARY_ARTIFACT");
  }
  if (!report || reportId !== "runtime:provider-report") {
    throw new Error("E_MEDIA_EXTERNAL_WK_PROVIDER_REPORT_ARTIFACT");
  }
  if (binary.sha256 !== runtime.app_sha256) throw new Error("E_MEDIA_EXTERNAL_WK_APP_BINARY_HASH");
  const providerReport = JSON.parse(readFileSync(report.path, "utf8")) as unknown;
  if (
    !object(providerReport) ||
    !object(providerReport.process) ||
    !object(providerReport.runtime) ||
    providerReport.sourceSha !== providerGitSha ||
    providerReport.process.executableHash !== runtime.app_sha256 ||
    providerReport.process.observedBundleId !== runtime.app_bundle_id ||
    providerReport.runtime.finalUrl !== runtime.final_url ||
    providerReport.runtime.webkitVersion !== runtime.webkit_version
  ) {
    throw new Error("E_MEDIA_EXTERNAL_WK_PROVIDER_REPORT_MISMATCH");
  }
}

function assertPerformance(
  performance: unknown,
  sampling: NonNullable<ExternalMediaEvidenceOptions["performanceSampling"]>,
  budgets: NonNullable<ExternalMediaEvidenceOptions["performanceBudgets"]>,
  caps: NonNullable<ExternalMediaEvidenceOptions["functionalCaps"]>,
  artifacts: Record<string, { sha256: string; path: string }>,
): void {
  if (!object(performance)) throw new Error("E_MEDIA_EXTERNAL_RELEASE_PERFORMANCE");
  if (performance.warmup_runs !== sampling.warmupRuns) {
    throw new Error("E_MEDIA_EXTERNAL_RELEASE_WARMUPS");
  }
  const rawArtifactId = string(performance.raw_artifact_id, "RELEASE_RAW_ARTIFACT_ID");
  const raw = artifacts[rawArtifactId];
  if (!raw) throw new Error("E_MEDIA_EXTERNAL_RELEASE_RAW_ARTIFACT");
  verifyPerformanceRawArtifact({
    artifactPath: raw.path,
    expectedSha256: raw.sha256,
    sampling: { measuredRuns: sampling.measuredRuns, samplesPerRun: sampling.samplesPerRun },
    budgets,
    caps,
  });
}

export function verifyExternalMediaEvidence(options: ExternalMediaEvidenceOptions): JsonObject {
  const evidencePath = resolve(options.evidencePath);
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as unknown;
  if (!object(evidence)) throw new Error("E_MEDIA_EXTERNAL_SCHEMA");
  if (evidence.schema_version !== "1.0.0" || evidence.evidence_kind !== options.kind) {
    throw new Error("E_MEDIA_EXTERNAL_KIND_OR_VERSION");
  }
  if (evidence.status !== "verified") throw new Error("E_MEDIA_EXTERNAL_NOT_VERIFIED");
  if (evidence.fixture_manifest_sha256 !== options.fixtureManifestSha256) {
    throw new Error("E_MEDIA_EXTERNAL_FIXTURE_LINEAGE");
  }
  if (!sameJson(evidence.policy_sha256s, options.policySha256s)) {
    throw new Error("E_MEDIA_EXTERNAL_POLICY_LINEAGE");
  }
  const providerGitSha = assertSourceIdentity(
    evidence.source,
    options.expectedSourceGitSha,
    options.expectedSourceGitTreeHash,
  );
  assertRuntime(options.kind, evidence.runtime);
  const artifacts = assertArtifacts(evidencePath, evidence.artifacts);
  if (options.kind === "wkwebview-media-runtime") {
    if (!options.requiredCellOutcomes) throw new Error("E_MEDIA_EXTERNAL_WK_DECLARATIONS");
    assertWkRuntimeArtifacts(evidence.runtime as JsonObject, artifacts, providerGitSha);
    assertWkCells(evidence.cells, options.requiredCellOutcomes, artifacts);
  } else {
    if (!options.performanceSampling || !options.performanceBudgets || !options.functionalCaps) {
      throw new Error("E_MEDIA_EXTERNAL_RELEASE_POLICY");
    }
    assertPerformance(
      evidence.performance,
      options.performanceSampling,
      options.performanceBudgets,
      options.functionalCaps,
      artifacts,
    );
  }
  return {
    ...evidence,
    evidence_sha256: sha256(evidencePath),
    verified_artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([id, artifact]) => [id, artifact.sha256]),
    ),
  };
}
