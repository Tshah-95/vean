import { describe, expect, it } from "vitest";
// The Tier-0 resolve-visible-set walk (the read-side mirror of serialize:walkTrack
// evaluated at a frame). The viewer is a separate Vite app excluded from the root
// tsconfig, but resolveVisible.ts is a pure ESM module (no Node/DOM), so vitest
// imports and exercises it directly — the golden unit gate for Tier-0 liveness
// (DESIGN-LIVE-PREVIEW §6 Tier 0, §9 step 2).
import { resolveVisibleOnTrack, resolveVisibleSet } from "../viewer/src/resolveVisible";
import type { Timeline, Track } from "../viewer/src/types";

const FPS: [number, number] = [30, 1];

function clip(id: string, resource: string, inFrame: number, outFrame: number) {
  return { kind: "clip" as const, id, resource, in: inFrame, out: outFrame };
}

function videoTrack(id: string, items: Track["items"], hidden = false): Track {
  return { kind: "video", id, items, ...(hidden ? { hidden: true } : {}) };
}

function tl(video: Track[]): Timeline {
  return {
    profile: {
      description: "t",
      width: 1920,
      height: 1080,
      fps: FPS,
      displayAspectNum: 16,
      displayAspectDen: 9,
    },
    tracks: { video, audio: [] },
    transitions: [],
    title: "t",
  };
}

describe("resolveVisibleOnTrack: source-frame math (clip.in + (frame - clipStart))", () => {
  // Mirror the retire V1 playlist: two back-to-back clips. producer0 in=107..221
  // (115f), producer1 in=0..299 (300f). Timeline starts at 0.
  const track = videoTrack("V1", [
    clip("p0", "/m/a.mp4", 107, 221),
    clip("p1", "/m/b.mp4", 0, 299),
  ]);

  it("resolves the first clip's source frame at its head", () => {
    const v = resolveVisibleOnTrack(tl([track]), 0, 0);
    expect(v).not.toBeNull();
    expect(v?.uuid).toBe("p0");
    expect(v?.sourceFrame).toBe(107); // in + (0 - 0)
  });

  it("resolves the first clip's source frame mid-clip", () => {
    const v = resolveVisibleOnTrack(tl([track]), 0, 50);
    expect(v?.uuid).toBe("p0");
    expect(v?.sourceFrame).toBe(157); // 107 + 50
  });

  it("resolves the first clip's last source frame at its tail", () => {
    const v = resolveVisibleOnTrack(tl([track]), 0, 114); // last frame of a 115f clip
    expect(v?.uuid).toBe("p0");
    expect(v?.sourceFrame).toBe(221); // 107 + 114 == out
  });

  it("crosses the cut into the second clip", () => {
    const v = resolveVisibleOnTrack(tl([track]), 0, 115); // first frame of clip 2
    expect(v?.uuid).toBe("p1");
    expect(v?.sourceFrame).toBe(0); // in + (115 - 115)
  });

  it("resolves mid second clip", () => {
    const v = resolveVisibleOnTrack(tl([track]), 0, 200);
    expect(v?.uuid).toBe("p1");
    expect(v?.sourceFrame).toBe(85); // 0 + (200 - 115)
  });

  it("returns null past the track end", () => {
    expect(resolveVisibleOnTrack(tl([track]), 0, 415)).toBeNull();
  });
});

describe("resolveVisibleOnTrack: blanks, graphics, hidden tracks", () => {
  it("returns null over a leading blank, then resolves the clip after it", () => {
    const track = videoTrack("V2", [
      { kind: "blank", length: 210 },
      clip("p2", "/m/c.mp4", 0, 179),
    ]);
    expect(resolveVisibleOnTrack(tl([track]), 0, 100)).toBeNull(); // inside the blank
    const v = resolveVisibleOnTrack(tl([track]), 0, 210); // first frame after blank
    expect(v?.uuid).toBe("p2");
    expect(v?.sourceFrame).toBe(0);
  });

  it("skips a graphic (Remotion) clip — drawn by the overlay, not the footage stage", () => {
    const track = videoTrack("GFX", [
      { kind: "clip", id: "g", resource: "/p/.vean/cache/remotion/x.mov", in: 0, out: 99 },
    ]);
    expect(resolveVisibleOnTrack(tl([track]), 0, 10)).toBeNull();
  });

  it("skips a clip labelled graphic:", () => {
    const track = videoTrack("GFX", [
      {
        kind: "clip",
        id: "g",
        resource: "/p/renders/chat.mov",
        in: 0,
        out: 99,
        label: "graphic:chat",
      },
    ]);
    expect(resolveVisibleOnTrack(tl([track]), 0, 10)).toBeNull();
  });

  it("returns null for a hidden track", () => {
    const track = videoTrack("V1", [clip("p0", "/m/a.mp4", 0, 99)], true);
    expect(resolveVisibleOnTrack(tl([track]), 0, 10)).toBeNull();
  });
});

describe("resolveVisibleSet: topmost covering footage clip wins (z-order)", () => {
  it("prefers the higher video-track index when both cover the frame", () => {
    const v1 = videoTrack("V1", [clip("low", "/m/low.mp4", 0, 299)]);
    const v2 = videoTrack("V2", [clip("high", "/m/high.mp4", 0, 299)]);
    const v = resolveVisibleSet(tl([v1, v2]), 50);
    expect(v?.uuid).toBe("high");
    expect(v?.trackIndex).toBe(1);
  });

  it("falls through to the lower track when the top track is a blank/graphic at the frame", () => {
    // V2 has a graphic overlay over [0,99] then nothing; V1 has footage throughout.
    const v1 = videoTrack("V1", [clip("foot", "/m/foot.mp4", 0, 299)]);
    const v2 = videoTrack("V2", [
      { kind: "clip", id: "g", resource: "/p/.vean/cache/remotion/x.mov", in: 0, out: 99 },
    ]);
    const v = resolveVisibleSet(tl([v1, v2]), 50); // graphic on top is skipped
    expect(v?.uuid).toBe("foot");
    expect(v?.trackIndex).toBe(0);
  });

  it("returns null when no track has footage at the frame", () => {
    const v1 = videoTrack("V1", [{ kind: "blank", length: 100 }]);
    expect(resolveVisibleSet(tl([v1]), 50)).toBeNull();
  });
});

describe("resolveVisibleSet: liveness — a trim changes the resolved source frame, no save", () => {
  it("re-resolves against a mutated IR (the HMR contract)", () => {
    const before = tl([videoTrack("V1", [clip("p0", "/m/a.mp4", 107, 221)])]);
    // At frame 50: source 157.
    expect(resolveVisibleSet(before, 50)?.sourceFrame).toBe(157);
    // Simulate a trim that moves the in-point to 120 (the edit algebra would
    // produce a new IR; here we just hand the walk the new IR — proving the resolve
    // is a pure function of (ir, frame), the basis of the no-save loop).
    const after = tl([videoTrack("V1", [clip("p0", "/m/a.mp4", 120, 221)])]);
    expect(resolveVisibleSet(after, 50)?.sourceFrame).toBe(170); // 120 + 50
  });
});
