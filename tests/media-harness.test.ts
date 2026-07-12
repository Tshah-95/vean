import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  mediaClaimControlIds,
  mediaOracleImplementationPaths,
  prepareMediaControl,
} from "../scripts/harness/media-control";
import { verifyExternalMediaEvidence } from "../scripts/harness/media-domain-truth";
import { MediaResourceLedger } from "../viewer/src/test-bridge/resourceLedger";

const repo = resolve(import.meta.dirname, "..");
const readJson = (path: string) => JSON.parse(readFileSync(resolve(repo, path), "utf8"));
const hash = (path: string) =>
  createHash("sha256")
    .update(readFileSync(resolve(repo, path)))
    .digest("hex");

describe("H07 media assurance contract", () => {
  it("keeps all draft policies non-accepting and generation separate", () => {
    const matrix = readJson("artifacts/specs/media-runtime-matrix.json");
    const golden = readJson("artifacts/specs/media-golden-policy.json");
    const performance = readJson("artifacts/specs/media-performance-policy.json");
    expect([matrix.status, golden.status, performance.status]).toEqual(["draft", "draft", "draft"]);
    expect(golden.generation.acceptance_may_generate).toBe(false);
    expect(performance.proposed_user_visible_budgets.approval_required).toBe(true);
    const refused = spawnSync("bun", ["scripts/verify-media.ts", "--suite", "performance"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(refused.status).not.toBe(0);
    expect(`${refused.stdout}${refused.stderr}`).toContain("E_MEDIA_POLICY_UNAPPROVED");
  });

  it("binds every generated fixture to bytes and provenance", () => {
    const manifestPath = resolve(repo, "corpus/harness/media/manifest.json");
    const manifest = readJson("corpus/harness/media/manifest.json");
    expect(manifest.license).toContain("repo-authored synthetic");
    expect(manifest.generator.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.entries).toHaveLength(12);
    for (const entry of manifest.entries) {
      const path = resolve(dirname(manifestPath), entry.relative_path);
      expect(hash(path)).toBe(entry.source_sha256);
      expect(statSync(path).size).toBe(entry.byte_length);
      expect(entry.argv.length).toBeGreaterThan(1);
      expect(entry.license).toContain("synthetic");
    }
  });

  it("candidate goldens can never masquerade as acceptance", () => {
    const candidate = readJson("corpus/harness/media/candidate-goldens/manifest.json");
    expect(candidate.status).toBe("candidate-unapproved");
    expect(candidate.acceptance_eligible).toBe(false);
    expect(candidate.frames.map((frame: { master_frame: number }) => frame.master_frame)).toEqual([
      29, 30, 36, 42, 48, 56, 75, 119, 120,
    ]);
    expect(
      candidate.frames.filter((frame: { expected_presence: boolean }) => frame.expected_presence),
    ).toHaveLength(7);
    for (const frame of candidate.frames.filter(
      (entry: { expected_presence: boolean }) => entry.expected_presence,
    )) {
      expect(hash(`corpus/harness/media/${frame.remotion_renderstill.relative_path}`)).toBe(
        frame.remotion_renderstill.sha256,
      );
      expect(hash(`corpus/harness/media/${frame.mlt_still.relative_path}`)).toBe(
        frame.mlt_still.sha256,
      );
      expect(frame.semantic_markers.frame_mapping).toBe(true);
    }
    expect(readFileSync(resolve(repo, "corpus/harness/media/manifest.json"), "utf8")).not.toMatch(
      /\/Users\/|\/home\//,
    );
  });

  it("detects application-owned handle imbalance independent of GC", () => {
    const ledger = new MediaResourceLedger();
    ledger.open("image-bitmap", "frame-1");
    expect(ledger.snapshot()).toMatchObject({
      balanced: false,
      outstanding: [{ kind: "image-bitmap", id: "frame-1" }],
    });
    ledger.close("image-bitmap", "frame-1");
    expect(ledger.snapshot()).toMatchObject({ balanced: true, outstanding: [] });
    expect(() => ledger.close("image-bitmap", "frame-1")).toThrow(/without ownership/);
  });

  it("requires every independent result section and negative control", () => {
    const ledger = readJson("artifacts/specs/harness-scenarios/media.json");
    expect(ledger.sections).toEqual([
      "live.chrome",
      "live.wkwebview",
      "render.remotion",
      "render.mlt",
      "resilience",
      "performance",
      "performance.release-package",
      "live-export-parity",
    ]);
    expect(ledger.negative_controls).toEqual(
      expect.arrayContaining([
        "missing-imagebitmap-close",
        "opaque-alpha-substitution",
        "wrong-frame-timestamp",
        "silent-audio",
        "swapped-audio-channel",
        "unrestored-webgl-context-loss",
        "injected-long-task",
        "unapproved-policy",
        "golden-regeneration-during-acceptance",
      ]),
    );
  });

  it("maps every H07 claim control to a real scenario control and exact implementation set", () => {
    const expected = {
      "nc-live-media": "opaque-alpha-substitution",
      "nc-render-fidelity": "opaque-alpha-substitution",
      "nc-media-resilience": "missing-imagebitmap-close",
      "nc-performance-budget": "injected-long-task",
      "nc-live-export-semantic-parity": "wrong-frame-timestamp",
    };
    expect(mediaClaimControlIds).toEqual(Object.keys(expected));
    for (const controlId of mediaClaimControlIds) {
      const plan = prepareMediaControl(controlId);
      expect(plan.scenario_control).toBe(expected[controlId]);
      expect(plan.before_hash).not.toBe(plan.mutated_hash);
      const mutation = JSON.parse(readFileSync(plan.manifestPath, "utf8"));
      expect(mutation.changed_paths).toHaveLength(1);
      expect(mutation.scenario_control).toBe(expected[controlId]);
    }
    for (const path of mediaOracleImplementationPaths) {
      expect(statSync(resolve(repo, path)).isFile()).toBe(true);
    }
    const truth = readJson("artifacts/specs/tauri-react-remotion-harness-truth-manifest.json");
    const h07 = truth.claims.filter(
      (claim: { worker_lane_owner?: string }) => claim.worker_lane_owner === "H07",
    );
    expect(h07).toHaveLength(5);
    for (const claim of h07) {
      expect(claim.current_status).toBe("open");
      expect(claim.oracle_exists).toBe(true);
      expect(claim.oracle_implementation_paths).toEqual(mediaOracleImplementationPaths);
      expect(mediaClaimControlIds).toContain(claim.negative_control.control_id);
    }
  });

  it("independently validates WKWebView cell coverage and hashed artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "vean-wk-media-evidence-"));
    const artifact = join(root, "runtime.json");
    writeFileSync(artifact, "observed runtime data\n");
    const evidencePath = join(root, "evidence.json");
    const policySha256s = { matrix: "a".repeat(64) };
    const evidence = {
      schema_version: "1.0.0",
      evidence_kind: "wkwebview-media-runtime",
      status: "verified",
      fixture_manifest_sha256: "f".repeat(64),
      policy_sha256s: policySha256s,
      source: {
        git_sha: "a".repeat(40),
        git_tree_hash: "b".repeat(40),
        git_status_clean: true,
      },
      runtime: {
        runner: "tauri/wkwebview",
        macos_build: "25E246",
        webkit_version: "WebKit-1",
        app_sha256: "c".repeat(64),
        codec_capabilities: { h264: true },
      },
      artifacts: {
        runtime: { path: "runtime.json", sha256: hash(artifact) },
      },
      cells: [
        {
          id: "runtime.proxy-avc",
          outcome: "verified_supported",
          observations: { decoded: true, nonblack_ratio: 0.8, seek_error_seconds: 0.01 },
          artifact_ids: ["runtime"],
        },
        {
          id: "failure",
          outcome: "verified_attributed_failure",
          observations: { reason: "decode-error" },
          artifact_ids: ["runtime"],
        },
      ],
    };
    writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
    const options = {
      evidencePath,
      kind: "wkwebview-media-runtime" as const,
      fixtureManifestSha256: "f".repeat(64),
      policySha256s,
      requiredCellOutcomes: {
        "runtime.proxy-avc": "required_supported",
        failure: "required_attributed_failure",
      },
    };
    expect(verifyExternalMediaEvidence(options)).toMatchObject({ status: "verified" });

    writeFileSync(
      evidencePath,
      `${JSON.stringify({ ...evidence, cells: evidence.cells.slice(0, 1) })}\n`,
    );
    expect(() => verifyExternalMediaEvidence(options)).toThrow(
      "E_MEDIA_EXTERNAL_WK_CELL_DENOMINATOR",
    );

    writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
    writeFileSync(artifact, "producer changed artifact after reporting success\n");
    expect(() => verifyExternalMediaEvidence(options)).toThrow("E_MEDIA_EXTERNAL_ARTIFACT_DRIFT");
  });

  it("recomputes release-package distributions instead of trusting producer summaries", () => {
    const root = mkdtempSync(join(tmpdir(), "vean-release-media-evidence-"));
    const artifact = join(root, "samples.json");
    writeFileSync(artifact, "[1,2,3]\n");
    const evidencePath = join(root, "evidence.json");
    const policySha256s = { performance: "d".repeat(64) };
    const distribution = { raw_samples: [1, 2, 3], p50: 2, p95: 3, max: 3 };
    const evidence = {
      schema_version: "1.0.0",
      evidence_kind: "release-package-performance",
      status: "verified",
      fixture_manifest_sha256: "f".repeat(64),
      policy_sha256s: policySha256s,
      source: {
        git_sha: "a".repeat(40),
        git_tree_hash: "b".repeat(40),
        git_status_clean: true,
      },
      runtime: {
        runner: "installed-release-package",
        os_build: "25E246",
        webkit_version: "WebKit-1",
        distribution_sha256: "c".repeat(64),
        app_sha256: "d".repeat(64),
        optimized: true,
        installed: true,
      },
      artifacts: { samples: { path: "samples.json", sha256: hash(artifact) } },
      performance: {
        warmup_runs: 1,
        distributions: [distribution, distribution],
        functional_caps: {
          decoder_workers_max_observed: 2,
          in_flight_decodes_max_observed: 4,
          steady_queue_max_observed: 4,
          queue_drained_to_zero: true,
          cache_resident_bytes_max_observed: 100,
          owned_handle_balance: true,
          crashes_unhandled_errors_black_frames_stalls: 0,
          context_restore_valid_frame: true,
        },
        artifact_ids: ["samples"],
      },
    };
    writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
    const options = {
      evidencePath,
      kind: "release-package-performance" as const,
      fixtureManifestSha256: "f".repeat(64),
      policySha256s,
      performanceSampling: { warmupRuns: 1, measuredRuns: 2, samplesPerRun: 3 },
      performanceBudgets: { composite_p95_ms: 3, composite_max_ms: 3 },
      functionalCaps: {
        decoder_workers_max: 4,
        in_flight_decodes_max: 8,
        steady_queue_max: 8,
        queue_must_drain_to_zero_after_scrub: true,
        cache_resident_bytes_max: 500,
        owned_handle_open_close_balance_required: true,
        crashes_unhandled_errors_black_frames_stalls_max: 0,
        context_restore_requires_content_valid_frame: true,
      },
    };
    expect(verifyExternalMediaEvidence(options)).toMatchObject({ status: "verified" });
    const forged = {
      ...evidence,
      performance: {
        ...evidence.performance,
        distributions: [{ ...distribution, p95: 1 }, distribution],
      },
    };
    writeFileSync(evidencePath, `${JSON.stringify(forged)}\n`);
    expect(() => verifyExternalMediaEvidence(options)).toThrow(
      "E_MEDIA_EXTERNAL_RELEASE_DERIVED_METRICS",
    );
  });
});
