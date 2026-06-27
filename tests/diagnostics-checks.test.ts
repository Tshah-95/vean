// Positive diagnostics tests — each structural/media rule FIRES on a genuinely
// broken timeline, with the EXACT expected code + severity (the "broken timelines
// emit the exact expected diagnostic" half of the Move-1 gate). Paired with
// tests/diagnostics-harness.test.ts (the silence-on-clean half), this proves the
// engine catches real defects without false positives.
import { describe, expect, it } from "vitest";
import { collectDiagnostics, summarize } from "../src/diagnostics";
import {
  VERTICAL,
  clip,
  colorClip,
  dissolve,
  filter,
  resetIds,
  timeline,
  videoTrack,
} from "../src/index";
import type { Timeline } from "../src/ir/types";

/** The diagnostic codes a state produces (for terse assertions). */
function codes(tl: Timeline): string[] {
  return collectDiagnostics(tl).map((d) => d.code);
}

describe("structural checker — fires on broken states", () => {
  it("in-out-beyond-source: a clip window past its source length is an error", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/a.mp4", { id: "b", in: 0, out: 200, length: 100 }))],
    });
    const diags = collectDiagnostics(tl);
    const d = diags.find((x) => x.code === "in-out-beyond-source");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("error");
    expect(d?.location.clip).toBe("b");
    expect(d?.fix).toMatch(/trim the out-point/);
    expect(d?.data).toMatchObject({ out: 200, length: 100 });
    expect(summarize(diags).clean).toBe(false);
  });

  it("keyframe-outside-clip: an animation entirely past the window is a warning", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "k",
            dur: 50,
            // BOTH keyframes past window [0,49] → melt clamps to a flat value, so the
            // ramp renders dead (verified against melt: luma stays flat). Fires.
            filters: [filter("brightness", { level: "100=0;200=1" })],
          }),
        ),
      ],
    });
    const d = collectDiagnostics(tl).find((x) => x.code === "keyframe-outside-clip");
    expect(d?.severity).toBe("warning");
    expect(d?.location.clip).toBe("k");
    expect(d?.location.filter).toBe(0);
    expect(d?.data).toMatchObject({ windowEnd: 49, lastFrame: 200 });
  });

  it("keyframe-outside-clip is SILENT when an in-window keyframe anchors a live gradient", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "k",
            dur: 50,
            // 0 is in-window; 200 is just the interpolation target the gradient runs
            // toward (verified against melt: this ramps 0→~0.245, it RENDERS). An
            // out-of-window keyframe is NOT a defect when an in-window one anchors it —
            // this is the exact state split() produces by design.
            filters: [filter("brightness", { level: "0=0;200=1" })],
          }),
        ),
      ],
    });
    expect(codes(tl)).not.toContain("keyframe-outside-clip");
  });

  it("keyframe-outside-clip does NOT fire for an in-window or negative keyframe", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "k",
            dur: 50,
            // 49 is the last valid frame; -1 (relative) anchors to the end.
            filters: [filter("brightness", { level: "0=0;49=1;-1=0.5" })],
          }),
        ),
      ],
    });
    expect(codes(tl)).not.toContain("keyframe-outside-clip");
  });

  it("dissolve-too-long: a dissolve longer than a neighbour clip is an error", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(30, "black"), dissolve(20), colorClip(15, "gold"))],
    });
    const d = collectDiagnostics(tl).find((x) => x.code === "dissolve-too-long");
    expect(d?.severity).toBe("error");
    expect(d?.data).toMatchObject({ dissolveFrames: 20, shortestNeighbour: 15 });
  });

  it("a valid dissolve (≤ both neighbours) does NOT fire", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(45, "black"), dissolve(20), colorClip(60, "gold"))],
    });
    expect(codes(tl)).not.toContain("dissolve-too-long");
  });
});

describe("media checker — fires on a structurally dangling resource", () => {
  it("dangling-resource: a clip with an empty resource is an error", () => {
    // The builder/Zod won't make one, so we hand-build the IR to exercise the
    // engine on an in-progress (pre-validation) document the LSP might hold.
    const tl: Timeline = {
      profile: VERTICAL,
      tracks: {
        video: [
          {
            kind: "video",
            id: "v1",
            items: [{ kind: "clip", id: "empty", resource: "", in: 0, out: 10, filters: [] }],
          },
        ],
        audio: [],
      },
      transitions: [],
      title: "broken",
    };
    const d = collectDiagnostics(tl).find((x) => x.code === "dangling-resource");
    expect(d?.severity).toBe("error");
    expect(d?.source).toBe("media");
    expect(d?.location.clip).toBe("empty");
  });
});

describe("the engine stamps provenance + a compact health summary", () => {
  it("every diagnostic's `source` is its checker name", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/a.mp4", { id: "b", in: 0, out: 200, length: 100 }))],
    });
    for (const d of collectDiagnostics(tl)) {
      expect(["structural", "sync", "media"]).toContain(d.source);
    }
  });

  it("summarize counts severities and the clean flag", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "mix",
            in: 0,
            out: 200,
            length: 100, // an error (out ≥ length)
            // ALL keyframes past the played window [0,200] → a dead-clamp warning.
            filters: [filter("brightness", { level: "300=0;500=1" })], // a warning
          }),
        ),
      ],
    });
    const h = summarize(collectDiagnostics(tl));
    expect(h.errors).toBeGreaterThanOrEqual(1);
    expect(h.warnings).toBeGreaterThanOrEqual(1);
    expect(h.clean).toBe(false);
  });
});
