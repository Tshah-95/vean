import { describe, expect, it } from "vitest";
// The Tier-2b AUDIO resolver — the read-side mirror of serialize's audio-track walk
// evaluated into a flat schedule for the Web Audio graph (DESIGN-LIVE-PREVIEW §6
// Tier 2b, §7, §8.6, §9 step 6). Like resolveLayers, it is a pure ESM module
// (imports only the keyframe resolver), so vitest exercises it directly — the golden
// unit gate for the audio graph's INPUT.
//
// The load-bearing claims pinned here: (1) audio placement matches the SAME
// dissolve-trimming OVERLAP geometry resolveLayers/walkTrack use (so audio aligns to
// video frame-exactly); (2) a fade compiles to a 0→1 / 1→0 gain ramp at the right
// segment frames; (3) a static gain stacks into baseGain; (4) color clips carry no
// audio.
import type { AudioClip } from "../viewer/src/resolveAudio";
import { resolveAudio } from "../viewer/src/resolveAudio";
import type { ClipItem, Timeline, Track } from "../viewer/src/types";

const FPS: [number, number] = [30, 1];

/** Assert a clip exists (the first resolved clip in single-clip tests), narrowing
 *  `undefined` away without a non-null assertion (the repo bans `!`). */
function one(clips: AudioClip[]): AudioClip {
  const c = clips[0];
  if (!c) throw new Error("expected at least one resolved audio clip");
  return c;
}

function clip(
  id: string,
  resource: string,
  inF: number,
  outF: number,
  extra: Partial<ClipItem> = {},
): ClipItem {
  return { kind: "clip", id, resource, in: inF, out: outF, ...extra };
}

function audioTrack(id: string, items: Track["items"], hidden = false): Track {
  return { kind: "audio", id, items, ...(hidden ? { hidden: true } : {}) };
}

function videoTrack(id: string, items: Track["items"]): Track {
  return { kind: "video", id, items };
}

function tl(audio: Track[], video: Track[] = []): Timeline {
  return {
    profile: {
      description: "t",
      width: 1920,
      height: 1080,
      fps: FPS,
      displayAspectNum: 16,
      displayAspectDen: 9,
    },
    tracks: { video, audio },
    transitions: [],
    title: "t",
  };
}

