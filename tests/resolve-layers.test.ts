import { describe, expect, it } from "vitest";
// The Tier-1 LAYER resolver — the multi-track, dissolve-aware, fade-resolved
// read-side mirror of serialize:walkTrack evaluated at a frame
// (DESIGN-LIVE-PREVIEW §4, §6 Tier 1, §7, §9 step 4). The viewer is a separate
// Vite app excluded from the root tsconfig, but resolveLayers.ts is a pure ESM
// module (it imports only the keyframe resolver, also pure), so vitest exercises
// it directly — the golden unit gate for the Tier-1 compositor's INPUT.
//
// The load-bearing claim these tests pin: the read-side dissolve placement matches
// `melt`'s OVERLAP geometry EXACTLY (the dissolve trims `d` frames off each
// neighbour and itself occupies `d` frames), so the browser composite lands the
// same frames `melt` would export. Drift here desyncs preview from export.
import {
  type DissolveLayer,
  type FootageLayer,
  type SolidLayer,
  resolveLayerOnTrack,
  resolveLayers,
} from "../viewer/src/resolveLayers";
import type { ClipItem, Timeline, Track } from "../viewer/src/types";

const FPS: [number, number] = [30, 1];

function clip(
  id: string,
  resource: string,
  inF: number,
  outF: number,
  extra: Partial<ClipItem> = {},
): ClipItem {
  return { kind: "clip", id, resource, in: inF, out: outF, ...extra };
}

function colorClip(id: string, color: string, len: number): ClipItem {
  return { kind: "clip", id, resource: color, service: "color", in: 0, out: len - 1, length: len };
}

function videoTrack(id: string, items: Track["items"], hidden = false): Track {
  return { kind: "video", id, items, ...(hidden ? { hidden: true } : {}) };
}

function tl(video: Track[], transitions: Timeline["transitions"] = []): Timeline {
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
    transitions,
    title: "t",
  };
}

describe("resolveLayerOnTrack: dissolve OVERLAP geometry mirrors serialize:walkTrack", () => {
  // The Move-5 demo V1: base-a(color, len63) · dissolve(18) · base-b(color, len63).
  // melt geometry (walkTrack trims d off each neighbour): base-a solo [0,44],
  // dissolve [45,62], base-b solo [63,107] — total 108. This is the geometry the
  // GATE-MOVE5 f45/f80 melt pixels were proven against.
  const TEAL = "#FF0E5C63";
  const INDIGO = "#FF241A52";
  const track = videoTrack("V1", [
    colorClip("base-a", TEAL, 63),
    { kind: "dissolve", frames: 18, luma: "luma" },
    colorClip("base-b", INDIGO, 63),
  ]);

  it("resolves the teal solo segment up to the dissolve start", () => {
    for (const f of [0, 20, 44]) {
      const l = resolveLayerOnTrack(track, 0, f) as SolidLayer;
      expect(l?.kind).toBe("solid");
      expect(l.color).toBe(TEAL);
      expect(l.opacity).toBe(1);
    }
  });

  it("resolves a DISSOLVE crossfade across [45,62] with progress 0→1", () => {
    const at45 = resolveLayerOnTrack(track, 0, 45) as DissolveLayer;
    expect(at45?.kind).toBe("dissolve");
    expect((at45.from as SolidLayer).color).toBe(TEAL);
    expect((at45.to as SolidLayer).color).toBe(INDIGO);
    expect(at45.progress).toBe(0); // first dissolve frame is all `from`
    expect(at45.service).toBe("luma");

    const at62 = resolveLayerOnTrack(track, 0, 62) as DissolveLayer;
    expect(at62?.kind).toBe("dissolve");
    expect(at62.progress).toBe(1); // last dissolve frame is all `to`

    const mid = resolveLayerOnTrack(track, 0, 53) as DissolveLayer; // (53-45)/(18-1)
    expect(mid.progress).toBeCloseTo(8 / 17, 6);
  });

  it("resolves the indigo solo segment after the dissolve", () => {
    for (const f of [63, 80, 107]) {
      const l = resolveLayerOnTrack(track, 0, f) as SolidLayer;
      expect(l?.kind).toBe("solid");
      expect(l.color).toBe(INDIGO);
    }
  });

  it("returns null past the (overlap-collapsed) track end at frame 108", () => {
    expect(resolveLayerOnTrack(track, 0, 108)).toBeNull();
  });
});

