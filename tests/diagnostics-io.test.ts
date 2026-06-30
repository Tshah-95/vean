// I/O-fed diagnostic RULE tests — the driver half of the media checker's TODOs,
// now LIVE in `src/driver/probe.ts`. Like the fps rule (tests/diagnostics-probe.ts),
// each rule is a PURE function over already-gathered facts (a `SourceProbe`, an
// fs-existence bool), so it unit-tests WITHOUT ffprobe; the I/O orchestrator is
// exercised by a real render path, never vitest.
//
// BOTH directions, per the Move-1 discipline:
//   • POSITIVE — a missing file, a sub-canvas source, and a log/wide-gamut source
//     each trip the expected code + severity + payload.
//   • NEGATIVE — a present file, an equal-or-larger source, and a Rec.709 source are
//     SILENT (the no-false-positive bar). Each clean fixture is the SAME shape as its
//     broken twin with only the defect removed, so a pass proves the rule
//     discriminates, not abstains.
import { describe, expect, it } from "vitest";
import {
  type ProbeRuleLocation,
  type SourceProbe,
  danglingFileRefDiagnostic,
  sourceColorspaceDiagnostic,
  sourceUpscaleDiagnostic,
} from "../src/driver/probe";
import { LANDSCAPE } from "../src/ir/profile";

const loc: ProbeRuleLocation = { clip: "c0", track: "V1" };

/** A clean `SourceProbe` at the timeline size + Rec.709 — the baseline a fixture
 *  perturbs by ONE field to exercise exactly one rule. */
function probe(over: Partial<SourceProbe> = {}): SourceProbe {
  return {
    path: "/footage/clip.mp4",
    rFrameRate: { num: 30, den: 1 },
    avgFrameRate: { num: 30, den: 1 },
    nbFrames: 300,
    durationSec: 10,
    width: LANDSCAPE.width, // 1920
    height: LANDSCAPE.height, // 1080
    color: { space: "bt709", transfer: "bt709", primaries: "bt709" },
    audioStreams: 1,
    ...over,
  };
}

const codes = (ds: { code: string }[]): string[] => ds.map((d) => d.code).sort();

// ─── 1. dangling-file-ref (an fs-existence fact) ─────────────────────────────────
describe("danglingFileRefDiagnostic — a clip's media file is gone", () => {
  it("FIRES (error) when the resolved path does not exist", () => {
    const ds = danglingFileRefDiagnostic("/footage/missing.mp4", false, loc);
    expect(codes(ds)).toEqual(["dangling-file-ref"]);
    const d = ds[0];
    expect(d?.severity).toBe("error");
    expect(d?.location).toEqual({ clip: "c0", track: "V1" });
    expect(d?.data).toMatchObject({ path: "/footage/missing.mp4" });
    expect(d?.fix).toMatch(/relink/);
  });

  it("is SILENT when the file exists (same path, present on disk)", () => {
    expect(danglingFileRefDiagnostic("/footage/present.mp4", true, loc)).toEqual([]);
  });
});

// ─── 2. upscaling-past-canvas (from a SMALLER source) ────────────────────────────
describe("sourceUpscaleDiagnostic — source smaller than the canvas (soft upscale)", () => {
  it("FIRES (warning) on a 1280×720 source on a 1920×1080 canvas", () => {
    const ds = sourceUpscaleDiagnostic(LANDSCAPE, probe({ width: 1280, height: 720 }), loc);
    expect(codes(ds)).toEqual(["upscaling-past-canvas"]);
    const d = ds[0];
    expect(d?.severity).toBe("warning");
    expect(d?.location.clip).toBe("c0");
    expect(d?.data).toMatchObject({
      sourceWidth: 1280,
      sourceHeight: 720,
      canvasWidth: 1920,
      canvasHeight: 1080,
    });
  });

  it("is SILENT on a source EQUAL to the canvas (fills it, not upscaled)", () => {
    expect(sourceUpscaleDiagnostic(LANDSCAPE, probe({ width: 1920, height: 1080 }), loc)).toEqual(
      [],
    );
  });

  it("is SILENT on a LARGER (4K) source (melt downscales, not up)", () => {
    expect(sourceUpscaleDiagnostic(LANDSCAPE, probe({ width: 3840, height: 2160 }), loc)).toEqual(
      [],
    );
  });

  it("is SILENT on a portrait source taller than the canvas (letterboxed, not upscaled)", () => {
    // 1080×1920 on a 1920×1080 canvas: width < canvas but height > canvas → NOT a
    // both-axes-smaller upscale. The conservative guard keeps this silent.
    expect(sourceUpscaleDiagnostic(LANDSCAPE, probe({ width: 1080, height: 1920 }), loc)).toEqual(
      [],
    );
  });

  it("is SILENT when dimensions are unknown (no video stream → judge nothing)", () => {
    expect(sourceUpscaleDiagnostic(LANDSCAPE, probe({ width: null, height: null }), loc)).toEqual(
      [],
    );
  });
});

// ─── 3. colorspace-mismatch (from the SOURCE's real colorspace) ──────────────────
describe("sourceColorspaceDiagnostic — log / wide-gamut source on a 709 timeline", () => {
  it("FIRES (warning) on an HLG transfer (arib-std-b67)", () => {
    const ds = sourceColorspaceDiagnostic(
      LANDSCAPE,
      probe({ color: { space: "bt2020nc", transfer: "arib-std-b67", primaries: "bt2020" } }),
      loc,
    );
    expect(codes(ds)).toEqual(["colorspace-mismatch"]);
    const d = ds[0];
    expect(d?.severity).toBe("warning");
    expect(d?.location.clip).toBe("c0");
    // The transfer tag is checked first, so it is the one reported.
    expect(d?.data).toMatchObject({ hint: "color_transfer", value: "arib-std-b67" });
  });

  it("FIRES on a Rec.2020 wide-gamut primaries (no log transfer)", () => {
    const ds = sourceColorspaceDiagnostic(
      LANDSCAPE,
      probe({ color: { space: null, transfer: "bt709", primaries: "bt2020" } }),
      loc,
    );
    expect(ds[0]?.data).toMatchObject({ hint: "color_primaries", value: "bt2020" });
  });

  it("FIRES on a PQ / HDR10 transfer (smpte2084)", () => {
    const ds = sourceColorspaceDiagnostic(
      LANDSCAPE,
      probe({ color: { space: null, transfer: "smpte2084", primaries: null } }),
      loc,
    );
    expect(codes(ds)).toEqual(["colorspace-mismatch"]);
  });

  it("is SILENT on a standard Rec.709 source (the clean case)", () => {
    expect(sourceColorspaceDiagnostic(LANDSCAPE, probe(), loc)).toEqual([]);
  });

  it("is SILENT on a source with no colorspace tags (the clean corpus)", () => {
    expect(
      sourceColorspaceDiagnostic(
        LANDSCAPE,
        probe({ color: { space: null, transfer: null, primaries: null } }),
        loc,
      ),
    ).toEqual([]);
  });

  it("is SILENT against a non-709 timeline (only judged on a 709 target)", () => {
    const wideTimeline = { ...LANDSCAPE, colorspace: 2020 };
    expect(
      sourceColorspaceDiagnostic(
        wideTimeline,
        probe({ color: { space: "bt2020nc", transfer: "arib-std-b67", primaries: "bt2020" } }),
        loc,
      ),
    ).toEqual([]);
  });
});
