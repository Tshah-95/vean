import { describe, expect, it } from "vitest";
import { animateTransform, applySubjectAlpha } from "../src/actions/compositing";
import { colorClip, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { VERTICAL } from "../src/ir/profile";
import type { Timeline } from "../src/ir/types";
import { apply } from "../src/ops";
import { isEditError } from "../src/ops/types";

function base(): Timeline {
  resetIds();
  return timeline(VERTICAL, {
    video: [videoTrack(colorClip(120, "blue", { id: "speaker" }))],
  });
}

function expectInverts(
  inverse: { op: string; args: unknown }[],
  post: Timeline,
  original: Timeline,
) {
  let work = post;
  for (const invocation of inverse) {
    const result = apply(invocation, work);
    if (isEditError(result)) throw new Error(JSON.stringify(result));
    work = result.state;
  }
  expect(work).toEqual(original);
}

describe("timeline.animateTransform", () => {
  it("resolves a stable clip UUID to qtblend topology and emits eased rect keyframes", () => {
    const original = base();
    const result = animateTransform(original, {
      clipId: "speaker",
      startFrame: 30,
      endFrame: 45,
      from: { x: 0, y: 0, width: 1, height: 1 },
      to: { x: 0.68, y: 0.08, width: 0.28, height: 0.84, opacity: 0.9 },
      easing: "smooth",
      fit: "stretch",
    });
    if (!("state" in result)) throw new Error(JSON.stringify(result));

    expect(result.clipId).toBe("speaker");
    expect(result.aTrack).toBe(0);
    expect(result.bTrack).toBe(1);
    expect(result.reusedTransition).toBe(false);
    expect(result.rect).toBe("30~=0 0 1080 1920 1;45=734.4 153.6 302.4 1612.8 0.9");
    expect(result.state.transitions[0]).toMatchObject({
      service: "qtblend",
      aTrack: 0,
      bTrack: 1,
      in: 0,
      out: 119,
      properties: { rect: result.rect, distort: 1, compositing: 0 },
    });
    // The clip itself is not replaced or re-identified.
    expect(result.state.tracks.video[0]?.items[0]).toMatchObject({ id: "speaker" });
    expectInverts(result.inverse, result.state, original);
  });

  it("reuses the subject-alpha qtblend instead of stacking a duplicate transition", () => {
    const original = base();
    const placed = applySubjectAlpha(original, {
      cutoutResource: "/abs/cutout.mov",
      targetClipId: "speaker",
      position: 0,
      durationFrames: 120,
    });
    if (!("state" in placed)) throw new Error(JSON.stringify(placed));
    const animated = animateTransform(placed.state, {
      clipId: placed.cutoutClipId,
      startFrame: 60,
      endFrame: 75,
      from: { x: 0, y: 0, width: 1, height: 1 },
      to: { x: 0.7, y: 0.1, width: 0.25, height: 0.8 },
      fit: "stretch",
    });
    if (!("state" in animated)) throw new Error(JSON.stringify(animated));

    expect(animated.reusedTransition).toBe(true);
    expect(animated.state.transitions).toHaveLength(1);
    expect(animated.state.transitions[0]?.properties.rect).toBe(animated.rect);
    expectInverts(animated.inverse, animated.state, placed.state);
  });

  it("preserves the cumulative compositing root when animating a third-layer cutout", () => {
    resetIds();
    const original = timeline(VERTICAL, {
      video: [
        videoTrack(colorClip(120, "blue", { id: "camera" })),
        videoTrack(colorClip(120, "gold", { id: "graphic" })),
      ],
    });
    original.transitions.push({
      service: "qtblend",
      aTrack: 1,
      bTrack: 2,
      in: 0,
      out: 119,
      properties: {},
    });
    const placed = applySubjectAlpha(original, {
      cutoutResource: "/abs/cutout.mov",
      targetClipId: "camera",
      position: 0,
      durationFrames: 120,
      cutoutClipId: "founder",
    });
    if (!("state" in placed)) throw new Error(JSON.stringify(placed));
    expect(placed.state.transitions[1]).toMatchObject({ aTrack: 1, bTrack: 3 });

    const animated = animateTransform(placed.state, {
      clipId: "founder",
      startFrame: 30,
      endFrame: 45,
      from: { x: 0, y: 0, width: 1, height: 1 },
      to: { x: 0.68, y: 0.08, width: 0.28, height: 0.84 },
    });
    if (!("state" in animated)) throw new Error(JSON.stringify(animated));
    expect(animated.state.transitions[1]).toMatchObject({ aTrack: 1, bTrack: 3 });
  });

  it("uses known source dimensions to aspect-fit contain slots", () => {
    const result = animateTransform(base(), {
      clipId: "speaker",
      startFrame: 0,
      endFrame: 10,
      from: { unit: "pixels", x: 0, y: 0, width: 500, height: 500 },
      to: { unit: "pixels", x: 500, y: 0, width: 500, height: 500 },
      fit: "contain",
      sourceDimensions: { width: 1920, height: 1080 },
    });
    if (!("state" in result)) throw new Error(JSON.stringify(result));
    // 16:9 source in a square slot: full width, vertically centered at 109.375.
    expect(result.rect).toContain("0 109.375 500 281.25 1");
  });

  it("preserves an off-canvas destination so a transparent source can clip naturally", () => {
    const landscape = base();
    landscape.profile.width = 1920;
    landscape.profile.height = 1080;
    const result = animateTransform(landscape, {
      clipId: "speaker",
      startFrame: 30,
      endFrame: 45,
      from: { unit: "pixels", x: 0, y: 0, width: 1920, height: 1080 },
      to: { unit: "pixels", x: 959, y: 270, width: 1440, height: 810 },
      fit: "contain",
      sourceDimensions: { width: 1280, height: 720 },
    });
    if (!("state" in result)) throw new Error(JSON.stringify(result));
    expect(result.rect).toContain("45=959 270 1440 810 1");
  });
});

describe("timeline.applySubjectAlpha", () => {
  it("places the existing cutout on a fresh top track and validates target coverage", () => {
    const original = base();
    const result = applySubjectAlpha(original, {
      cutoutResource: "/abs/person-alpha.mov",
      targetClipId: "speaker",
      position: 12,
      durationFrames: 60,
      cutoutClipId: "s01-founder-cutout",
    });
    if (!("state" in result)) throw new Error(JSON.stringify(result));

    expect(result.state.tracks.video).toHaveLength(2);
    expect(result.cutoutClipId).toBe("s01-founder-cutout");
    expect(result.cutoutTrackId).toBe("s01-founder-cutout-track");
    expect(result.state.tracks.video[1]?.id).toBe(result.cutoutTrackId);
    expect(result.state.tracks.video[1]?.items.find((item) => item.kind === "clip")).toMatchObject({
      id: result.cutoutClipId,
      resource: "/abs/person-alpha.mov",
    });
    expect(result.state.transitions[0]).toMatchObject({
      service: "qtblend",
      aTrack: 1,
      bTrack: 2,
      in: 12,
      out: 71,
    });
    expectInverts(result.inverse, result.state, original);
  });

  it("rejects a live Remotion target because the browser cannot interleave it below footage", () => {
    const state = base();
    const clip = state.tracks.video[0]?.items[0];
    if (!clip || clip.kind !== "clip") throw new Error("missing clip");
    clip.composition = { id: "Title" };
    const result = applySubjectAlpha(state, {
      cutoutResource: "/abs/person-alpha.mov",
      targetClipId: "speaker",
      position: 0,
      durationFrames: 30,
    });
    expect(result).toMatchObject({ kind: "precondition" });
  });
});
