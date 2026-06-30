// Tests for the footage-proxy STRIP transform (src/preview/proxy.ts) — the pure,
// testable piece of the live-preview pipeline. Stripping a timeline-with-graphic
// must yield an IR with the graphic clip(s) AND the qtblend field transition(s)
// removed, all footage/audio intact, and the stripped IR must still serialize +
// parse (round-trip). No real melt is invoked here (frame rendering is verified
// only by the real gate, per AGENTS.md).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  audioTrack,
  clip,
  colorClip,
  dissolve,
  resetIds,
  timeline,
  transition,
  uuid,
  videoTrack,
} from "../src/ir/builder";
import { timelineLength } from "../src/ir/length";
import { fromMlt } from "../src/ir/parse";
import { VERTICAL } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import { isGraphicClip, stripGraphics, totalFrames } from "../src/preview/proxy";

describe("stripGraphics", () => {
  it("drops an entirely-graphic GFX track and its qtblend transition, keeps footage + audio", () => {
    resetIds();
    const footage = colorClip(90, "#ff2244", { id: uuid() });
    // The overlay resource lives in the Remotion render cache — the strip's
    // resource signal (label does not survive a .mlt round-trip, so this is the
    // reliable post-parse signal).
    const overlay = clip("/proj/.vean/cache/remotion/abc123.mov", {
      id: uuid(),
      in: 0,
      out: 89,
      length: 90,
    });
    const tone = clip("corpus/tone.wav", { id: uuid(), in: 0, out: 89, length: 90 });
    const tl = timeline(VERTICAL, {
      video: [videoTrack(footage), videoTrack(overlay)],
      audio: [audioTrack(tone)],
    });
    tl.transitions.push(transition("qtblend", 1, 2, 0, 89, {}));

    const result = stripGraphics(tl);
    // The all-graphic video track (index 1) was dropped.
    expect(result.removedVideoTrackIndices).toEqual([1]);
    expect(result.removedClipCount).toBe(1);
    expect(result.removedTransitionCount).toBe(1);
    // Footage video track + audio track survive.
    expect(result.timeline.tracks.video.length).toBe(1);
    expect(result.timeline.tracks.audio.length).toBe(1);
    expect(result.timeline.transitions.length).toBe(0);
    // The kept video track is the footage (a color clip), not the overlay.
    const keptClip = result.timeline.tracks.video[0]?.items[0];
    expect(keptClip?.kind).toBe("clip");
    if (keptClip?.kind === "clip") expect(isGraphicClip(keptClip)).toBe(false);
    // The audio (tone) is untouched.
    expect(result.timeline.tracks.audio[0]?.items.length).toBe(1);
  });

  it("never mutates the input timeline", () => {
    resetIds();
    const overlay = clip("/x/.vean/cache/remotion/g.mov", {
      id: uuid(),
      in: 0,
      out: 29,
      length: 30,
    });
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(30, "#000000", { id: uuid() })), videoTrack(overlay)],
      audio: [],
    });
    tl.transitions.push(transition("qtblend", 1, 2, 0, 29, {}));
    const before = JSON.stringify(tl);
    stripGraphics(tl);
    expect(JSON.stringify(tl)).toBe(before);
  });

  it("replaces graphics on a MIXED track with equal-length blanks, preserving footage timing", () => {
    resetIds();
    // One video track holding footage THEN a graphic THEN footage — the graphic
    // becomes a blank so the trailing footage keeps its frame position.
    const a = colorClip(30, "#101010", { id: uuid() });
    const g = clip("/x/.vean/cache/remotion/mid.mov", { id: uuid(), in: 0, out: 29, length: 30 });
    const b = colorClip(30, "#202020", { id: uuid() });
    const tl = timeline(VERTICAL, { video: [videoTrack(a, g, b)], audio: [] });

    const result = stripGraphics(tl);
    // The track is kept (it has footage), the graphic clip replaced by a blank.
    expect(result.timeline.tracks.video.length).toBe(1);
    expect(result.removedClipCount).toBe(1);
    const items = result.timeline.tracks.video[0]?.items ?? [];
    expect(items.map((i) => i.kind)).toEqual(["clip", "blank", "clip"]);
    expect(items[1]).toMatchObject({ kind: "blank", length: 30 });
    // Total length is unchanged — footage positions are preserved.
    expect(totalFrames(result.timeline)).toBe(totalFrames(tl));
  });

  it("round-trips: the stripped IR serializes and re-parses without graphics", () => {
    resetIds();
    const footage = colorClip(60, "#3344ff", { id: uuid() });
    const overlay = clip("/p/.vean/cache/remotion/o.mov", {
      id: uuid(),
      in: 0,
      out: 59,
      length: 60,
    });
    const tl = timeline(VERTICAL, {
      video: [videoTrack(footage), videoTrack(overlay)],
      audio: [audioTrack(clip("corpus/tone.wav", { id: uuid(), in: 0, out: 59, length: 60 }))],
    });
    tl.transitions.push(transition("qtblend", 1, 2, 0, 59, {}));

    const stripped = stripGraphics(tl).timeline;
    const xml = toMlt(stripped);
    const reparsed = fromMlt(xml);
    // Same track shape after a full serialize → parse cycle.
    expect(reparsed.tracks.video.length).toBe(stripped.tracks.video.length);
    expect(reparsed.tracks.audio.length).toBe(stripped.tracks.audio.length);
    expect(reparsed.transitions.length).toBe(0);
    // And re-stripping is a no-op (idempotent: no graphics remain).
    const second = stripGraphics(reparsed);
    expect(second.removedClipCount).toBe(0);
    expect(second.removedTransitionCount).toBe(0);
  });
});

