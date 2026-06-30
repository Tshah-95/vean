// FPS conform engine tests — pure (synthetic probes; no ffprobe). Covers the
// propose/apply/decision logic both features share.
import { describe, expect, it } from "vitest";
import { applyFpsConform, autodetectDecision, proposeFpsConform } from "../src/conform/fps";
import { parseRational, type SourceProbe } from "../src/driver/probe";
import { LANDSCAPE } from "../src/ir/profile";
import { timeline } from "../src/ir/builder";

function probe(r: string | null, avg: string | null): SourceProbe {
  return {
    path: "/s.mp4",
    rFrameRate: r == null ? null : parseRational(r),
    avgFrameRate: avg == null ? null : parseRational(avg),
    nbFrames: null,
    durationSec: null,
    width: 1920,
    height: 1080,
  };
}

describe("proposeFpsConform", () => {
  it("proposes the source's nominal rate when it differs from the profile", () => {
    const p = proposeFpsConform(LANDSCAPE, probe("25/1", "25/1")); // 25 on a 30 timeline
    expect(p).toEqual({ fromFps: [30, 1], toFps: [25, 1] });
  });

  it("proposes the NTSC rational, not a rounded float", () => {
    const p = proposeFpsConform(LANDSCAPE, probe("30000/1001", "30000/1001"));
    expect(p?.toFps).toEqual([30000, 1001]);
  });

  it("returns null when the source already matches the timeline", () => {
    expect(proposeFpsConform(LANDSCAPE, probe("30/1", "30/1"))).toBeNull();
  });

  it("returns null for a VFR source whose NOMINAL matches (transcode, not conform)", () => {
    // Pixel: nominal 30 (== timeline), average 29.9 → no fps conform proposed here;
    // the VFR is a transcode concern, surfaced by the diagnostic separately.
    expect(proposeFpsConform(LANDSCAPE, probe("30/1", "8460000/282889"))).toBeNull();
  });

  it("returns null when the nominal rate is unknown", () => {
    expect(proposeFpsConform(LANDSCAPE, probe(null, null))).toBeNull();
  });
});

describe("applyFpsConform", () => {
  it("sets the profile fps + retags the description, leaving frames untouched", () => {
    const tl = timeline(LANDSCAPE, {});
    const out = applyFpsConform(tl, [25, 1]);
    expect(out.profile.fps).toEqual([25, 1]);
    expect(out.profile.description).toBe("landscape-1920x1080-25");
    // Original is untouched (pure).
    expect(tl.profile.fps).toEqual([30, 1]);
  });

  it("retags an NTSC rational to a dotless tag", () => {
    const out = applyFpsConform(timeline(LANDSCAPE, {}), [30000, 1001]);
    expect(out.profile.description).toBe("landscape-1920x1080-2997");
  });
});

describe("autodetectDecision — the fps.autodetect modes", () => {
  const mismatch = probe("25/1", "25/1");
  it("off → does nothing regardless of mismatch", () => {
    expect(autodetectDecision("off", LANDSCAPE, mismatch)).toEqual({ decision: "off" });
  });
  it("confirm → proposes without applying", () => {
    expect(autodetectDecision("confirm", LANDSCAPE, mismatch)).toEqual({
      decision: "propose",
      proposal: { fromFps: [30, 1], toFps: [25, 1] },
    });
  });
  it("auto → applies", () => {
    expect(autodetectDecision("auto", LANDSCAPE, mismatch)).toEqual({
      decision: "apply",
      proposal: { fromFps: [30, 1], toFps: [25, 1] },
    });
  });
  it("matching source → 'match' (no proposal) even in auto", () => {
    expect(autodetectDecision("auto", LANDSCAPE, probe("30/1", "30/1"))).toEqual({
      decision: "match",
    });
  });
});
