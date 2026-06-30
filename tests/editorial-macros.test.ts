// Editorial macros (Stream S3 / roadmap T6) — assert each task-shaped macro
// compiles to the existing pure ops with a CORRECT inverse and a faithful
// consequence report. The load-bearing law (edit-algebra #2): applying the
// returned inverse sequence (UNDO order) reconstructs the ORIGINAL IR exactly. No
// real melt/Remotion runs here — these are pure functions over the IR.
import { describe, expect, it } from "vitest";
import {
  addBrollOverRange,
  applyLayout,
  duckMusicUnderSpeech,
  removeDeadAir,
  tightenCut,
} from "../src/actions/editorial";
import {
  audioTrack,
  blank,
  clip,
  colorClip,
  resetIds,
  timeline,
  videoTrack,
} from "../src/ir/builder";
import { fromMlt } from "../src/ir/parse";
import { VERTICAL } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import type { Clip, Timeline } from "../src/ir/types";
import { apply } from "../src/ops";
import { gainToDb } from "../src/ops/types";
import { isEditError } from "../src/ops/types";

/** Replay an ordered inverse sequence over a post-edit state and assert it
 *  reconstructs `original` exactly (the inverse is already in UNDO order). */
function expectInvertsTo(
  inverse: { op: string; args: unknown }[],
  post: Timeline,
  original: Timeline,
): void {
  let work = post;
  for (const inv of inverse) {
    const back = apply(inv, work);
    if (isEditError(back)) throw new Error(`inverse step errored: ${JSON.stringify(back)}`);
    work = back.state;
  }
  expect(work).toEqual(original);
}

function headFootage(): Timeline {
  resetIds();
  // A single talking-head footage track, 120 frames.
  return timeline(VERTICAL, {
    video: [videoTrack(colorClip(120, "blue", { id: "head" }))],
  });
}

