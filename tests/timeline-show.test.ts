// timeline.show — the structured timeline inventory (`summarizeTimeline`) + its
// compact formatter (`formatTimelineSummary`). The summary REUSES the ops'
// frame-math primitives (`startOf`/`trackLength`), so the tests assert (a) precise
// values on simple clip+blank tracks, (b) self-consistency invariants on a
// dissolve track (contiguity + Σframes == track length, cross-checked against
// `trackLength` directly), (c) the display helpers (timecode, gain→dB, overlay
// classification, fades), and (d) a formatted-text golden for regression.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  audioTrack,
  blank,
  clip,
  colorClip,
  dissolve,
  timeline,
  transition,
  videoTrack,
} from "../src/ir/builder";
import { fromMlt } from "../src/ir/parse";
import { LANDSCAPE } from "../src/ir/profile";
import { trackLength } from "../src/ops/primitives";
import { formatTimelineSummary, frameTimecode, summarizeTimeline } from "../src/query";

const CORPUS = join(import.meta.dirname, "..", "corpus");

describe("summarizeTimeline — structure", () => {
  it("reports tracks in main-tractor order with 1-based tractor indices + names", () => {
    const tl = timeline(
      LANDSCAPE,
      {
        video: [
          videoTrack(clip("/a.mp4", { in: 10, out: 39, id: "clip-a" })), // playtime 30
          videoTrack(blank(20), clip("/b.mp4", { dur: 40, id: "clip-b" })),
        ],
        audio: [audioTrack(clip("/tone.wav", { dur: 60, id: "clip-c", gain: 0.5 }))],
      },
      { title: "T", transitions: [transition("qtblend", 1, 2, 20, 59)] },
    );
    const s = summarizeTimeline(tl);

    expect(s.counts).toMatchObject({ videoTracks: 2, audioTracks: 1, clips: 3, blanks: 1 });
    // Main-tractor order [...video, ...audio]; background occupies index 0 so real
    // tracks are 1-based. Names derive to V1/V2/A1 when the IR carries none.
    expect(s.tracks.map((t) => [t.tractorIndex, t.name, t.kind])).toEqual([
      [1, "V1", "video"],
      [2, "V2", "video"],
      [3, "A1", "audio"],
    ]);
    // totalFrames = longest track (V2 = 20 + 40 = 60).
    expect(s.totalFrames).toBe(60);
  });

  it("computes exact spans on a clip+blank track (no dissolve)", () => {
    const tl = timeline(LANDSCAPE, {
      video: [
        videoTrack(
          clip("/a.mp4", { dur: 45, id: "a" }),
          blank(30),
          clip("/b.mp4", { dur: 75, id: "b" }),
        ),
      ],
    });
    const [track] = summarizeTimeline(tl).tracks;
    expect(track?.items.map((i) => [i.start, i.end, i.frames])).toEqual([
      [0, 44, 45],
      [45, 74, 30],
      [75, 149, 75],
    ]);
    expect(track?.length).toBe(150);
  });

  it("keeps item spans contiguous and summing to track length (dissolve invariant)", () => {
    const items = [colorClip(25, "black"), dissolve(20), colorClip(40, "white")];
    const tl = timeline(LANDSCAPE, { video: [videoTrack(...items)] });
    const [track] = summarizeTimeline(tl).tracks;
    // Cross-check the summary's track length against the ops helper directly.
    expect(track?.length).toBe(trackLength(items));
    // First item starts at 0; each next item starts exactly where the prior ends.
    let expectedStart = 0;
    let sum = 0;
    for (const it of track?.items ?? []) {
      expect(it.start).toBe(expectedStart);
      expect(it.end).toBe(it.start + it.frames - 1);
      expectedStart = it.end + 1;
      sum += it.frames;
    }
    expect(sum).toBe(track?.length);
  });
});

