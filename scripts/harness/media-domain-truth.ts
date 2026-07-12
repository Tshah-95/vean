import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

export type ExternalMediaEvidenceKind = "wkwebview-media-runtime" | "release-package-performance";

export type ExternalMediaEvidenceOptions = {
  evidencePath: string;
  kind: ExternalMediaEvidenceKind;
  fixtureManifestSha256: string;
  policySha256s: Record<string, string>;
  requiredCellOutcomes?: Record<string, string>;
  performanceSampling?: {
    warmupRuns: number;
    measuredRuns: number;
    samplesPerRun: number;
  };
  performanceBudgets?: { composite_p95_ms: number; composite_max_ms: number };
  functionalCaps?: {
    decoder_workers_max: number;
    in_flight_decodes_max: number;
    steady_queue_max: number;
    queue_must_drain_to_zero_after_scrub: boolean;
    cache_resident_bytes_max: number;
    owned_handle_open_close_balance_required: boolean;
    crashes_unhandled_errors_black_frames_stalls_max: number;
    context_restore_requires_content_valid_frame: boolean;
  };
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

function assertSourceIdentity(source: unknown): void {
  if (!object(source)) throw new Error("E_MEDIA_EXTERNAL_SOURCE_IDENTITY");
  if (!/^[a-f0-9]{40,64}$/.test(string(source.git_sha, "SOURCE_SHA"))) {
    throw new Error("E_MEDIA_EXTERNAL_SOURCE_SHA");
  }
  if (!/^[a-f0-9]{40,64}$/.test(string(source.git_tree_hash, "SOURCE_TREE"))) {
    throw new Error("E_MEDIA_EXTERNAL_SOURCE_TREE");
  }
  if (source.git_status_clean !== true) throw new Error("E_MEDIA_EXTERNAL_SOURCE_DIRTY");
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

function assertArtifacts(
  evidencePath: string,
  artifacts: unknown,
): Record<string, { sha256: string; path: string }> {
  if (!object(artifacts) || Object.keys(artifacts).length === 0) {
    throw new Error("E_MEDIA_EXTERNAL_ARTIFACTS_REQUIRED");
  }
  const root = dirname(resolve(evidencePath));
  const verified: Record<string, { sha256: string; path: string }> = {};
  for (const [id, entry] of Object.entries(artifacts)) {
    if (!object(entry)) throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_SCHEMA:${id}`);
    const path = resolve(root, string(entry.path, `ARTIFACT_PATH:${id}`));
    const expected = string(entry.sha256, `ARTIFACT_SHA:${id}`);
    const escaped = relative(root, path);
    if (escaped.startsWith("..") || resolve(path) === resolve(evidencePath)) {
      throw new Error(`E_MEDIA_EXTERNAL_ARTIFACT_PATH_ESCAPE:${id}`);
    }
    if (!statSync(path).isFile() || sha256(path) !== expected) {
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

function nearestRank(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)] ?? 0;
}

function assertPerformance(
  performance: unknown,
  sampling: NonNullable<ExternalMediaEvidenceOptions["performanceSampling"]>,
  budgets: NonNullable<ExternalMediaEvidenceOptions["performanceBudgets"]>,
  caps: NonNullable<ExternalMediaEvidenceOptions["functionalCaps"]>,
  artifactIds: Set<string>,
): void {
  if (!object(performance)) throw new Error("E_MEDIA_EXTERNAL_RELEASE_PERFORMANCE");
  if (performance.warmup_runs !== sampling.warmupRuns) {
    throw new Error("E_MEDIA_EXTERNAL_RELEASE_WARMUPS");
  }
  if (
    !Array.isArray(performance.distributions) ||
    performance.distributions.length !== sampling.measuredRuns
  ) {
    throw new Error("E_MEDIA_EXTERNAL_RELEASE_DISTRIBUTIONS");
  }
  for (const [index, raw] of performance.distributions.entries()) {
    if (!object(raw) || !Array.isArray(raw.raw_samples)) {
      throw new Error(`E_MEDIA_EXTERNAL_RELEASE_DISTRIBUTION_SCHEMA:${index}`);
    }
    const samples = raw.raw_samples;
    if (
      samples.length !== sampling.samplesPerRun ||
      samples.some((sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample < 0)
    ) {
      throw new Error(`E_MEDIA_EXTERNAL_RELEASE_RAW_SAMPLES:${index}`);
    }
    if (
      raw.p50 !== nearestRank(samples, 50) ||
      raw.p95 !== nearestRank(samples, 95) ||
      raw.max !== Math.max(...samples)
    ) {
      throw new Error(`E_MEDIA_EXTERNAL_RELEASE_DERIVED_METRICS:${index}`);
    }
  }
  const distributions = performance.distributions as Array<JsonObject>;
  if (Math.max(...distributions.map((entry) => entry.p95 as number)) > budgets.composite_p95_ms) {
    throw new Error("E_MEDIA_EXTERNAL_RELEASE_COMPOSITE_P95_BUDGET");
  }
  if (Math.max(...distributions.map((entry) => entry.max as number)) > budgets.composite_max_ms) {
    throw new Error("E_MEDIA_EXTERNAL_RELEASE_COMPOSITE_MAX_BUDGET");
  }
  const observed = performance.functional_caps;
  if (!object(observed)) {
    throw new Error("E_MEDIA_EXTERNAL_RELEASE_FUNCTIONAL_CAPS");
  }
  const capPass =
    typeof observed.decoder_workers_max_observed === "number" &&
    observed.decoder_workers_max_observed <= caps.decoder_workers_max &&
    typeof observed.in_flight_decodes_max_observed === "number" &&
    observed.in_flight_decodes_max_observed <= caps.in_flight_decodes_max &&
    typeof observed.steady_queue_max_observed === "number" &&
    observed.steady_queue_max_observed <= caps.steady_queue_max &&
    observed.queue_drained_to_zero === caps.queue_must_drain_to_zero_after_scrub &&
    typeof observed.cache_resident_bytes_max_observed === "number" &&
    observed.cache_resident_bytes_max_observed <= caps.cache_resident_bytes_max &&
    observed.owned_handle_balance === caps.owned_handle_open_close_balance_required &&
    typeof observed.crashes_unhandled_errors_black_frames_stalls === "number" &&
    observed.crashes_unhandled_errors_black_frames_stalls <=
      caps.crashes_unhandled_errors_black_frames_stalls_max &&
    observed.context_restore_valid_frame === caps.context_restore_requires_content_valid_frame;
  if (!capPass) throw new Error("E_MEDIA_EXTERNAL_RELEASE_FUNCTIONAL_CAPS");
  if (
    !Array.isArray(performance.artifact_ids) ||
    performance.artifact_ids.length === 0 ||
    performance.artifact_ids.some(
      (artifact) => typeof artifact !== "string" || !artifactIds.has(artifact),
    )
  ) {
    throw new Error("E_MEDIA_EXTERNAL_RELEASE_ARTIFACTS");
  }
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
  assertSourceIdentity(evidence.source);
  assertRuntime(options.kind, evidence.runtime);
  const artifacts = assertArtifacts(evidencePath, evidence.artifacts);
  const artifactIds = new Set(Object.keys(artifacts));
  if (options.kind === "wkwebview-media-runtime") {
    if (!options.requiredCellOutcomes) throw new Error("E_MEDIA_EXTERNAL_WK_DECLARATIONS");
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
      artifactIds,
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
