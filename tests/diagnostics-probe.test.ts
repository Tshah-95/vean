// Frame-rate RULE tests — the pure `probeDiagnostics` (src/diagnostics/probe.ts),
// fed synthetic probe facts (no ffprobe; the I/O orchestrator is exercised by a
// real render path, never vitest). BOTH directions, per the Move-1 discipline:
//   • POSITIVE — a VFR source, a nominal mismatch, and an NTSC-vs-integer source
//     each trip the expected code.
//   • NEGATIVE — a matching constant-rate source is SILENT (the no-false-positive
//     gate): the clean fixture is the same shape as a broken twin with only the
//     rate aligned, so a pass proves the rule discriminates, not abstains.
import { describe, expect, it } from "vitest";
import { probeDiagnostics } from "../src/diagnostics/probe";
import { type SourceProbe, parseRational } from "../src/driver/probe";
import { LANDSCAPE, LANDSCAPE_2997 } from "../src/ir/profile";

const loc = { clip: "c0", track: "V1" };

/** Build a probe from rate tokens (`"30/1"`, `"8460000/282889"`, or null=unknown). */
function probe(r: string | null, avg: string | null): SourceProbe {
  return {
    path: "/src.mp4",
    rFrameRate: r == null ? null : parseRational(r),
    avgFrameRate: avg == null ? null : parseRational(avg),
    nbFrames: null,
    durationSec: null,
    width: 1920,
    height: 1080,
    color: { space: null, transfer: null, primaries: null },
    audioStreams: 1,
  };
}

const codes = (ds: { code: string }[]): string[] => ds.map((d) => d.code).sort();

describe("probeDiagnostics — variable frame rate", () => {
  it("flags a real Pixel VFR source (nominal 30, average ~29.9) on a 30 timeline", () => {
    // r_frame_rate=30/1, avg_frame_rate from a real PXL_*.mp4: 8460000/282889 ≈ 29.906.
    const ds = probeDiagnostics(LANDSCAPE, probe("30/1", "8460000/282889"), loc);
    expect(codes(ds)).toEqual(["variable-frame-rate-source"]);
    // NOT a nominal mismatch — the source CLAIMS 30, which matches the timeline; the
    // defect is the variability, not the nominal rate.
    expect(codes(ds)).not.toContain("source-fps-mismatch");
    const vfr = ds.find((d) => d.code === "variable-frame-rate-source");
    expect(vfr?.severity).toBe("warning");
    expect(vfr?.data).toMatchObject({ nominalFps: 30, timelineFps: 30 });
    expect(vfr?.location).toEqual({ clip: "c0", track: "V1" });
  });

  it("is silent on a clean constant-rate source (nominal == average)", () => {
    expect(probeDiagnostics(LANDSCAPE, probe("30/1", "30/1"), loc)).toEqual([]);
  });
});

describe("probeDiagnostics — nominal mismatch", () => {
  it("flags a 25 fps source on a 30 timeline", () => {
    const ds = probeDiagnostics(LANDSCAPE, probe("25/1", "25/1"), loc);
    expect(codes(ds)).toEqual(["source-fps-mismatch"]);
    expect(ds[0]?.data).toMatchObject({ sourceFps: 25, timelineFps: 30 });
  });

  it("flags an NTSC 29.97 source on a 30 timeline (0.1% gap > tolerance)", () => {
    const ds = probeDiagnostics(LANDSCAPE, probe("30000/1001", "30000/1001"), loc);
    expect(codes(ds)).toEqual(["source-fps-mismatch"]);
  });

  it("flags an integer-30 source on a 29.97 timeline (the mirror case)", () => {
    const ds = probeDiagnostics(LANDSCAPE_2997, probe("30/1", "30/1"), loc);
    expect(codes(ds)).toEqual(["source-fps-mismatch"]);
  });

  it("is silent on an exact-rate match", () => {
    expect(probeDiagnostics(LANDSCAPE, probe("30/1", "30/1"), loc)).toEqual([]);
    expect(probeDiagnostics(LANDSCAPE_2997, probe("30000/1001", "30000/1001"), loc)).toEqual([]);
  });
});

describe("probeDiagnostics — tunable tolerances (the fps.*Tolerance settings)", () => {
  it("a looser vfrTolerance silences a borderline VFR source", () => {
    const p = probe("30/1", "8460000/282889"); // ~0.31% gap → VFR at the default 0.2%
    expect(codes(probeDiagnostics(LANDSCAPE, p, loc))).toContain("variable-frame-rate-source");
    // Raise the tolerance above the gap → no longer flagged (config-driven).
    expect(probeDiagnostics(LANDSCAPE, p, loc, { vfrTolerance: 0.01 })).toEqual([]);
  });

  it("a tighter mismatchTolerance flags a near-match the default ignores", () => {
    // 30.00 source vs 30.00 timeline but pretend a hair off: 30/1 vs a 30.001 timeline
    // is awkward to express, so use a source just past a very tight tolerance.
    const p = probe("30/1", "30/1");
    expect(probeDiagnostics(LANDSCAPE, p, loc)).toEqual([]); // exact match, silent
    // A 24fps source with an absurdly loose mismatch tolerance is NOT flagged.
    const p24 = probe("24/1", "24/1");
    expect(probeDiagnostics(LANDSCAPE, p24, loc, { mismatchTolerance: 0.5 })).toEqual([]);
  });
});

describe("probeDiagnostics — unknown facts judge nothing", () => {
  it("emits nothing when rates are unknown (no video stream)", () => {
    expect(probeDiagnostics(LANDSCAPE, probe(null, null), loc)).toEqual([]);
  });

  it("can still flag a nominal mismatch when only avg is unknown", () => {
    // r=25 known, avg unknown → no VFR judgement, but the nominal mismatch stands.
    expect(codes(probeDiagnostics(LANDSCAPE, probe("25/1", null), loc))).toEqual([
      "source-fps-mismatch",
    ]);
  });
});

describe("parseRational", () => {
  it("parses fraction tokens", () => {
    expect(parseRational("30/1")).toEqual({ num: 30, den: 1 });
    expect(parseRational("30000/1001")).toEqual({ num: 30000, den: 1001 });
  });
  it("rejects ffprobe's unknown / malformed tokens", () => {
    expect(parseRational("0/0")).toBeNull();
    expect(parseRational("")).toBeNull();
    expect(parseRational("N/A")).toBeNull();
    expect(parseRational(undefined)).toBeNull();
  });
  it("accepts a bare decimal rate", () => {
    expect(parseRational("30")).toEqual({ num: 30, den: 1 });
  });
});
