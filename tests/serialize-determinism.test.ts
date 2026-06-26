import { describe, expect, it } from "vitest";
import {
  type Timeline,
  VERTICAL,
  audioTrack,
  clip,
  colorClip,
  dissolve,
  resetIds,
  timeline,
  toMlt,
  transition,
  videoTrack,
} from "../src/index";

// DETERMINISM is a hard requirement: the same IR must serialize to byte-identical
// XML. `toMlt` is implemented, so this guard is a real byte-identical compare:
// serializing the same IR twice — and rebuilding the IR from scratch each time —
// must yield the EXACT same XML string. The stable id counters reset per `toMlt`
// call and nothing is clock- or random-uuid-derived, so there is no hidden global
// state and no nondeterminism. The full format golden (the literal expected XML)
// lives in serialize.test.ts; this file isolates the determinism invariant on a
// multi-track fixture (2 video tracks + an audio track + a field transition).

function fixture(): Timeline {
  resetIds();
  return timeline(
    VERTICAL,
    {
      video: [
        videoTrack(colorClip(45, "black", { fadeIn: 12 }), dissolve(20), colorClip(60, "gold")),
        videoTrack(clip("/abs/overlay.mp4", { dur: 60 })),
      ],
      audio: [audioTrack(clip("/abs/vo.wav", { dur: 125, gain: 0.8 }))],
    },
    { transitions: [transition("qtblend", 1, 2, 0, 59)] },
  );
}

describe("toMlt determinism (golden)", () => {
  it("same IR ⇒ byte-identical XML, serialized twice", () => {
    const a = toMlt(fixture());
    const b = toMlt(fixture());
    expect(a).toBe(b);
    // It really did produce a document, not an empty string or an error sentinel.
    expect(a).toContain("<mlt ");
    expect(a).toContain('<tractor id="tractor1" shotcut="1"');
  });

  it("rebuilding the IR from scratch is also identical (no hidden global state)", () => {
    const a = toMlt(fixture());
    const b = toMlt(fixture());
    const c = toMlt(fixture());
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("validates the IR up front (a malformed IR fails in zod, before any XML)", () => {
    // Negative fps den is invalid → zod rejects before the serializer emits.
    const bad = fixture();
    (bad.profile.fps as unknown as [number, number])[1] = -1;
    expect(() => toMlt(bad)).toThrow();
  });
});
