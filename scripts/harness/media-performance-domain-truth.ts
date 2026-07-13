import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type Json = Record<string, unknown>;

export type PerformanceBudgets = {
  composite_p95_ms: number;
  composite_max_ms: number;
  cold_proxy_build_p95_ms: number;
  warm_proxy_cache_p95_ms: number;
  warm_seek_valid_frame_p95_ms: number;
  playhead_audio_skew_p95_frames: number;
  queue_drain_after_scrub_ms: number;
  context_loss_valid_frame_ms: number;
  warm_project_open_valid_frame_ms: number;
  teardown_p95_ms: number;
  post_warm_memory_slope_mib_per_min: number;
  absolute_process_memory_ceiling_mib: number;
};

export type PerformanceCaps = {
  decoder_workers_max: number;
  in_flight_decodes_max: number;
  steady_queue_max: number;
  cache_resident_bytes_max: number;
  owned_handle_open_close_balance_required: boolean;
  crashes_unhandled_errors_black_frames_stalls_max: number;
};

export type PerformanceSampling = {
  measuredRuns: number;
  samplesPerRun: number;
};

function object(value: unknown, code: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(code);
  return value as Json;
}

function finite(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(code);
  return value;
}

function bool(value: unknown, code: string): boolean {
  if (typeof value !== "boolean") throw new Error(code);
  return value;
}

function array(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(code);
  return value;
}

function nearestRank(values: number[], percentile: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)] ?? 0;
}

function durations(runs: Json[], key: string): number[] {
  return runs.map((run, index) =>
    finite(
      object(
        object(run.workloads, `E_MEDIA_PERF_WORKLOADS:${index}`)[key],
        `E_MEDIA_PERF_${key}:${index}`,
      ).duration_ms,
      `E_MEDIA_PERF_${key}_DURATION:${index}`,
    ),
  );
}

function validFrame(value: unknown, code: string): Json {
  const frame = object(value, code);
  if (
    !bool(frame.valid, `${code}_VALID`) ||
    finite(frame.nonblack_ratio, `${code}_NONBLACK`) < 0.01
  ) {
    throw new Error(`${code}_CONTENT`);
  }
  if (
    typeof frame.signature_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(frame.signature_sha256)
  ) {
    throw new Error(`${code}_SIGNATURE`);
  }
  return frame;
}

function slopeMiBPerMinute(samples: unknown, code: string): number {
  const points = array(samples, code).map((raw, index) => {
    const point = object(raw, `${code}:${index}`);
    return {
      x: finite(point.at_ms, `${code}_AT:${index}`) / 60_000,
      y: finite(point.rss_bytes, `${code}_RSS:${index}`) / 1_048_576,
    };
  });
  if (points.length < 2) throw new Error(`${code}_COUNT`);
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / points.length;
  const denominator = points.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (denominator === 0) throw new Error(`${code}_SPAN`);
  return (
    points.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / denominator
  );
}

function handleBalance(events: unknown, code: string): boolean {
  const balances = new Map<string, number>();
  for (const [index, raw] of array(events, code).entries()) {
    const event = object(raw, `${code}:${index}`);
    if (event.op !== "open" && event.op !== "close") throw new Error(`${code}_OP:${index}`);
    if (typeof event.kind !== "string" || typeof event.id !== "string")
      throw new Error(`${code}_ID:${index}`);
    const key = `${event.kind}:${event.id}`;
    balances.set(key, (balances.get(key) ?? 0) + (event.op === "open" ? 1 : -1));
  }
  return [...balances.values()].every((balance) => balance === 0);
}