describe("resolveLayerOnTrack: footage source-frame math + fade opacity", () => {
  it("resolves a footage clip's source frame (in + (frame - start))", () => {
    const track = videoTrack("V1", [clip("p0", "/m/a.mp4", 107, 221)]);
    const l = resolveLayerOnTrack(track, 0, 50) as FootageLayer;
    expect(l.kind).toBe("footage");
    expect(l.uuid).toBe("p0");
    expect(l.sourceFrame).toBe(157); // 107 + 50
    expect(l.opacity).toBe(1);
  });

  it("ramps opacity 0→1 over a fadeIn (vean.fadeIn sentinel, linear 0=0;n-1=1)", () => {
    const track = videoTrack("V1", [
      clip("p0", "/m/a.mp4", 0, 59, {
        filters: [{ service: "vean.fadeIn", properties: { frames: 11 } }],
      }),
    ]);
    expect((resolveLayerOnTrack(track, 0, 0) as FootageLayer).opacity).toBeCloseTo(0, 6);
    expect((resolveLayerOnTrack(track, 0, 5) as FootageLayer).opacity).toBeCloseTo(0.5, 6); // 5/10
    expect((resolveLayerOnTrack(track, 0, 10) as FootageLayer).opacity).toBeCloseTo(1, 6);
    expect((resolveLayerOnTrack(track, 0, 30) as FootageLayer).opacity).toBe(1); // past the fade
  });

  it("ramps opacity 1→0 over a fadeOut at the tail (len-n=1;len-1=0)", () => {
    const track = videoTrack("V1", [
      clip("p0", "/m/a.mp4", 0, 59, {
        filters: [{ service: "vean.fadeOut", properties: { frames: 11 } }],
      }),
    ]); // len = 60
    expect((resolveLayerOnTrack(track, 0, 49) as FootageLayer).opacity).toBeCloseTo(1, 6); // 60-11
    expect((resolveLayerOnTrack(track, 0, 54) as FootageLayer).opacity).toBeCloseTo(0.5, 6);
    expect((resolveLayerOnTrack(track, 0, 59) as FootageLayer).opacity).toBeCloseTo(0, 6); // last
  });

  it("flags a clip with an unmapped (blur/frei0r) filter as approximate", () => {
    const track = videoTrack("V1", [
      clip("p0", "/m/a.mp4", 0, 59, {
        filters: [{ service: "frei0r.gaussianblur", properties: { sigma: "4" } }],
      }),
    ]);
    const l = resolveLayerOnTrack(track, 0, 10) as FootageLayer;
    expect(l.approximate).toBe(true);
  });
});

describe("resolveLayers: z-order stack + Remotion-overlay track exclusion", () => {
  it("orders layers bottom-up by track index (lower index = lower z)", () => {
    const v1 = videoTrack("V1", [clip("low", "/m/low.mp4", 0, 299)]);
    const v2 = videoTrack("V2", [clip("mid", "/m/mid.mp4", 0, 299)]);
    const { layers } = resolveLayers(tl([v1, v2]), 50);
    expect(layers.map((l) => l.trackIndex)).toEqual([0, 1]); // bottom-up
    expect((layers[0] as FootageLayer).uuid).toBe("low");
    expect((layers[1] as FootageLayer).uuid).toBe("mid");
  });

  it("EXCLUDES the bTrack of a qtblend ONLY when the covering clip is a GRAPHIC clip", () => {
    // A qtblend over-composite whose bTrack clip IS a graphic (Remotion) overlay —
    // a `graphic:`-labelled clip the @remotion/player redraws on top. V2 is excluded
    // from the footage compositor (DESIGN §4, §7: two compositors, one editor track).
    const v1 = videoTrack("V1", [colorClip("base", "#FF0E5C63", 90)]);
    const v2 = videoTrack("V2", [
      clip("gfx", "/cache/remotion/lower-third.mov", 0, 89, { label: "graphic:lower-third" }),
    ]);
    const qtblend = { service: "qtblend", aTrack: 1, bTrack: 2, in: 0, out: 89, properties: {} };
    const { layers } = resolveLayers(tl([v1, v2], [qtblend]), 45);
    expect(layers).toHaveLength(1); // only the footage base — the graphic is Player-owned
    expect((layers[0] as SolidLayer).color).toBe("#FF0E5C63");
    expect(layers[0]?.trackIndex).toBe(0);
  });

  it("COMPOSITES a plain VIDEO-FILE overlay on a qtblend bTrack (not a graphic clip)", () => {
    // The `projects/retire` shape: V1 footage base + V2 = `chat.mov`, a baked carlo
    // overlay that is a plain ProRes video file (NO `graphic:` label, NOT under
    // cache/remotion/). The @remotion/player NEVER renders it — so the FOOTAGE
    // compositor must decode + composite it, exactly as `melt` over-composites it on
    // export. Excluding it (the prior structural-only rule) dropped the overlay
    // entirely. This is the load-bearing correction verified on `projects/retire`.
    const v1 = videoTrack("V1", [clip("base", "/m/footage.mp4", 0, 89)]);
    const v2 = videoTrack("V2", [clip("chat", "/projects/retire/renders/chat.mov", 0, 89)]);
    const qtblend = { service: "qtblend", aTrack: 1, bTrack: 2, in: 0, out: 89, properties: {} };
    const { layers } = resolveLayers(tl([v1, v2], [qtblend]), 45);
    expect(layers).toHaveLength(2); // footage base + the composited video-file overlay
    expect((layers[0] as FootageLayer).uuid).toBe("base");
    expect((layers[1] as FootageLayer).uuid).toBe("chat"); // V2 composited, ON TOP
    expect(layers[1]?.trackIndex).toBe(1);
  });

  it("hidden tracks contribute nothing", () => {
    const v1 = videoTrack("V1", [clip("p0", "/m/a.mp4", 0, 99)], true);
    expect(resolveLayers(tl([v1]), 10).layers).toHaveLength(0);
  });
});

describe("resolveLayers: liveness — a mutated IR re-resolves with no save (the HMR contract)", () => {
  it("is a pure function of (ir, frame): a trim changes the resolved layer", () => {
    // Before: f45 sits in the teal solo region. Shorten base-a so f45 falls past it.
    const before = tl([
      videoTrack("V1", [colorClip("base-a", "#FF0E5C63", 63), { kind: "blank", length: 45 }]),
    ]);
    expect((resolveLayers(before, 40).layers[0] as SolidLayer)?.color).toBe("#FF0E5C63");
    // A trim that shrinks base-a to 30 frames (the edit algebra produces a new IR;
    // here we hand the resolver the new IR — proving it's pure, the no-save basis).
    const after = tl([
      videoTrack("V1", [colorClip("base-a", "#FF0E5C63", 30), { kind: "blank", length: 78 }]),
    ]);
    expect(resolveLayers(after, 40).layers).toHaveLength(0); // f40 now over the blank
  });
});
