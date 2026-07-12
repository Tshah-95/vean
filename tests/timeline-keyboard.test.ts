import { describe, expect, it } from "vitest";
import {
  adjacentTrackMove,
  browseDestination,
  keyboardInvocation,
  selectableClips,
} from "../viewer/src/timelineKeyboard";
import type { Timeline } from "../viewer/src/types";

const timeline: Timeline = {
  title: "keyboard unit fixture",
  profile: {
    description: "30fps",
    width: 1920,
    height: 1080,
    fps: [30, 1],
    displayAspectNum: 16,
    displayAspectDen: 9,
  },
  tracks: {
    video: [
      {
        id: "v1",
        name: "V1",
        kind: "video",
        items: [
          { kind: "clip", id: "left", resource: "left.mov", in: 10, out: 29, length: 80 },
          { kind: "clip", id: "chosen", resource: "chosen.mov", in: 10, out: 29, length: 80 },
          { kind: "blank", length: 10 },
        ],
      },
      {
        id: "v2",
        name: "V2",
        kind: "video",
        items: [
          { kind: "blank", length: 20 },
          { kind: "clip", id: "early-tie", resource: "early.mov", in: 0, out: 9, length: 80 },
          { kind: "clip", id: "late-tie", resource: "late.mov", in: 0, out: 9, length: 80 },
        ],
      },
    ],
    audio: [
      {
        id: "a1",
        name: "A1",
        kind: "audio",
        items: [{ kind: "clip", id: "audio", resource: "audio.wav", in: 0, out: 59, length: 80 }],
      },
    ],
  },
  transitions: [],
};

const base = {
  timeline,
  clipId: "chosen",
  dx: 1,
  alt: false,
  meta: false,
  snapEnabled: false,
  pxPerFrame: 10,
  snapCandidates: [] as number[],
};

describe("timeline keyboard algebra adapter", () => {
  it("keeps browse navigation in kind and chooses the earlier nearest-center tie", () => {
    expect(browseDestination(timeline, "chosen", "ArrowDown", false)?.id).toBe("early-tie");
    expect(browseDestination(timeline, "chosen", "ArrowUp", false)?.id).toBe("chosen");
    expect(browseDestination(timeline, "audio", "ArrowUp", false)?.id).toBe("audio");
    expect(browseDestination(timeline, "chosen", "Home", true)?.id).toBe("left");
    expect(browseDestination(timeline, "chosen", "End", true)?.id).toBe("audio");
  });

  it("maps every approved body modifier through the existing invocation builder", () => {
    expect(keyboardInvocation({ ...base, target: "body" })?.invocation).toMatchObject({
      op: "move",
      args: { uuid: "chosen", toPosition: 21 },
    });
    expect(keyboardInvocation({ ...base, target: "body", alt: true })?.invocation).toEqual({
      op: "slip",
      args: { uuid: "chosen", delta: -1 },
    });
    expect(keyboardInvocation({ ...base, target: "body", meta: true })?.invocation).toEqual({
      op: "slide",
      args: { uuid: "chosen", delta: 1 },
    });
  });

  it("maps trim, ripple-trim, and roll without a second edit algebra", () => {
    expect(keyboardInvocation({ ...base, target: "head" })?.invocation).toEqual({
      op: "trimIn",
      args: { uuid: "chosen", delta: 1, rippleAllTracks: false },
    });
    expect(keyboardInvocation({ ...base, target: "tail", alt: true })?.invocation).toEqual({
      op: "trimOut",
      args: { uuid: "chosen", delta: -1, rippleAllTracks: true },
    });
    expect(keyboardInvocation({ ...base, target: "head", meta: true })?.invocation).toEqual({
      op: "roll",
      args: { track: { trackId: "v1" }, leftUuid: "left", rightUuid: "chosen", delta: 1 },
    });
    expect(
      keyboardInvocation({ ...base, clipId: "left", target: "head", meta: true })?.limitation,
    ).toMatch(/Roll unavailable/);
  });

  it("moves vertically only to an adjacent compatible track at the same position", () => {
    expect(adjacentTrackMove(timeline, "chosen", "down")).toEqual({
      op: "move",
      args: {
        uuid: "chosen",
        toTrack: { trackId: "v2" },
        toPosition: 20,
        ripple: false,
        rippleAllTracks: false,
      },
    });
    expect(adjacentTrackMove(timeline, "audio", "up")).toBeNull();
    expect(selectableClips(timeline)).toHaveLength(5);
  });
});