export function verifyPerformanceRawArtifact(input: {
  artifactPath: string;
  expectedSha256?: string;
  sampling: PerformanceSampling;
  caps: PerformanceCaps;
  budgets?: PerformanceBudgets;
}): Json {
  const bytes = readFileSync(input.artifactPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (input.expectedSha256 && sha256 !== input.expectedSha256)
    throw new Error("E_MEDIA_PERF_ARTIFACT_DRIFT");
  const artifact = object(JSON.parse(bytes.toString("utf8")), "E_MEDIA_PERF_ARTIFACT_SCHEMA");
  if (artifact.schema_version !== "2.0.0" || artifact.kind !== "vean-product-performance-raw") {
    throw new Error("E_MEDIA_PERF_ARTIFACT_VERSION");
  }
  const runs = array(artifact.runs, "E_MEDIA_PERF_RUNS").map((run, index) =>
    object(run, `E_MEDIA_PERF_RUN:${index}`),
  );
  if (runs.length !== input.sampling.measuredRuns) throw new Error("E_MEDIA_PERF_RUN_COUNT");

  const cold = durations(runs, "cold_proxy_build");
  const warm = durations(runs, "warm_proxy_cache");
  const open = durations(runs, "project_open_valid_frame");
  const teardown = durations(runs, "teardown");
  const seeks: number[] = [];
  const skews: number[] = [];
  const drains: number[] = [];
  const recoveries: number[] = [];
  const slopes: number[] = [];
  const rssMaxima: number[] = [];
  const composite: number[] = [];
  let maxWorkers = 0;
  let maxInflight = 0;
  let maxQueue = 0;
  let maxCache = 0;
  let failureCount = 0;

  for (const [runIndex, run] of runs.entries()) {
    const workloads = object(run.workloads, `E_MEDIA_PERF_WORKLOADS:${runIndex}`);
    const coldWork = object(workloads.cold_proxy_build, `E_MEDIA_PERF_COLD:${runIndex}`);
    const warmWork = object(workloads.warm_proxy_cache, `E_MEDIA_PERF_WARM:${runIndex}`);
    if (
      coldWork.cached !== false ||
      warmWork.cached !== true ||
      !bool(coldWork.valid_proxy, `E_MEDIA_PERF_COLD_VALID:${runIndex}`) ||
      !bool(warmWork.valid_proxy, `E_MEDIA_PERF_WARM_VALID:${runIndex}`)
    ) {
      throw new Error(`E_MEDIA_PERF_PROXY_TRUTH:${runIndex}`);
    }
    validFrame(
      object(workloads.project_open_valid_frame, "E_MEDIA_PERF_OPEN").frame,
      `E_MEDIA_PERF_OPEN_FRAME:${runIndex}`,
    );

    const seekWork = object(workloads.seek_to_valid_frame, `E_MEDIA_PERF_SEEK:${runIndex}`);
    for (const [index, raw] of array(
      seekWork.samples,
      `E_MEDIA_PERF_SEEK_SAMPLES:${runIndex}`,
    ).entries()) {
      const sample = object(raw, `E_MEDIA_PERF_SEEK_SAMPLE:${runIndex}:${index}`);
      seeks.push(finite(sample.duration_ms, `E_MEDIA_PERF_SEEK_DURATION:${runIndex}:${index}`));
      validFrame(sample.frame, `E_MEDIA_PERF_SEEK_FRAME:${runIndex}:${index}`);
      if (sample.requested_frame !== sample.observed_frame)
        throw new Error(`E_MEDIA_PERF_SEEK_POSITION:${runIndex}:${index}`);
    }

    const av = object(workloads.playback_av_skew, `E_MEDIA_PERF_AV:${runIndex}`);
    for (const [index, raw] of array(av.samples, `E_MEDIA_PERF_AV_SAMPLES:${runIndex}`).entries()) {
      const sample = object(raw, `E_MEDIA_PERF_AV_SAMPLE:${runIndex}:${index}`);
      skews.push(finite(sample.skew_frames, `E_MEDIA_PERF_AV_SKEW:${runIndex}:${index}`));
    }

    const drain = object(workloads.queue_drain, `E_MEDIA_PERF_DRAIN:${runIndex}`);
    const drainSamples = array(drain.samples, `E_MEDIA_PERF_DRAIN_SAMPLES:${runIndex}`).map(
      (raw, index) => object(raw, `E_MEDIA_PERF_DRAIN_SAMPLE:${runIndex}:${index}`),
    );
    const zero = drainSamples.find((sample) => sample.queued === 0 && sample.in_flight === 0);
    if (!zero) throw new Error(`E_MEDIA_PERF_QUEUE_NEVER_DRAINED:${runIndex}`);
    drains.push(finite(zero.at_ms, `E_MEDIA_PERF_DRAIN_AT:${runIndex}`));
    for (const sample of drainSamples) {
      maxWorkers = Math.max(maxWorkers, finite(sample.workers, `E_MEDIA_PERF_WORKERS:${runIndex}`));
      maxInflight = Math.max(
        maxInflight,
        finite(sample.in_flight, `E_MEDIA_PERF_INFLIGHT:${runIndex}`),
      );
      maxQueue = Math.max(maxQueue, finite(sample.queued, `E_MEDIA_PERF_QUEUE:${runIndex}`));
      maxCache = Math.max(maxCache, finite(sample.cache_bytes, `E_MEDIA_PERF_CACHE:${runIndex}`));
    }

    const recovery = object(
      workloads.context_recovery_valid_frame,
      `E_MEDIA_PERF_RECOVERY:${runIndex}`,
    );
    recoveries.push(finite(recovery.duration_ms, `E_MEDIA_PERF_RECOVERY_DURATION:${runIndex}`));
    validFrame(recovery.frame, `E_MEDIA_PERF_RECOVERY_FRAME:${runIndex}`);

    const memory = object(workloads.memory, `E_MEDIA_PERF_MEMORY:${runIndex}`);
    slopes.push(slopeMiBPerMinute(memory.samples, `E_MEDIA_PERF_MEMORY_SAMPLES:${runIndex}`));
    for (const raw of array(memory.samples, `E_MEDIA_PERF_MEMORY_SAMPLES:${runIndex}`)) {
      const point = object(raw, "E_MEDIA_PERF_MEMORY_POINT");
      rssMaxima.push(finite(point.rss_bytes, "E_MEDIA_PERF_MEMORY_RSS"));
      maxCache = Math.max(maxCache, finite(point.cache_bytes, "E_MEDIA_PERF_MEMORY_CACHE"));
    }

    const tear = object(workloads.teardown, `E_MEDIA_PERF_TEARDOWN:${runIndex}`);
    if (!handleBalance(tear.resource_events, `E_MEDIA_PERF_RESOURCE_EVENTS:${runIndex}`)) {
      throw new Error(`E_MEDIA_PERF_RESOURCE_LEAK:${runIndex}`);
    }
    const failures = object(workloads.failures, `E_MEDIA_PERF_FAILURES:${runIndex}`);
    for (const key of ["crashes", "page_errors", "black_frames", "stalls"] as const) {
      failureCount += arrayOrEmpty(failures[key], `E_MEDIA_PERF_FAILURE_${key}:${runIndex}`).length;
    }
    const micro = object(workloads.compositor_microbenchmark, `E_MEDIA_PERF_COMPOSITE:${runIndex}`);
    const rawSamples = array(micro.raw_samples, `E_MEDIA_PERF_COMPOSITE_SAMPLES:${runIndex}`).map(
      (value, index) => finite(value, `E_MEDIA_PERF_COMPOSITE_SAMPLE:${runIndex}:${index}`),
    );
    if (rawSamples.length !== input.sampling.samplesPerRun)
      throw new Error(`E_MEDIA_PERF_COMPOSITE_COUNT:${runIndex}`);
    composite.push(...rawSamples);
  }

  if (
    maxWorkers > input.caps.decoder_workers_max ||
    maxInflight > input.caps.in_flight_decodes_max ||
    maxQueue > input.caps.steady_queue_max ||
    maxCache > input.caps.cache_resident_bytes_max ||
    failureCount > input.caps.crashes_unhandled_errors_black_frames_stalls_max
  ) {
    throw new Error("E_MEDIA_PERF_FUNCTIONAL_CAP");
  }
  if (input.caps.owned_handle_open_close_balance_required !== true)
    throw new Error("E_MEDIA_PERF_HANDLE_POLICY");

  const summary: Json = {
    cold_proxy_build_p95_ms: nearestRank(cold, 95),
    warm_proxy_cache_p95_ms: nearestRank(warm, 95),
    warm_seek_valid_frame_p95_ms: nearestRank(seeks, 95),
    playhead_audio_skew_p95_frames: nearestRank(skews, 95),
    queue_drain_after_scrub_p95_ms: nearestRank(drains, 95),
    context_loss_valid_frame_p95_ms: nearestRank(recoveries, 95),
    warm_project_open_valid_frame_p95_ms: nearestRank(open, 95),
    teardown_p95_ms: nearestRank(teardown, 95),
    post_warm_memory_slope_max_mib_per_min: Math.max(...slopes),
    absolute_process_memory_max_mib: Math.max(...rssMaxima) / 1_048_576,
    composite_microbenchmark_p95_ms: nearestRank(composite, 95),
    composite_microbenchmark_max_ms: Math.max(...composite),
    observed_caps: {
      decoder_workers: maxWorkers,
      in_flight_decodes: maxInflight,
      queue: maxQueue,
      cache_bytes: maxCache,
      failures: failureCount,
    },
  };
  if (input.budgets) assertBudgets(summary, input.budgets);
  return { artifact_sha256: sha256, summary };
}

function arrayOrEmpty(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(code);
  return value;
}

function assertBudgets(summary: Json, budgets: PerformanceBudgets): void {
  const checks: Array<[keyof PerformanceBudgets, string]> = [
    ["cold_proxy_build_p95_ms", "cold_proxy_build_p95_ms"],
    ["warm_proxy_cache_p95_ms", "warm_proxy_cache_p95_ms"],
    ["warm_seek_valid_frame_p95_ms", "warm_seek_valid_frame_p95_ms"],
    ["playhead_audio_skew_p95_frames", "playhead_audio_skew_p95_frames"],
    ["queue_drain_after_scrub_ms", "queue_drain_after_scrub_p95_ms"],
    ["context_loss_valid_frame_ms", "context_loss_valid_frame_p95_ms"],
    ["warm_project_open_valid_frame_ms", "warm_project_open_valid_frame_p95_ms"],
    ["teardown_p95_ms", "teardown_p95_ms"],
    ["post_warm_memory_slope_mib_per_min", "post_warm_memory_slope_max_mib_per_min"],
    ["absolute_process_memory_ceiling_mib", "absolute_process_memory_max_mib"],
    ["composite_p95_ms", "composite_microbenchmark_p95_ms"],
    ["composite_max_ms", "composite_microbenchmark_max_ms"],
  ];
  for (const [budgetKey, summaryKey] of checks) {
    if (
      finite(summary[summaryKey], `E_MEDIA_PERF_SUMMARY:${summaryKey}`) >
      finite(budgets[budgetKey], `E_MEDIA_PERF_BUDGET:${budgetKey}`)
    ) {
      throw new Error(`E_MEDIA_PERF_BUDGET_EXCEEDED:${budgetKey}`);
    }
  }
}
