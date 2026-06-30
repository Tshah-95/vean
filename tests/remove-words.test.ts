// remove-words — BEHAVIOR of the word-level cut op (beyond the op-invariants
// harness, which already pins inverse + serialize). The point of this op vs
// Palmier's `remove_words`: addressing word RANGES by stable id (resolved to
// frame spans upstream) and cutting RIGHT-TO-LEFT so multiple ranges in ONE call
// hit exactly the named frames — no index/position shift between cuts.
import { describe, expect, it } from "vitest";
import { clip, colorClip, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { VERTICAL } from "../src/ir/profile";
import type { Timeline, Track } from "../src/ir/types";
import { apply, isEditError } from "../src/ops";
import { resolveWordRange } from "../src/query/transcript-map";
import { buildTranscript } from "../src/transcript";

function trackLen(items: Track["items"]): number {
  let n = 0;
  for (const it of items)
    n += it.kind === "clip" ? it.out - it.in + 1 : it.kind === "blank" ? it.length : it.frames;
  return n;
}

describe("removeWords — multi-range cut, no index shift", () => {
  it("cuts MULTIPLE disjoint ranges in one call to exactly the named frames", () => {
    resetIds();
    // One 200-frame take; cut [30,49] and [120,139] (40 frames total).
    const state: Timeline = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/take.mp4", { id: "take", dur: 200 }))],
    });
    const res = apply(
      {
        op: "removeWords",
        args: {
          track: { kind: "video", index: 0 },
          // Out of order on purpose — the op sorts + cuts right-to-left.
          targets: [
            { wordIds: ["wB"], startFrame: 120, endFrame: 139 },
            { wordIds: ["wA"], startFrame: 30, endFrame: 49 },
          ],
        },
      },
      state,
    );
    if (isEditError(res)) throw new Error(`removeWords errored: ${JSON.stringify(res)}`);
    // 200 − 40 removed = 160 frames remain.
    const items = (res.state.tracks.video[0] as Track).items;
    expect(trackLen(items)).toBe(160);
    expect(res.consequences.durationDelta).toBe(-40);
    // Both ranges report the SAME source clip removed (whole-item consequence).
    expect(res.consequences.clipsRemoved.map((c) => c.uuid)).toEqual(["take", "take"]);
  });

  it("addressing is by stable id end-to-end (transcript → spans → cut)", () => {
    resetIds();
    // A transcript whose words map to frames; cut two specific words by id.
    const transcript = buildTranscript(
      [
        {
          start: 0,
          end: 2,
          text: "um the actual point um",
          words: [
            { start: 0.0, end: 0.4, text: "um" }, // [0,11]
            { start: 0.4, end: 0.8, text: "the" }, // [12,23]
            { start: 0.8, end: 1.2, text: "actual" }, // [24,35]
            { start: 1.2, end: 1.6, text: "point" }, // [36,47]
            { start: 1.6, end: 2.0, text: "um" }, // [48,59]
          ],
        },
      ],
      VERTICAL.fps,
    );
    const words = transcript.segments[0]?.words ?? [];
    const fillerIds = [words[0]?.id as string, words[4]?.id as string]; // both "um"
    const { spans, missing } = resolveWordRange(transcript, fillerIds);
    expect(missing).toEqual([]);
    // Two disjoint "um" ranges: [0,11] and [48,59].
    expect(spans).toEqual([
      { startFrame: 0, endFrame: 11 },
      { startFrame: 48, endFrame: 59 },
    ]);

    const state: Timeline = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/take.mp4", { id: "take", dur: 60 }))],
    });
    const res = apply(
      {
        op: "removeWords",
        args: {
          track: { kind: "video", index: 0 },
          targets: spans.map((s, i) => ({ wordIds: [fillerIds[i] as string], ...s })),
        },
      },
      state,
    );
    if (isEditError(res)) throw new Error(`removeWords errored: ${JSON.stringify(res)}`);
    // 60 − (12 + 12) = 36 frames remain (both "um"s gone).
    expect(trackLen((res.state.tracks.video[0] as Track).items)).toBe(36);
  });

  it("undo restores the exact original (the inverse law, spot-checked)", () => {
    resetIds();
    const state: Timeline = timeline(VERTICAL, {
      video: [
        videoTrack(colorClip(40, "black", { id: "a" }), clip("/abs/b.mp4", { id: "b", dur: 40 })),
      ],
    });
    const res = apply(
      {
        op: "removeWords",
        args: {
          track: { kind: "video", index: 0 },
          // [30,49] straddles the boundary at frame 40 — fragments both clips.
          targets: [{ wordIds: ["edge"], startFrame: 30, endFrame: 49 }],
        },
      },
      state,
    );
    if (isEditError(res)) throw new Error("forward errored");
    const back = apply(res.inverse, res.state);
    if (isEditError(back)) throw new Error("inverse errored");
    expect(back.state).toEqual(state);
  });

  it("rejects a range crossing a same-track dissolve (typed precondition)", () => {
    resetIds();
    const state: Timeline = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/a.mp4", { id: "a", dur: 40 }),
          // a dissolve marker between a and b
          { kind: "dissolve", frames: 10, luma: "luma" },
          clip("/abs/b.mp4", { id: "b", dur: 40 }),
        ),
      ],
    });
    const res = apply(
      {
        op: "removeWords",
        args: {
          track: { kind: "video", index: 0 },
          targets: [{ wordIds: ["x"], startFrame: 35, endFrame: 50 }],
        },
      },
      state,
    );
    expect(isEditError(res)).toBe(true);
    if (isEditError(res)) expect(res.kind).toBe("precondition");
  });

  it("errors when the target track does not exist", () => {
    resetIds();
    const state: Timeline = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/a.mp4", { id: "a", dur: 40 }))],
    });
    const res = apply(
      {
        op: "removeWords",
        args: {
          track: { trackId: "no-such-track" },
          targets: [{ wordIds: ["x"], startFrame: 0, endFrame: 5 }],
        },
      },
      state,
    );
    expect(isEditError(res)).toBe(true);
    if (isEditError(res)) expect(res.kind).toBe("track-not-found");
  });
});
