// timeline.addGraphic — assert the composite seam: starting from a base footage
// timeline, addGraphic yields (a) an upper GFX video track, (b) the alpha clip at
// the requested position, (c) a qtblend field transition with the right
// a_track/b_track, and that applying the returned inverse sequence reconstructs
// the original IR exactly. No real Remotion/melt runs here.
import { describe, expect, it } from "vitest";
import { addGraphic } from "../src/actions/graphic";
import { colorClip, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { fromMlt } from "../src/ir/parse";
import { VERTICAL } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import type { Clip, Timeline } from "../src/ir/types";
import { apply } from "../src/ops";
import { isEditError } from "../src/ops/types";

function baseTimeline(): Timeline {
  resetIds();
  // A single footage video track, 90 frames.
  return timeline(VERTICAL, {
    video: [videoTrack(colorClip(90, "blue", { id: "footage" }))],
  });
}

describe("timeline.addGraphic composite", () => {
  it("adds a GFX track, overwrites the alpha clip, and pushes a qtblend transition", () => {
    const state = baseTimeline();
    const result = addGraphic(state, {
      clipPath: "/abs/lower-third.mov",
      position: 0,
      durationFrames: 90,
      newTrack: true,
    });
    if (!("state" in result)) throw new Error(`unexpected error: ${JSON.stringify(result)}`);

    // (a) An overlay GFX video track was APPENDED (the base footage stays the top
    // of tracks.video; the overlay lands at the BOTTOM = the top compositing layer).
    expect(result.state.tracks.video).toHaveLength(2);
    expect(result.createdTrack).toBe(true);

    // (b) The alpha clip is at position 0 on the GFX (bottom/overlay) track.
    const gfxTrack = result.state.tracks.video[1];
    if (!gfxTrack) throw new Error("no gfx track");
    expect(gfxTrack.id).toBe(result.gfxTrackId);
    const first = gfxTrack.items[0] as Clip;
    expect(first.kind).toBe("clip");
    expect(first.resource).toBe("/abs/lower-third.mov");
    expect(first.out - first.in + 1).toBe(90);

    // (c) A qtblend field transition composites GFX (b, on top) over footage (a,
    // base). melt renders the HIGHER index on top, so the overlay (higher index)
    // is b_track and the footage (lower index) is a_track.
    expect(result.state.transitions).toHaveLength(1);
    const t = result.state.transitions[0];
    if (!t) throw new Error("no transition");
    expect(t.service).toBe("qtblend");
    // Background = index 0; footage (base, top of array) = 1; GFX overlay = 2.
    expect(result.aTrack).toBe(1);
    expect(result.bTrack).toBe(2);
    expect(t.aTrack).toBe(1);
    expect(t.bTrack).toBe(2);
    expect(t.in).toBe(0);
    expect(t.out).toBe(89);

    // The composited timeline serializes to a qtblend <transition> on the main
    // tractor referencing the two video tracks.
    const xml = toMlt(result.state);
    expect(xml).toContain('mlt_service="qtblend"');
    expect(xml).toContain("/abs/lower-third.mov");
  });

  it("inverts exactly: applying the inverse sequence reconstructs the original IR", () => {
    const original = baseTimeline();
    const result = addGraphic(original, {
      clipPath: "/abs/lower-third.mov",
      position: 0,
      durationFrames: 90,
      newTrack: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");

    // Replay the inverse sequence (already in UNDO order) over the new state.
    let work = result.state;
    for (const inv of result.inverse) {
      const back = apply(inv, work);
      if (isEditError(back)) throw new Error(`inverse step errored: ${JSON.stringify(back)}`);
      work = back.state;
    }
    expect(work).toEqual(original);
  });

  it("places the overlay at a non-zero position with the matching transition span", () => {
    const state = baseTimeline();
    const result = addGraphic(state, {
      clipPath: "/abs/lt.mov",
      position: 30,
      durationFrames: 30,
      newTrack: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    const t = result.state.transitions[0];
    if (!t) throw new Error("no transition");
    expect(t.in).toBe(30);
    expect(t.out).toBe(59);
  });

  it("returns a typed precondition when there is no footage video track", () => {
    resetIds();
    const audioOnly = timeline(VERTICAL, {});
    const result = addGraphic(audioOnly, {
      clipPath: "/abs/lt.mov",
      position: 0,
      durationFrames: 30,
      newTrack: true,
    });
    expect("state" in result).toBe(false);
    if ("state" in result) return;
    expect(result.kind).toBe("precondition");
  });

  // ─── uuid-collision regression (stable producer identity invariant) ──────────
  // Like addAudio, `timeline.addGraphic` runs as a ONE-SHOT CLI process (parse →
  // overwrite → write), so the overlay clip is the first authoring-counter use —
  // `clip-0` — in every run (the counter resets to 0 per process). Two add-graphic
  // calls used to mint two overlay clips sharing uuid `clip-0`, violating "Identity
  // = stable producer UUIDs" and making the inverse ambiguous. The fix mints a
  // runtime-unique uuid() per overlay. We reproduce the two processes FAITHFULLY by
  // serializing→parsing between them, REUSING the same gfx track for the second.
  it("mints DISTINCT overlay clip ids across two CLI processes (no clip-0 collision)", () => {
    // Seed on disk: footage only.
    resetIds();
    const seedXml = toMlt(
      timeline(VERTICAL, { video: [videoTrack(colorClip(120, "blue", { id: "footage" }))] }),
    );

    // Process 1: PARSE, add the first overlay on a fresh GFX track, WRITE.
    resetIds();
    const r1 = addGraphic(fromMlt(seedXml), {
      clipPath: "/abs/lt1.mov",
      position: 0,
      durationFrames: 30,
      newTrack: true,
    });
    if (!("state" in r1)) throw new Error(`r1 error: ${JSON.stringify(r1)}`);
    const after1Xml = toMlt(r1.state);

    // Process 2: PARSE process 1's output (counter resets to 0), add a SECOND
    // overlay at a later position, REUSING the existing GFX track (newTrack omitted).
    resetIds();
    const before2 = fromMlt(after1Xml);
    const r2 = addGraphic(before2, {
      clipPath: "/abs/lt2.mov",
      position: 60,
      durationFrames: 30,
    });
    if (!("state" in r2)) throw new Error(`r2 error: ${JSON.stringify(r2)}`);

    // The two overlays live on the gfx track (the bottom-most video track).
    const gfx = r2.state.tracks.video[r2.state.tracks.video.length - 1];
    if (!gfx) throw new Error("no gfx track");
    const overlays = gfx.items.filter((it): it is Clip => it.kind === "clip");
    expect(overlays).toHaveLength(2);
    const [o1, o2] = overlays as [Clip, Clip];
    expect(o1.id).not.toBe(o2.id); // distinct ids — no shared clip-0
    expect(o1.id.startsWith("clip-")).toBe(false); // runtime uuid, not the counter
    expect(o2.id.startsWith("clip-")).toBe(false);

    // The second add's inverse must unambiguously reconstruct `before2` exactly.
    let work = r2.state;
    for (const inv of r2.inverse) {
      const back = apply(inv, work);
      if (isEditError(back)) throw new Error(`r2 inverse errored: ${JSON.stringify(back)}`);
      work = back.state;
    }
    expect(work).toEqual(before2);
  });
});
