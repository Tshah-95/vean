import { afterEach, describe, expect, test } from "vitest";
import { GlCompositor } from "../src/compositor/glCompositor";
import type { SolidLayer } from "../src/resolveLayers";

const compositors: GlCompositor[] = [];

afterEach(() => {
  for (const compositor of compositors.splice(0)) compositor.dispose();
});

describe("WebGL qtblend/affine geometry", () => {
  test("draws a resolved layer only inside its normalized destination slot", () => {
    const canvas = document.createElement("canvas");
    const compositor = new GlCompositor(canvas);
    compositors.push(compositor);
    compositor.resize(100, 100);

    const layer: SolidLayer = {
      kind: "solid",
      uuid: "subject",
      color: "#ff0000",
      trackIndex: 0,
      opacity: 1,
      approximate: false,
      geometry: { x: 0.5, y: 0.1, width: 0.4, height: 0.8 },
    };
    compositor.render([layer], () => null);

    // Black canvas outside the destination; red subject inside it.
    expect(compositor.readPixel(10, 50)).toEqual([0, 0, 0, 255]);
    expect(compositor.readPixel(70, 50)).toEqual([255, 0, 0, 255]);
    expect(compositor.readPixel(70, 5)).toEqual([0, 0, 0, 255]);
  });
});
