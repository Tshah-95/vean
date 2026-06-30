// timeline.addFootage — assert a footage (video) clip is appended to a video
// track, that a missing video track is created when allowed, that footage is
// NOT labelled as a graphic (so the preview proxy keeps it), and that the
// inverse sequence reconstructs the original IR.
import { describe, expect, it } from "vitest";
import { addFootage } from "../src/actions/timelineBuild";
import { audioTrack, clip, colorClip, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { VERTICAL } from "../src/ir/profile";
import type { Clip, Timeline } from "../src/ir/types";
import { apply } from "../src/ops";
import { isEditError } from "../src/ops/types";
import { isGraphicClip } from "../src/preview/proxy";

function withVideo(): Timeline {
  resetIds();
  return timeline(VERTICAL, { video: [videoTrack(colorClip(90, "blue", { id: "base" }))] });
}

function audioOnly(): Timeline {
  resetIds();
  return timeline(VERTICAL, { audio: [audioTrack(clip("/abs/vo.wav", { id: "vo", dur: 30 }))] });
}

describe("timeline.addFootage", () => {
  it("appends footage to an existing video track and does NOT label it a graphic", () => {
    const state = withVideo();
    const result = addFootage(state, {
      resource: "/abs/phone-clip.mov",
      durationFrames: 120,
      inFrame: 0,
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    expect(result.createdTrack).toBe(false);
    const track = result.state.tracks.video[0];
    if (!track) throw new Error("no video track");
    // base + appended footage.
    expect(track.items).toHaveLength(2);
    const added = track.items[1] as Clip;
    expect(added.resource).toBe("/abs/phone-clip.mov");
    expect(added.out - added.in + 1).toBe(120);
    // The proxy must keep footage (only `graphic`-labelled clips get stripped).
    expect(isGraphicClip(added)).toBe(false);
    expect(added.label).toBe("footage");
  });

  it("forces a graphic-prefixed label back to footage (proxy safety)", () => {
    const state = withVideo();
    const result = addFootage(state, {
      resource: "/abs/clip.mov",
      durationFrames: 30,
      inFrame: 0,
      label: "graphic:sneaky",
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    const added = result.state.tracks.video[0]?.items[1] as Clip;
    expect(isGraphicClip(added)).toBe(false);
    expect(added.label).toBe("footage");
  });

  it("creates a video track when none exists and createTrackIfMissing is true", () => {
    const state = audioOnly();
    expect(state.tracks.video).toHaveLength(0);
    const result = addFootage(state, {
      resource: "/abs/clip.mov",
      durationFrames: 60,
      inFrame: 0,
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    expect(result.createdTrack).toBe(true);
    expect(result.state.tracks.video).toHaveLength(1);
    expect(result.state.tracks.video[0]?.items).toHaveLength(1);
  });

  it("returns a typed precondition when no video track and createTrackIfMissing is false", () => {
    const state = audioOnly();
    const result = addFootage(state, {
      resource: "/abs/clip.mov",
      durationFrames: 60,
      inFrame: 0,
      createTrackIfMissing: false,
    });
    expect("state" in result).toBe(false);
    if ("state" in result) return;
    expect(result.kind).toBe("precondition");
  });

  it("inverts exactly: applying the inverse reconstructs the original IR", () => {
    const original = audioOnly();
    const result = addFootage(original, {
      resource: "/abs/clip.mov",
      durationFrames: 60,
      inFrame: 0,
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    let work = result.state;
    for (const inv of result.inverse) {
      const back = apply(inv, work);
      if (isEditError(back)) throw new Error(`inverse step errored: ${JSON.stringify(back)}`);
      work = back.state;
    }
    expect(work).toEqual(original);
  });
});