describe("applyLayout", () => {
  it("intercut: adds an overlay track, crops the b-roll to cover, and composites it full-frame", () => {
    const state = headFootage();
    const result = applyLayout(state, {
      brollResource: "/abs/broll.mp4",
      mode: "intercut",
      position: 30,
      durationFrames: 60,
      newTrack: true,
    });
    if (!("state" in result)) throw new Error(`unexpected error: ${JSON.stringify(result)}`);

    // An overlay video track was appended (b-roll = bottom of tracks.video = top
    // melt layer); the talking head stays the base (top of the array, lowest index).
    expect(result.state.tracks.video).toHaveLength(2);
    expect(result.createdTrack).toBe(true);
    expect(result.mode).toBe("intercut");

    // The b-roll clip landed at position 30 on the overlay track and carries an
    // affine crop filter (cover, no stretch) — never a raw property edit.
    const overlay = result.state.tracks.video[1];
    if (!overlay) throw new Error("no overlay track");
    const broll = overlay.items.find((it): it is Clip => it.kind === "clip");
    if (!broll) throw new Error("no broll clip");
    expect(broll.resource).toBe("/abs/broll.mp4");
    expect(broll.out - broll.in + 1).toBe(60);
    expect(broll.filters.some((f) => f.service === "affine")).toBe(true);

    // A qtblend field transition composites b-roll (b/higher index) over the head
    // (a/lower index) for the [30, 89] span, with a full-frame rect.
    expect(result.aTrack).toBe(1);
    expect(result.bTrack).toBe(2);
    const t = result.state.transitions.find((x) => x.service === "qtblend");
    if (!t) throw new Error("no qtblend transition");
    expect(t.in).toBe(30);
    expect(t.out).toBe(89);
    expect(String(t.properties.rect)).toContain("100%");

    // Serializes to a real qtblend transition + the affine crop.
    const xml = toMlt(result.state);
    expect(xml).toContain('mlt_service="qtblend"');
    expect(xml).toContain('mlt_service="affine"');
  });

  it("split: scales the head into the top half and the b-roll into the bottom half (two qtblends)", () => {
    const state = headFootage();
    const result = applyLayout(state, {
      brollResource: "/abs/broll.mp4",
      mode: "split",
      position: 0,
      durationFrames: 120,
      newTrack: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    // Two qtblend transitions: the b-roll-over-head composite AND the head-into-top-half.
    const blends = result.state.transitions.filter((t) => t.service === "qtblend");
    expect(blends).toHaveLength(2);
    // One rect tucks into the bottom half (y=50%), the other into the top (y=0).
    const rects = blends.map((b) => String(b.properties.rect));
    expect(rects.some((r) => r.startsWith("0% 50%"))).toBe(true); // bottom slot (b-roll)
    expect(rects.some((r) => r.startsWith("0% 0%"))).toBe(true); // top slot (head)
  });

  it("overlay: places a floating PiP inset over the full-frame head", () => {
    const state = headFootage();
    const result = applyLayout(state, {
      brollResource: "/abs/cam.mp4",
      mode: "overlay",
      position: 10,
      durationFrames: 40,
      insetSlot: { x: 0.6, y: 0.6, w: 0.35, h: 0.35 },
      newTrack: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    const t = result.state.transitions.find((x) => x.service === "qtblend");
    if (!t) throw new Error("no qtblend");
    expect(String(t.properties.rect)).toContain("60%"); // the inset offset
  });

  it("inverts exactly across serialize/parse (intercut)", () => {
    const original = headFootage();
    const result = applyLayout(original, {
      brollResource: "/abs/broll.mp4",
      mode: "intercut",
      position: 30,
      durationFrames: 60,
      newTrack: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    expectInvertsTo(result.inverse, result.state, original);
    // And the post-edit state serializes DETERMINISTICALLY (same IR → byte-identical
    // XML) and survives a parse→serialize round-trip byte-faithfully (the real
    // determinism invariant — builder-authored ids/explicit-undefined keys are
    // normalized by the parser, so we round-trip the SERIALIZED form, not the
    // builder IR object).
    const xml = toMlt(result.state);
    expect(toMlt(result.state)).toBe(xml); // deterministic
    expect(toMlt(fromMlt(xml))).toBe(xml); // parse→serialize fixpoint
  });

  it("returns a typed precondition when there is no footage video track", () => {
    resetIds();
    const audioOnly = timeline(VERTICAL, {});
    const result = applyLayout(audioOnly, {
      brollResource: "/abs/broll.mp4",
      mode: "intercut",
      position: 0,
      durationFrames: 30,
    });
    expect("state" in result).toBe(false);
    if ("state" in result) return;
    expect(result.kind).toBe("precondition");
  });
});

describe("addBrollOverRange", () => {
  it("covers a [start, end] range as a full-frame cutaway and inverts exactly", () => {
    const original = headFootage();
    const result = addBrollOverRange(original, {
      brollResource: "/abs/broll.mp4",
      startFrame: 24,
      endFrame: 71, // inclusive → 48 frames
      newTrack: true,
    });
    if (!("state" in result)) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    const t = result.state.transitions.find((x) => x.service === "qtblend");
    if (!t) throw new Error("no qtblend");
    expect(t.in).toBe(24);
    expect(t.out).toBe(71);
    expectInvertsTo(result.inverse, result.state, original);
  });

  it("rejects an inverted range", () => {
    const state = headFootage();
    const result = addBrollOverRange(state, {
      brollResource: "/abs/broll.mp4",
      startFrame: 80,
      endFrame: 40,
    });
    expect("state" in result).toBe(false);
    if ("state" in result) return;
    expect(result.kind).toBe("invalid-args");
  });
});

describe("duckMusicUnderSpeech", () => {
  function speechPlusMusic(): Timeline {
    resetIds();
    return timeline(VERTICAL, {
      video: [videoTrack(colorClip(120, "blue", { id: "head" }))],
      audio: [
        audioTrack(clip("/abs/vo.wav", { id: "vo", dur: 120 })), // speech track (A1)
        audioTrack(clip("/abs/music.mp3", { id: "music", dur: 120 })), // music track (A2)
      ],
    });
  }

  it("ducks the music track (not the speech track) by the requested dB and inverts", () => {
    const original = speechPlusMusic();
    const result = duckMusicUnderSpeech(original, {
      speechTrackId: original.tracks.audio[0]?.id,
      duckDb: -12,
    });
    if (!("state" in result)) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    // The music clip was ducked; the VO untouched.
    expect(result.duckedClipIds).toEqual(["music"]);
    const music = result.state.tracks.audio[1]?.items[0] as Clip;
    const vo = result.state.tracks.audio[0]?.items[0] as Clip;
    expect(music.gain).toBeDefined();
    expect(gainToDb(music.gain as number)).toBeCloseTo(-12, 4);
    expect(vo.gain).toBeUndefined(); // speech left at unity
    expectInvertsTo(result.inverse, result.state, original);
  });

  it("ducks an explicit clip set relative to its current gain", () => {
    resetIds();
    const original = timeline(VERTICAL, {
      audio: [audioTrack(clip("/abs/music.mp3", { id: "m", dur: 60, gain: 0.5 }))], // ~-6 dB
    });
    const result = duckMusicUnderSpeech(original, { musicClipIds: ["m"], duckDb: -6 });
    if (!("state" in result)) throw new Error("unexpected error");
    const m = result.state.tracks.audio[0]?.items[0] as Clip;
    // A 0.5 multiplier is -6.02 dB (not exactly -6); ducked another -6 dB → ~-12.02.
    // The duck is RELATIVE to the clip's current level — that's the assertion.
    expect(gainToDb(m.gain as number)).toBeCloseTo(-12, 1);
    expectInvertsTo(result.inverse, result.state, original);
  });

  it("returns a typed error when there is no audio track", () => {
    const result = duckMusicUnderSpeech(headFootage(), {});
    expect("state" in result).toBe(false);
    if ("state" in result) return;
    expect(result.kind).toBe("precondition");
  });
});

describe("tightenCut", () => {
  function clipTrack(): Timeline {
    resetIds();
    return timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/take.mp4", { id: "take", in: 0, out: 99 }))], // 100 frames
    });
  }

  it("trims head + tail and inverts exactly", () => {
    const original = clipTrack();
    const result = tightenCut(original, { uuid: "take", headFrames: 10, tailFrames: 15 });
    if (!("state" in result)) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    const take = result.state.tracks.video[0]?.items.find((it): it is Clip => it.kind === "clip");
    if (!take) throw new Error("no take clip");
    // 100 − 10 − 15 = 75 played frames.
    expect(take.out - take.in + 1).toBe(75);
    expectInvertsTo(result.inverse, result.state, original);
  });

  it("rejects an over-trim that would consume the whole clip", () => {
    const result = tightenCut(clipTrack(), { uuid: "take", headFrames: 60, tailFrames: 60 });
    expect("state" in result).toBe(false);
    if ("state" in result) return;
    expect(result.kind).toBe("invalid-args");
  });

  it("rejects a no-op (head and tail both 0)", () => {
    const result = tightenCut(clipTrack(), { uuid: "take" });
    expect("state" in result).toBe(false);
    if ("state" in result) return;
    expect(result.kind).toBe("invalid-args");
  });

  it("returns clip-not-found for an unknown uuid", () => {
    const result = tightenCut(clipTrack(), { uuid: "nope", tailFrames: 5 });
    expect("state" in result).toBe(false);
    if ("state" in result) return;
    expect(result.kind).toBe("clip-not-found");
  });
});

describe("removeDeadAir", () => {
  it("closes a leading gap and an inter-clip gap, reporting the frames removed, and inverts", () => {
    resetIds();
    // A track with a 12-frame lead gap, a clip, a 20-frame gap, another clip.
    const original = timeline(VERTICAL, {
      video: [
        videoTrack(
          blank(12),
          clip("/abs/a.mp4", { id: "a", dur: 30 }),
          blank(20),
          clip("/abs/b.mp4", { id: "b", dur: 30 }),
        ),
      ],
    });
    const result = removeDeadAir(original, {});
    if (!("state" in result)) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    // Both gaps closed; 12 + 20 = 32 frames of dead air removed.
    expect(result.gapsClosed).toBe(2);
    expect(result.framesRemoved).toBe(32);
    // The track now starts with clip "a" at frame 0 and "b" immediately after it.
    const items = result.state.tracks.video[0]?.items ?? [];
    const clips = items.filter((it): it is Clip => it.kind === "clip");
    expect(clips.map((c) => c.id)).toEqual(["a", "b"]);
    // No leading/inter-clip blank remains.
    expect(items[0]?.kind).toBe("clip");
    expectInvertsTo(result.inverse, result.state, original);
  });

  it("respects minGapFrames (a small pause below the threshold is kept)", () => {
    resetIds();
    const original = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/a.mp4", { id: "a", dur: 30 }),
          blank(3), // tiny pause
          clip("/abs/b.mp4", { id: "b", dur: 30 }),
        ),
      ],
    });
    const result = removeDeadAir(original, { minGapFrames: 5 });
    if (!("state" in result)) throw new Error("unexpected error");
    expect(result.gapsClosed).toBe(0);
    expect(result.framesRemoved).toBe(0);
  });

  it("is a no-op on a gapless track", () => {
    resetIds();
    const original = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/a.mp4", { id: "a", dur: 30 }),
          clip("/abs/b.mp4", { id: "b", dur: 30 }),
        ),
      ],
    });
    const result = removeDeadAir(original, {});
    if (!("state" in result)) throw new Error("unexpected error");
    expect(result.gapsClosed).toBe(0);
    expect(result.state).toEqual(original);
  });

  it("returns track-not-found for an unknown track id", () => {
    const result = removeDeadAir(headFootage(), { trackId: "nope" });
    expect("state" in result).toBe(false);
    if ("state" in result) return;
    expect(result.kind).toBe("track-not-found");
  });
});
