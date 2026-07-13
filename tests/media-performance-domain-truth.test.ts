import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type PerformanceBudgets,
  verifyPerformanceRawArtifact,
} from "../scripts/harness/media-performance-domain-truth";

const signature = "a".repeat(64);
const frame = () => ({ valid: true, nonblack_ratio: 0.8, signature_sha256: signature });
function run() {
  return {
    run_id: "run",
    workloads: {
      cold_proxy_build: { duration_ms: 50, cached: false, valid_proxy: true },
      warm_proxy_cache: { duration_ms: 5, cached: true, valid_proxy: true },
      project_open_valid_frame: { duration_ms: 40, frame: frame() },
      seek_to_valid_frame: {
        samples: [{ duration_ms: 8, requested_frame: 10, observed_frame: 10, frame: frame() }],
      },
      playback_av_skew: { samples: [{ skew_frames: 0.2 }] },
      queue_drain: {
        samples: [
          { at_ms: 0, workers: 4, in_flight: 2, queued: 3, cache_bytes: 100 },
          { at_ms: 20, workers: 4, in_flight: 0, queued: 0, cache_bytes: 100 },
        ],
      },
      context_recovery_valid_frame: { duration_ms: 30, frame: frame() },
      memory: {
        samples: [
          { at_ms: 0, rss_bytes: 100_000_000, cache_bytes: 100 },
          { at_ms: 60_000, rss_bytes: 100_100_000, cache_bytes: 100 },
        ],
      },
      teardown: {
        duration_ms: 10,
        resource_events: [
          { op: "open", kind: "decoder-worker", id: "0" },
          { op: "close", kind: "decoder-worker", id: "0" },
        ],
      },
      failures: { crashes: [], page_errors: [], black_frames: [], stalls: [] },
      compositor_microbenchmark: { raw_samples: [1, 2, 3] },
    },
  };
}

const caps = {
  decoder_workers_max: 4,
  in_flight_decodes_max: 8,
  steady_queue_max: 8,
  cache_resident_bytes_max: 500,
  owned_handle_open_close_balance_required: true,
  crashes_unhandled_errors_black_frames_stalls_max: 0,
};
const budgets: PerformanceBudgets = {
  composite_p95_ms: 3,
  composite_max_ms: 3,
  cold_proxy_build_p95_ms: 100,
  warm_proxy_cache_p95_ms: 10,
  warm_seek_valid_frame_p95_ms: 10,
  playhead_audio_skew_p95_frames: 1,
  queue_drain_after_scrub_ms: 25,
  context_loss_valid_frame_ms: 50,
  warm_project_open_valid_frame_ms: 50,
  teardown_p95_ms: 20,
  post_warm_memory_slope_mib_per_min: 1,
  absolute_process_memory_ceiling_mib: 200,
};

function fixture(mutator?: (value: ReturnType<typeof makeArtifact>) => void) {
  const root = mkdtempSync(join(tmpdir(), "vean-performance-truth-"));
  const path = join(root, "raw.json");
  const value = makeArtifact();
  mutator?.(value);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
}
function makeArtifact() {
  return { schema_version: "2.0.0", kind: "vean-product-performance-raw", runs: [run(), run()] };
}
function verify(path: string, expectedSha256?: string) {
  return verifyPerformanceRawArtifact({
    artifactPath: path,
    expectedSha256,
    sampling: { measuredRuns: 2, samplesPerRun: 3 },
    caps,
    budgets,
  });
}
function first(value: ReturnType<typeof makeArtifact>) {
  const run = value.runs[0];
  if (!run) throw new Error("test fixture missing run");
  return run;
}

describe("media performance domain truth", () => {
  it("independently derives every declared product workload and labels composite as a microbenchmark", () => {
    const raw = fixture();
    expect(verify(raw.path, raw.sha256)).toMatchObject({
      summary: {
        cold_proxy_build_p95_ms: 50,
        warm_proxy_cache_p95_ms: 5,
        warm_seek_valid_frame_p95_ms: 8,
        playhead_audio_skew_p95_frames: 0.2,
        queue_drain_after_scrub_p95_ms: 20,
        context_loss_valid_frame_p95_ms: 30,
        warm_project_open_valid_frame_p95_ms: 40,
        teardown_p95_ms: 10,
        composite_microbenchmark_p95_ms: 3,
      },
    });
  });

  it.each([
    [
      "delay",
      (value: ReturnType<typeof makeArtifact>) => {
        const sample = first(value).workloads.seek_to_valid_frame.samples[0];
        if (!sample) throw new Error("test fixture missing seek sample");
        sample.duration_ms = 500;
      },
      "warm_seek_valid_frame_p95_ms",
    ],
    [
      "leak",
      (value: ReturnType<typeof makeArtifact>) => {
        first(value).workloads.teardown.resource_events.pop();
      },
      "E_MEDIA_PERF_RESOURCE_LEAK",
    ],
    [
      "skew",
      (value: ReturnType<typeof makeArtifact>) => {
        const sample = first(value).workloads.playback_av_skew.samples[0];
        if (!sample) throw new Error("test fixture missing skew sample");
        sample.skew_frames = 3;
      },
      "playhead_audio_skew_p95_frames",
    ],
    [
      "never-drain",
      (value: ReturnType<typeof makeArtifact>) => {
        const sample = first(value).workloads.queue_drain.samples[1];
        if (!sample) throw new Error("test fixture missing drain sample");
        sample.in_flight = 1;
      },
      "E_MEDIA_PERF_QUEUE_NEVER_DRAINED",
    ],
    [
      "context-blank",
      (value: ReturnType<typeof makeArtifact>) => {
        first(value).workloads.context_recovery_valid_frame.frame.valid = false;
      },
      "E_MEDIA_PERF_RECOVERY_FRAME",
    ],
  ])("rejects the targeted %s control", (_name, mutate, code) => {
    const raw = fixture(mutate);
    expect(() => verify(raw.path)).toThrow(String(code));
  });

  it("rejects an inline declaration that no longer matches the hashed raw artifact", () => {
    const raw = fixture();
    writeFileSync(raw.path, `${JSON.stringify({ ...makeArtifact(), producer_ok: true })}\n`);
    expect(() => verify(raw.path, raw.sha256)).toThrow("E_MEDIA_PERF_ARTIFACT_DRIFT");
  });
});