describe("summarizeTimeline — clip detail", () => {
  it("surfaces a trimmed source window, gain in dB, and fades", () => {
    const tl = timeline(LANDSCAPE, {
      audio: [
        audioTrack(
          clip("/tone.wav", { in: 100, out: 159, id: "c", gain: 0.5, fadeIn: 12, fadeOut: 24 }),
        ),
      ],
    });
    const item = summarizeTimeline(tl).tracks[0]?.items[0];
    if (item?.kind !== "clip") throw new Error("expected clip");
    expect(item.source).toEqual({ in: 100, out: 159, length: undefined });
    expect(item.gain).toBe(0.5);
    expect(item.gainDb).toBeCloseTo(-6.02, 1);
    expect(item.fadeInFrames).toBe(12);
    expect(item.fadeOutFrames).toBe(24);
  });

  it("omits gainDb for unity gain and marks muted (gain 0)", () => {
    const tl = timeline(LANDSCAPE, {
      audio: [
        audioTrack(
          clip("/u.wav", { dur: 10, id: "u", gain: 1 }),
          clip("/m.wav", { dur: 10, id: "m", gain: 0 }),
        ),
      ],
    });
    const [unity, muted] = summarizeTimeline(tl).tracks[0]?.items ?? [];
    if (unity?.kind !== "clip" || muted?.kind !== "clip") throw new Error("expected clips");
    expect(unity.gain).toBeUndefined();
    expect(unity.gainDb).toBeUndefined();
    expect(muted.gain).toBe(0);
    expect(muted.gainDb).toBeUndefined();
  });

  it("classifies a baked composition clip as a composited overlay", () => {
    const tl = timeline(LANDSCAPE, {
      video: [
        videoTrack(clip("/lower.mov", { dur: 90, id: "g", composition: { id: "LowerThird" } })),
      ],
    });
    const item = summarizeTimeline(tl).tracks[0]?.items[0];
    if (item?.kind !== "clip") throw new Error("expected clip");
    expect(item.overlay).toBe("composited");
    expect(item.composition).toBe("LowerThird");
  });

  it("classifies a graphic-labeled clip as a live graphic overlay", () => {
    const tl = timeline(LANDSCAPE, {
      video: [videoTrack(clip("/x.mov", { dur: 90, id: "g2", label: "graphic:Title" }))],
    });
    const item = summarizeTimeline(tl).tracks[0]?.items[0];
    if (item?.kind !== "clip") throw new Error("expected clip");
    expect(item.overlay).toBe("graphic");
    expect(item.composition).toBe("Title");
  });
});

describe("summarizeTimeline — diagnostics fold-in", () => {
  it("counts supplied diagnostics per clip and in the summary totals", () => {
    const tl = timeline(LANDSCAPE, {
      video: [videoTrack(clip("/a.mp4", { dur: 30, id: "clip-x" }))],
    });
    const s = summarizeTimeline(tl, [
      {
        code: "demo",
        severity: "warning",
        source: "t",
        message: "m",
        location: { clip: "clip-x" },
      },
      { code: "demo2", severity: "error", source: "t", message: "m2", location: {} },
    ]);
    expect(s.counts.diagnostics).toEqual({ error: 1, warning: 1, info: 0, hint: 0 });
    const item = s.tracks[0]?.items[0];
    if (item?.kind !== "clip") throw new Error("expected clip");
    expect(item.diagnostics).toBe(1); // only the clip-scoped one
    expect(s.diagnostics).toHaveLength(2);
  });
});

describe("frameTimecode", () => {
  it("formats frames as brief timecode at rational fps", () => {
    expect(frameTimecode(0, [30, 1])).toBe("0:00.000");
    expect(frameTimecode(30, [30, 1])).toBe("0:01.000");
    expect(frameTimecode(90, [30, 1])).toBe("0:03.000");
    expect(frameTimecode(30 * 65, [30, 1])).toBe("1:05.000");
    expect(frameTimecode(30 * 3600, [30, 1])).toBe("1:00:00.000"); // rolls to H:MM:SS
    // 29.97 (30000/1001): 30 frames is a hair over 1.000s.
    expect(frameTimecode(30, [30000, 1001])).toBe("0:01.001");
  });
});

describe("formatTimelineSummary — golden", () => {
  it("renders a corpus timeline as stable compact text", () => {
    const ir = fromMlt(readFileSync(join(CORPUS, "vean-multitrack.mlt"), "utf8"));
    const text = formatTimelineSummary(summarizeTimeline(ir));
    expect(text).toMatchInlineSnapshot(`
      "vean multitrack — dissolve + gap + gain + field composite · vertical-1080x1920-30 · 1080×1920 · 30fps · 0:03.000 (90f)
      tracks: 2 video · 1 audio · 4 clips · 1 blank · 1 dissolve · 1 transition

      V1 video  85f
        clip      [0–24]  25f  #FF000000  fade-in 12f
        dissolve  [25–44] 20f  luma
        clip      [45–84] 40f  #FFFFD700  fade-out 15f
      V2 video  65f
        blank     [0–14]  15f
        clip      [15–64] 50f  #FF0000FF
      A1 audio  90f
        clip      [0–89] 90f  tone.wav  -1.9dB

      transitions
        #0  qtblend  tracks 1↔2  [15–64]  50f

      diagnostics: clean"
    `);
  });
});
