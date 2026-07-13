import { describe, expect, it } from "vitest";
import { resolveLayers } from "../viewer/src/resolveLayers";
import type { Timeline } from "../viewer/src/types";

function timelineWith(rect: string): Timeline {
  return {
    title: "geometry",
    profile: {
      description: "vertical",
      width: 1080,
      height: 1920,
      fps: [30, 1],
      displayAspectNum: 9,
      displayAspectDen: 16,
    },
    tracks: {
      video: [
        {
          kind: "video",
          id: "v1",
          items: [
            {
              kind: "clip",
              id: "subject",
              resource: "red",
              service: "color",
              in: 0,
              out: 29,
            },
          ],
        },
      ],
      audio: [],
    },
    transitions: [
      {
        service: "qtblend",
        aTrack: 0,
        bTrack: 1,
        in: 0,
        out: 29,
        properties: { rect, compositing: 0, distort: 0 },
      },
    ],
  };
}

describe("viewer qtblend/affine geometry", () => {
  it("resolves keyframed qtblend.rect at the exact playhead frame", () => {
    const tl = timelineWith("0=0 0 1080 1920 1;10=540 192 432 1536 0.5");
    const start = resolveLayers(tl, 0).layers[0];
    const middle = resolveLayers(tl, 5).layers[0];
    const end = resolveLayers(tl, 10).layers[0];
    expect(start?.geometry).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(middle?.geometry).toEqual({ x: 0.25, y: 0.05, width: 0.7, height: 0.9 });
    expect(middle?.opacity).toBeCloseTo(0.75);
    expect(end?.geometry).toEqual({ x: 0.5, y: 0.1, width: 0.4, height: 0.8 });
    expect(end?.opacity).toBeCloseTo(0.5);
    expect(resolveLayers(tl, 5).hasApproximate).toBe(false);
  });

  it("resolves affine transition.rect when no field qtblend supplies geometry", () => {
    const tl = timelineWith("0=0 0 1080 1920 1;10=540 192 432 1536 0.5");
    tl.transitions = [];
    const item = tl.tracks.video[0]?.items[0];
    if (!item || item.kind !== "clip") throw new Error("missing clip");
    item.filters = [
      {
        service: "affine",
        properties: { "transition.rect": "0=0 0 1080 1920 1;10=540 192 432 1536 0.5" },
      },
    ];
    const layer = resolveLayers(tl, 10).layers[0];
    expect(layer?.geometry).toEqual({ x: 0.5, y: 0.1, width: 0.4, height: 0.8 });
    expect(layer?.opacity).toBeCloseTo(0.5);
    expect(resolveLayers(tl, 10).hasApproximate).toBe(false);
  });

  it("preserves percentage rect units", () => {
    const layer = resolveLayers(timelineWith("0=0% 0% 100% 100% 1;10=50% 10% 40% 80% 1"), 10)
      .layers[0];
    expect(layer?.geometry).toEqual({ x: 0.5, y: 0.1, width: 0.4, height: 0.8 });
  });
});
