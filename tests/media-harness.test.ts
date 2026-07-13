import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
      expect(mutation.changed_paths).toHaveLength(controlId === "nc-media-resilience" ? 2 : 1);
      expect(mutation.scenario_control).toBe(expected[controlId]);
      if (controlId === "nc-media-resilience") {
        const cleanupMutation = mutation.changed_paths.find((entry: { path: string }) =>
          entry.path.endsWith("viewer/src/decode/frameCache.ts"),
        );
        expect(cleanupMutation).toBeTruthy();
        const mutated = readFileSync(
          resolve(dirname(plan.manifestPath), cleanupMutation.mutated_snapshot_path),
          "utf8",
        );
        const before = readFileSync(
          resolve(dirname(plan.manifestPath), cleanupMutation.before_snapshot_path),
          "utf8",
        );
        const marker = 'this.ledger?.close("image-bitmap", e.key)';
        expect(mutated.split(marker)).toHaveLength(before.split(marker).length - 1);
      }
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

  it("runs ingest, fallback, alpha failure, and resilience through product surfaces", () => {
    const runner = readFileSync(resolve(repo, "e2e/media/product-media.ts"), "utf8");
    const legacy = readFileSync(resolve(repo, "e2e/media/media.spec.ts"), "utf8");
    expect(runner).toContain("/api/source-proxy");
    expect(runner).toContain("__veanMediaState");
    expect(runner).toContain("__veanApprox");
    expect(runner).toContain("__veanHarnessUnmount");
    expect(runner).toContain("ALPHA_PROBE_UNKNOWN");
    expect(runner).not.toMatch(/\bcreateImageBitmap\s*\(/);
    expect(legacy).not.toMatch(/\bcreateImageBitmap\s*\(/);
    expect(mediaOracleImplementationPaths).toEqual(
      expect.arrayContaining([
        "e2e/media/product-media.ts",
        "viewer/src/components/FootageStage.tsx",
        "viewer/src/decode/parallelDecoder.ts",
        "viewer/src/decode/frameCache.ts",
      ]),
    );
  });

  it("independently validates WKWebView cell coverage and hashed artifacts", () => {
    const root = mkdtempSync(join(tmpdir(), "vean-wk-media-evidence-"));
    const artifact = join(root, "runtime.json");
    writeFileSync(artifact, "observed runtime data\n");
    const binary = join(root, "app-executable");
    writeFileSync(binary, "actual app executable bytes\n");
    const providerReport = join(root, "native-session.json");
    const cellRuntime = join(root, "cell-runtime.json");
    const cellFailure = join(root, "cell-failure.json");
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
        archive_provenance: null,
      },
      runtime: {
        runner: "tauri/wkwebview",
        macos_build: "25E246",
        webkit_version: "WebKit-1",
        app_sha256: hash(binary),
        app_bundle_id: "studio.vean.desktop.harness",
        app_pid: 4242,
        webdriver_session_id: "actual-session",
        final_url: "http://127.0.0.1:43127/?route=timeline%3Amain",
        user_agent: "Mozilla/5.0 AppleWebKit/620.4",
        codec_capabilities: { h264: true },
        app_binary_artifact_id: "runtime:app-binary",
        provider_report_artifact_id: "runtime:provider-report",
      },
      artifacts: {
        runtime: { path: "runtime.json", sha256: hash(artifact) },
        "runtime:app-binary": { path: "app-executable", sha256: hash(binary) },
        "runtime:provider-report": { path: "native-session.json", sha256: "pending" },
        "cell:runtime.proxy-avc": { path: "cell-runtime.json", sha256: "pending" },
        "cell:failure": { path: "cell-failure.json", sha256: "pending" },
      },
      cells: [
        {
          id: "runtime.proxy-avc",
          outcome: "verified_supported",
          observations: {
            decoded: true,
            decoder_path: "mediabunny-canvas-sink-alpha",
            nonblack_ratio: 0.8,
            seek_error_seconds: 0.01,
            fixture_sha256: "d".repeat(64),
            decoded_sha256: "d".repeat(64),
          },
          observation_artifact_id: "cell:runtime.proxy-avc",
          artifact_ids: ["runtime", "cell:runtime.proxy-avc"],
        },
        {
          id: "failure",
          outcome: "verified_attributed_failure",
          observations: { reason: "decode-error" },
          observation_artifact_id: "cell:failure",
          artifact_ids: ["runtime", "cell:failure"],
        },
      ],
    };
    const runtimeCell = evidence.cells[0];
    const failureCell = evidence.cells[1];
    if (!runtimeCell || !failureCell) throw new Error("test evidence cells are incomplete");
    writeFileSync(
      providerReport,
      `${JSON.stringify({
        sourceSha: evidence.source.git_sha,
        process: {
          executableHash: evidence.runtime.app_sha256,
          observedBundleId: evidence.runtime.app_bundle_id,
        },
        runtime: {
          finalUrl: evidence.runtime.final_url,
          webkitVersion: evidence.runtime.webkit_version,
        },
      })}\n`,
    );
    writeFileSync(
      cellRuntime,
      `${JSON.stringify({ id: runtimeCell.id, outcome: runtimeCell.outcome, observations: runtimeCell.observations })}\n`,
    );
    writeFileSync(
      cellFailure,
      `${JSON.stringify({ id: failureCell.id, outcome: failureCell.outcome, observations: failureCell.observations })}\n`,
    );
    evidence.artifacts["cell:runtime.proxy-avc"].sha256 = hash(cellRuntime);
    evidence.artifacts["cell:failure"].sha256 = hash(cellFailure);
    evidence.artifacts["runtime:provider-report"].sha256 = hash(providerReport);
    writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
    const options = {
      evidencePath,
      kind: "wkwebview-media-runtime" as const,
      expectedSourceGitSha: "a".repeat(40),
      expectedSourceGitTreeHash: "b".repeat(40),
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
      `${JSON.stringify({
        ...evidence,
        source: { ...evidence.source, git_sha: "c".repeat(40) },
      })}\n`,
    );
    expect(() => verifyExternalMediaEvidence(options)).toThrow("E_MEDIA_EXTERNAL_SOURCE_STALE_SHA");

    writeFileSync(
      evidencePath,
      `${JSON.stringify({
        ...evidence,
        source: { ...evidence.source, git_tree_hash: "c".repeat(40) },
      })}\n`,
    );
    expect(() => verifyExternalMediaEvidence(options)).toThrow(
      "E_MEDIA_EXTERNAL_SOURCE_STALE_TREE",
    );

    const archivedEvidence = {
      ...evidence,
      source: {
        ...evidence.source,
        git_sha: "c".repeat(40),
        archive_provenance: {
          kind: "tracked_archive",
          source_git_sha: "a".repeat(40),
          source_git_tree_hash: "b".repeat(40),
        },
      },
    };
    writeFileSync(evidencePath, `${JSON.stringify(archivedEvidence)}\n`);
    expect(() => verifyExternalMediaEvidence(options)).toThrow(
      "E_MEDIA_EXTERNAL_WK_PROVIDER_REPORT_MISMATCH",
    );
    writeFileSync(
      providerReport,
      `${JSON.stringify({
        sourceSha: archivedEvidence.source.git_sha,
        process: {
          executableHash: evidence.runtime.app_sha256,
          observedBundleId: evidence.runtime.app_bundle_id,
        },
        runtime: {
          finalUrl: evidence.runtime.final_url,
          webkitVersion: evidence.runtime.webkit_version,
        },
      })}\n`,
    );
    archivedEvidence.artifacts["runtime:provider-report"].sha256 = hash(providerReport);
    writeFileSync(evidencePath, `${JSON.stringify(archivedEvidence)}\n`);
    expect(verifyExternalMediaEvidence(options)).toMatchObject({ status: "verified" });
    writeFileSync(
      evidencePath,
      `${JSON.stringify({
        ...archivedEvidence,
        source: {
          ...archivedEvidence.source,
          archive_provenance: {
            ...archivedEvidence.source.archive_provenance,
            source_git_sha: "d".repeat(40),
          },
        },
      })}\n`,
    );
    expect(() => verifyExternalMediaEvidence(options)).toThrow("E_MEDIA_EXTERNAL_SOURCE_STALE_SHA");
    writeFileSync(
      evidencePath,
      `${JSON.stringify({
        ...archivedEvidence,
        source: { ...archivedEvidence.source, git_tree_hash: "d".repeat(40) },
      })}\n`,
    );
    expect(() => verifyExternalMediaEvidence(options)).toThrow(
      "E_MEDIA_EXTERNAL_ARCHIVE_TREE_MISMATCH",
    );

    writeFileSync(providerReport, "changed provider report\n");
    writeFileSync(evidencePath, `${JSON.stringify(archivedEvidence)}\n`);
    expect(() => verifyExternalMediaEvidence(options)).toThrow("E_MEDIA_EXTERNAL_ARTIFACT_DRIFT");
    writeFileSync(binary, "changed app executable bytes\n");
    expect(() => verifyExternalMediaEvidence(options)).toThrow("E_MEDIA_EXTERNAL_ARTIFACT_DRIFT");

    writeFileSync(binary, "actual app executable bytes\n");
    writeFileSync(
      providerReport,
      `${JSON.stringify({
        sourceSha: archivedEvidence.source.git_sha,
        process: {
          executableHash: evidence.runtime.app_sha256,
          observedBundleId: evidence.runtime.app_bundle_id,
        },
        runtime: {
          finalUrl: evidence.runtime.final_url,
          webkitVersion: evidence.runtime.webkit_version,
        },
      })}\n`,
    );
    archivedEvidence.artifacts["runtime:provider-report"].sha256 = hash(providerReport);
    const assertRejectedArtifact = (path: string, message: string) => {
      writeFileSync(
        evidencePath,
        `${JSON.stringify({
          ...archivedEvidence,
          artifacts: {
            ...archivedEvidence.artifacts,
            attack: { path, sha256: hash(artifact) },
          },
        })}\n`,
      );
      expect(() => verifyExternalMediaEvidence(options)).toThrow(message);
    };
    const outside = join(dirname(root), `${root.split("/").at(-1)}-outside`);
    writeFileSync(outside, "observed runtime data\n");
    symlinkSync(outside, join(root, "outside-link"));
    assertRejectedArtifact("outside-link", "E_MEDIA_EXTERNAL_ARTIFACT_SYMLINK");
    symlinkSync("runtime.json", join(root, "inside-link"));
    assertRejectedArtifact("inside-link", "E_MEDIA_EXTERNAL_ARTIFACT_SYMLINK");
    mkdirSync(join(root, "actual-parent"));
    writeFileSync(join(root, "actual-parent/nested.json"), "observed runtime data\n");
    symlinkSync("actual-parent", join(root, "linked-parent"));
    assertRejectedArtifact("linked-parent/nested.json", "E_MEDIA_EXTERNAL_ARTIFACT_SYMLINK_PARENT");
    assertRejectedArtifact("evidence.json", "E_MEDIA_EXTERNAL_ARTIFACT_PATH_ESCAPE");
    mkdirSync(join(root, "directory-artifact"));
    assertRejectedArtifact("directory-artifact", "E_MEDIA_EXTERNAL_ARTIFACT_NOT_REGULAR");
    linkSync(artifact, join(root, "hardlink-artifact"));
    assertRejectedArtifact("hardlink-artifact", "E_MEDIA_EXTERNAL_ARTIFACT_HARDLINK");
    rmSync(join(root, "hardlink-artifact"));
    writeFileSync(
      providerReport,
      `${JSON.stringify({
        sourceSha: evidence.source.git_sha,
        process: {
          executableHash: evidence.runtime.app_sha256,
          observedBundleId: evidence.runtime.app_bundle_id,
        },
        runtime: {
          finalUrl: evidence.runtime.final_url,
          webkitVersion: evidence.runtime.webkit_version,
        },
      })}\n`,
    );
    evidence.artifacts["runtime:provider-report"].sha256 = hash(providerReport);

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
        archive_provenance: null,
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
      expectedSourceGitSha: "a".repeat(40),
      expectedSourceGitTreeHash: "b".repeat(40),
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