describe("isGraphicClip", () => {
  it("flags a clip by graphic label OR a cache/remotion resource", () => {
    expect(
      isGraphicClip({
        kind: "clip",
        id: "1",
        resource: "/a/b.mov",
        in: 0,
        out: 1,
        label: "graphic:x",
        filters: [],
      } as never),
    ).toBe(true);
    expect(
      isGraphicClip({
        kind: "clip",
        id: "2",
        resource: "/p/.vean/cache/remotion/x.mov",
        in: 0,
        out: 1,
        filters: [],
      } as never),
    ).toBe(true);
    expect(
      isGraphicClip({
        kind: "clip",
        id: "3",
        resource: "/media/footage.mp4",
        in: 0,
        out: 1,
        filters: [],
      } as never),
    ).toBe(false);
  });
});

describe("totalFrames (the proxy render bound + the viewer clock range)", () => {
  // The desync bug: totalFrames is consumed THREE ways — the proxy render frame
  // bound, the viewer's master-clock range, and the timeline strip width. They
  // must all equal the timeline's true played length. A dissolve OVERLAPS its
  // neighbours, so a naive sum-of-item-lengths overcounts by the overlap and the
  // playhead runs past the real EOF (a frozen last frame). These pin the fix.
  it("accounts for dissolve overlap (does NOT sum clip+frames+clip)", () => {
    resetIds();
    // clip(45) + dissolve(20) + clip(60): the dissolve consumes 20f of each
    // neighbour, so the played length is (45−20) + 20 + (60−20) = 85, NOT 125.
    const a = colorClip(45, "#101010", { id: uuid() });
    const b = colorClip(60, "#202020", { id: uuid() });
    const tl = timeline(VERTICAL, { video: [videoTrack(a, dissolve(20), b)] });
    expect(totalFrames(tl)).toBe(85);
    // Naive sum would have been 45 + 20 + 60 = 125 (the overcount the bug shipped).
    expect(totalFrames(tl)).not.toBe(125);
  });

  it("equals timelineLength and the longest track including audio", () => {
    resetIds();
    // V0 dissolves to 85; an audio track of 90 makes the timeline 90 frames — the
    // value melt renders to and the clock must range over (the vean-multitrack
    // shape). totalFrames is the MAX across video AND audio tracks.
    const a = colorClip(45, "#101010", { id: uuid() });
    const b = colorClip(60, "#202020", { id: uuid() });
    const tone = clip("corpus/tone.wav", { id: uuid(), in: 0, out: 89, length: 90 });
    const tl = timeline(VERTICAL, {
      video: [videoTrack(a, dissolve(20), b)],
      audio: [audioTrack(tone)],
    });
    expect(totalFrames(tl)).toBe(90);
    expect(totalFrames(tl)).toBe(timelineLength(tl));
  });

  it("matches the serializer's background-producer length on the corpus", () => {
    // The canonical cross-check: the serializer stretches a background color
    // producer (resource="0") to exactly maxLength. totalFrames must agree, or
    // the proxy bound / clock range would drift from what melt renders.
    const xml = readFileSync(
      join(import.meta.dirname, "..", "corpus", "vean-multitrack.mlt"),
      "utf8",
    );
    const tl = fromMlt(xml);
    const out = toMlt(tl);
    // Find the background producer block (resource "0") and read its length.
    const bgBlock = out.split("<producer").find((b) => /resource">0</.test(b)) ?? "";
    const bgLen = Number(bgBlock.match(/length">(\d+)/)?.[1] ?? -1);
    expect(bgLen).toBeGreaterThan(0);
    expect(totalFrames(tl)).toBe(bgLen);
  });
});
