// add_captions — assert the caption seam: from a base footage timeline + a
// frame-exact transcript, addCaptions yields (a) an upper CAPTION video track,
// (b) one transparent caption clip per segment at its frame-exact span carrying a
// dynamictext filter, (c) a qtblend field transition over the captioned region,
// and that the returned inverse sequence reconstructs the original IR exactly.
// No real melt/Remotion runs here. Mirrors timeline-add-graphic.test.ts.
import { describe, expect, it } from "vitest";
import { type AddCaptionsResult, addCaptions } from "../src/actions/captions";
import { colorClip, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { VERTICAL } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import type { Clip, Timeline } from "../src/ir/types";
import { apply } from "../src/ops";
import { type EditError, isEditError } from "../src/ops/types";
import { buildTranscript } from "../src/transcript";

/** Narrow the action result (mirrors `isEditError`, but for `AddCaptionsResult`). */
function isErr(x: AddCaptionsResult | EditError): x is EditError {
  return "kind" in x && !("state" in x);
}

function baseTimeline(): Timeline {
  resetIds();
  // A single footage video track, 120 frames (4s @ 30fps).
  return timeline(VERTICAL, {
    video: [videoTrack(colorClip(120, "blue", { id: "footage" }))],
  });
}

function demoTranscript() {
  return buildTranscript(
    [
      {
        start: 0,
        end: 2,
        text: "hello world",
        words: [
          { start: 0.0, end: 1.0, text: "hello" },
          { start: 1.0, end: 2.0, text: "world" },
        ],
      },
      {
        start: 2,
        end: 4,
        text: "goodbye now",
        words: [
          { start: 2.0, end: 3.0, text: "goodbye" },
          { start: 3.0, end: 4.0, text: "now" },
        ],
      },
    ],
    VERTICAL.fps,
  );
}

describe("add_captions", () => {
  it("lays a caption track with one dynamictext clip per segment + a qtblend transition", () => {
    const state = baseTimeline();
    const result = addCaptions(state, { transcript: demoTranscript(), newTrack: true });
    if (isErr(result)) throw new Error(`unexpected error: ${JSON.stringify(result)}`);

    // (a) A caption overlay track was APPENDED (bottom of the array = top layer).
    expect(result.state.tracks.video).toHaveLength(2);
    expect(result.createdTrack).toBe(true);
    expect(result.captionCount).toBe(2);

    // (b) One caption clip per segment, at the segment's frame-exact span, each
    // carrying a dynamictext filter with the segment text.
    const capTrack = result.state.tracks.video[1];
    if (!capTrack) throw new Error("no caption track");
    expect(capTrack.id).toBe(result.captionTrackId);
    const clips = capTrack.items.filter((i): i is Clip => i.kind === "clip");
    expect(clips.length).toBe(2);
    // Segment 0 spans frames [0,59] (0..2s), segment 1 [60,119] (2..4s).
    expect(clips[0]?.out !== undefined && clips[0].out - clips[0].in + 1).toBe(60);
    const filters0 = clips[0]?.filters ?? [];
    expect(
      filters0.some((f) => f.service === "dynamictext" && f.properties.argument === "hello world"),
    ).toBe(true);
    const filters1 = clips[1]?.filters ?? [];
    expect(
      filters1.some((f) => f.service === "dynamictext" && f.properties.argument === "goodbye now"),
    ).toBe(true);

    // (c) A single qtblend field transition composites captions (b, higher index)
    // over footage (a, lower index) across the whole captioned region [0,119].
    expect(result.state.transitions).toHaveLength(1);
    const t = result.state.transitions[0];
    if (!t) throw new Error("no transition");
    expect(t.service).toBe("qtblend");
    expect(t.aTrack).toBe(1); // footage (base, top of array)
    expect(t.bTrack).toBe(2); // captions (overlay, bottom of array = top layer)
    expect(t.in).toBe(0);
    expect(t.out).toBe(119);

    // It serializes to a qtblend transition + the dynamictext filter in the XML.
    const xml = toMlt(result.state);
    expect(xml).toContain('mlt_service="qtblend"');
    expect(xml).toContain("dynamictext");
    expect(xml).toContain("hello world");
  });

  it("inverts exactly: applying the inverse sequence reconstructs the original IR", () => {
    const original = baseTimeline();
    const result = addCaptions(original, { transcript: demoTranscript(), newTrack: true });
    if (isErr(result)) throw new Error(`unexpected error: ${JSON.stringify(result)}`);

    let work = result.state;
    for (const inv of result.inverse) {
      const undone = apply(inv, work);
      if (isEditError(undone)) throw new Error(`inverse step errored: ${JSON.stringify(undone)}`);
      work = undone.state;
    }
    expect(work).toEqual(original);
  });

  it("errors when there is no footage track to caption over", () => {
    resetIds();
    const empty = timeline(VERTICAL, { video: [] });
    const result = addCaptions(empty, { transcript: demoTranscript() });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.kind).toBe("precondition");
  });

  it("errors when the transcript has no captionable segments", () => {
    const state = baseTimeline();
    const blank = buildTranscript([], VERTICAL.fps);
    const result = addCaptions(state, { transcript: blank });
    expect(isErr(result)).toBe(true);
  });
});
