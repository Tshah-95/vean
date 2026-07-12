import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
});