describe("resolveAudio: placement + gain/fade", () => {
  it("places a single audio clip at its timeline span with media offset", () => {
    const t = tl([audioTrack("A1", [clip("bed", "corpus/tone.wav", 0, 89)])]);
    const { clips, trackIds } = resolveAudio(t);
    expect(trackIds).toEqual(["A1"]);
    expect(clips).toHaveLength(1);
    const c = one(clips);
    expect(c.uuid).toBe("bed");
    expect(c.resource).toBe("corpus/tone.wav");
    expect(c.timelineStart).toBe(0);
    expect(c.timelineEnd).toBe(89); // out 89 → 90-frame span [0,89]
    expect(c.mediaOffset).toBe(0);
    expect(c.baseGain).toBe(1);
    expect(c.gainAutomation).toEqual([]);
  });

  it("offsets a clip placed after a blank and reads its in-point as media offset", () => {
    const t = tl([
      audioTrack("A1", [{ kind: "blank", length: 30 }, clip("bed", "tone.wav", 10, 49)]),
    ]);
    const c = one(resolveAudio(t).clips);
    expect(c.timelineStart).toBe(30); // after the 30-frame blank
    expect(c.timelineEnd).toBe(69); // 40-frame span
    expect(c.mediaOffset).toBe(10); // clip.in
  });

  it("compiles the demo's fadeInOutVolume keyframe into a gain ramp (0→1→1→0)", () => {
    // The demo A1 producer: gain `0=0;5=1;84=1;89=0` over a 90-frame segment + a
    // static 0.501 volume. The resolver should: stack the static into baseGain, and
    // emit automation breakpoints at frames 0,5,84,89 with the keyframe values.
    const t = tl([
      audioTrack("A1", [
        clip("bed", "tone.wav", 0, 89, {
          filters: [
            { service: "volume", properties: { gain: "0=0;5=1;84=1;89=0" } },
            { service: "volume", properties: { gain: "0.5011872336272722" } },
          ],
        }),
      ]),
    ]);
    const c = one(resolveAudio(t).clips);
    // The static gain stacks into baseGain.
    expect(c.baseGain).toBeCloseTo(0.5011872336272722, 9);
    // Automation breakpoints at the keyframe frames, values 0→1→1→0.
    const byFrame = new Map(c.gainAutomation.map((p) => [p.frame, p.value]));
    expect(byFrame.get(0)).toBeCloseTo(0, 6);
    expect(byFrame.get(5)).toBeCloseTo(1, 6);
    expect(byFrame.get(84)).toBeCloseTo(1, 6);
    expect(byFrame.get(89)).toBeCloseTo(0, 6);
    // Sorted ascending and anchored at the segment ends.
    const frames = c.gainAutomation.map((p) => p.frame);
    expect(frames).toEqual([...frames].sort((a, b) => a - b));
    expect(frames[0]).toBe(0);
    expect(frames[frames.length - 1]).toBe(89);
  });

  it("compiles fadeIn/fadeOut sentinels into linear ramps", () => {
    const t = tl([
      audioTrack("A1", [
        clip("bed", "tone.wav", 0, 99, {
          filters: [
            { service: "vean.fadeIn", properties: { frames: 10 } },
            { service: "vean.fadeOut", properties: { frames: 10 } },
          ],
        }),
      ]),
    ]);
    const c = one(resolveAudio(t).clips); // segLen 100
    const byFrame = new Map(c.gainAutomation.map((p) => [p.frame, p.value]));
    expect(byFrame.get(0)).toBeCloseTo(0, 6); // fade-in start
    expect(byFrame.get(9)).toBeCloseTo(1, 6); // fade-in end (n-1)
    expect(byFrame.get(90)).toBeCloseTo(1, 6); // fade-out start (len-n)
    expect(byFrame.get(99)).toBeCloseTo(0, 6); // fade-out end
  });

  it("excludes color clips (no decodable audio)", () => {
    const t = tl([audioTrack("A1", [clip("c", "#FF0000", 0, 9, { service: "color" })])]);
    // The color clip carries no audio, but the track still gets a bus.
    expect(resolveAudio(t).clips).toHaveLength(0);
    expect(resolveAudio(t).trackIds).toEqual(["A1"]);
  });

  it("treats `hidden` as the audio-track MARKER, not a mute (audio still plays)", () => {
    // The parser flags EVERY audio track `hidden:true` (MLT `hide=\"video\"` — an
    // audio track's VIDEO is hidden, it plays audio). Skipping on `hidden` would
    // silence all audio. So a hidden audio track is audible.
    const t = tl([audioTrack("A1", [clip("bed", "tone.wav", 0, 89)], true)]);
    expect(resolveAudio(t).trackIds).toEqual(["A1"]);
    const c = one(resolveAudio(t).clips);
    expect(c.uuid).toBe("bed");
    expect(c.timelineStart).toBe(0);
    expect(c.timelineEnd).toBe(89);
  });

  it("mirrors walkTrack dissolve OVERLAP geometry: trims neighbours + schedules both edges", () => {
    // A1: bed-a(in0,out62) · dissolve(18) · bed-b(in0,out62). walkTrack trims 18 off
    // each neighbour: bed-a solo [0,44] (45 frames), overlap [45,62] (18 frames),
    // bed-b solo [63,107] (45 frames) — total 108. The resolver must produce the same.
    const t = tl([
      audioTrack("A1", [
        clip("bed-a", "a.wav", 0, 62),
        { kind: "dissolve", frames: 18 },
        clip("bed-b", "b.wav", 0, 62),
      ]),
    ]);
    const { clips } = resolveAudio(t);
    // Solo bed-a segment: [0,44], media offset 0 (in + 0 head-trim).
    const soloA = clips.find((c) => c.uuid === "bed-a" && c.timelineStart === 0);
    expect(soloA).toBeDefined();
    expect(soloA?.timelineEnd).toBe(44);
    expect(soloA?.mediaOffset).toBe(0);
    // Solo bed-b segment: [63,107], media offset 18 (its head was trimmed by 18).
    const soloB = clips.find((c) => c.uuid === "bed-b" && c.timelineStart === 63);
    expect(soloB).toBeDefined();
    expect(soloB?.timelineEnd).toBe(107);
    expect(soloB?.mediaOffset).toBe(18);
    // Two cross-faded edges over the overlap [45,62]: bed-a tail fading 1→0,
    // bed-b head fading 0→1.
    const edgeA = clips.find((c) => c.uuid === "bed-a" && c.timelineStart === 45);
    const edgeB = clips.find((c) => c.uuid === "bed-b" && c.timelineStart === 45);
    expect(edgeA?.timelineEnd).toBe(62);
    expect(edgeB?.timelineEnd).toBe(62);
    expect(edgeA?.gainAutomation[0]).toEqual({ frame: 0, value: 1 });
    expect(edgeA?.gainAutomation[1]).toEqual({ frame: 17, value: 0 });
    expect(edgeB?.gainAutomation[0]).toEqual({ frame: 0, value: 0 });
    expect(edgeB?.gainAutomation[1]).toEqual({ frame: 17, value: 1 });
    // bed-a tail media offset = out - frames + 1 = 62 - 18 + 1 = 45.
    expect(edgeA?.mediaOffset).toBe(45);
    // bed-b head media offset = in = 0.
    expect(edgeB?.mediaOffset).toBe(0);
  });

  it("sources embedded audio from video-track footage clips (melt mixes them on render)", () => {
    // A normal MP4 on a video track is video+audio together; the preview must source
    // its audio (it was silent before — the bug that made the editor look broken).
    const t = tl([], [videoTrack("V1", [clip("v", "footage.mov", 0, 30)])]);
    const { clips, trackIds } = resolveAudio(t);
    expect(trackIds).toEqual(["V1"]);
    expect(clips).toHaveLength(1);
    const c = one(clips);
    expect(c.uuid).toBe("v");
    expect(c.trackId).toBe("V1");
    expect(c.resource).toBe("footage.mov");
    expect(c.timelineStart).toBe(0);
    expect(c.timelineEnd).toBe(30);
    expect(c.mediaOffset).toBe(0);
  });

  it("skips graphic (Remotion overlay) + color clips on video tracks", () => {
    // Graphic overlays are visual; their baked .mov audio is silent/incidental.
    const graphic = clip("g", "proj/.vean/cache/remotion/chat.mov", 0, 30);
    const color = clip("bg", "#ff0000", 0, 30, { service: "color" });
    const t = tl([], [videoTrack("V2", [graphic, color])]);
    expect(resolveAudio(t).clips).toHaveLength(0);
  });

  it("mixes audio-track and video-track clips into one schedule", () => {
    const t = tl(
      [audioTrack("A1", [clip("bed", "tone.wav", 0, 30)])],
      [videoTrack("V1", [clip("v", "footage.mov", 0, 30)])],
    );
    const { clips, trackIds } = resolveAudio(t);
    expect(trackIds).toEqual(["A1", "V1"]);
    expect([...clips].map((c) => c.uuid).sort()).toEqual(["bed", "v"]);
  });
});
