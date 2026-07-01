// graphic-overlay-fixture — guards the committed live-Player fixture
// (corpus/demo/graphic-overlay.mlt) WITHOUT a browser. The end-to-end Player proof
// lives in `bun run verify:live-overlay` (drive + agent-browser); this test pins the
// committed timeline's STRUCTURE + determinism + the LOAD-BEARING property the whole
// live-overlay path turns on — `isGraphicClip` returns true — so a fixture regression
// is caught in CI without melt/remotion/a browser.
//
// The contrast with demo-fixture.test.ts is the point: demo.mlt's overlay is a baked
// video FILE (`corpus/demo/lower-third.mov`) that `isGraphicClip` returns FALSE for
// (the footage compositor decodes it); THIS fixture's overlay lives in the Remotion
// render cache (`.vean/cache/remotion/…`) so `isGraphicClip` returns TRUE and the live
// `@remotion/player` overlay draws it. Two fixtures, the two compositing paths.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromMlt } from "../src/ir/parse";
import { toMlt } from "../src/ir/serialize";
// The VIEWER's own graphic-clip predicate — the exact function App.resolveOverlayAt +
// resolveLayers route on. Importing it (not a local re-implementation) means this
// test fails if the viewer's contract drifts from the fixture.
import { isGraphicClip } from "../viewer/src/types";
import type { ClipItem } from "../viewer/src/types";

const FIXTURE = join(import.meta.dirname, "..", "corpus", "demo", "graphic-overlay.mlt");
const DEMO = join(import.meta.dirname, "..", "corpus", "demo", "demo.mlt");
const xml = readFileSync(FIXTURE, "utf8");

describe("corpus/demo/graphic-overlay.mlt fixture", () => {
  const tl = fromMlt(xml);

  it("is VERTICAL 1080x1920 @ integer 30fps (Move-5 integer-fps invariant)", () => {
    expect(tl.profile.width).toBe(1080);
    expect(tl.profile.height).toBe(1920);
    expect(tl.profile.fps).toEqual([30, 1]);
  });

  it("has a footage base track and a GFX overlay track (≥2 video tracks)", () => {
    expect(tl.tracks.video.length).toBeGreaterThanOrEqual(2);
  });

  it("base footage CROSS-FADES (a dissolve → moving footage under the overlay)", () => {
    const base = tl.tracks.video[0];
    expect(base?.items.some((i) => i.kind === "dissolve")).toBe(true);
  });

  it("places exactly one 90-frame overlay clip on the upper (bottom-of-array) GFX track", () => {
    const gfx = tl.tracks.video.at(-1);
    const items = gfx?.items.filter((i) => i.kind === "clip") ?? [];
    expect(items.length).toBe(1);
    const overlay = items[0] as ClipItem;
    expect(overlay.out - overlay.in + 1).toBe(90);
  });

  it("the overlay clip is a GRAPHIC clip (isGraphicClip true) via its cache/remotion resource", () => {
    const overlay = tl.tracks.video.at(-1)?.items.find((i) => i.kind === "clip") as ClipItem;
    expect(/cache\/remotion\//.test(overlay.resource)).toBe(true);
    expect(isGraphicClip(overlay)).toBe(true);
  });

  it("relies on the RESOURCE, not the label — `label` does not round-trip yet isGraphicClip holds", () => {
    // The builder set `label: "graphic:lower-third"`, but `src/ir/serialize.ts` does
    // not emit `label`, so the parsed clip has none. This is the exact gap demo.mlt
    // fell into; the fixture survives it by keying on the cache/remotion resource.
    const overlay = tl.tracks.video.at(-1)?.items.find((i) => i.kind === "clip") as ClipItem;
    expect(overlay.label).toBeUndefined();
    expect(isGraphicClip(overlay)).toBe(true); // still graphic, on the resource alone
  });

  it("composites the overlay over the footage with a qtblend field transition (a=1 base, b=2 gfx)", () => {
    const qt = tl.transitions.find((t) => t.service === "qtblend");
    expect(qt).toBeDefined();
    if (!qt) return;
    expect(qt.aTrack).toBe(1);
    expect(qt.bTrack).toBe(2);
    expect(qt.in).toBe(0);
    expect(qt.out).toBe(89);
  });

  it("round-trips byte-identically (committed fixture is a determinism fixpoint)", () => {
    expect(toMlt(tl)).toBe(xml);
    expect(toMlt(fromMlt(toMlt(tl)))).toBe(xml);
  });

  it("is the A/B counterpart of demo.mlt: its overlay is graphic, demo's is footage", () => {
    // The whole reason this fixture exists: demo.mlt exercises the FOOTAGE-composite
    // path (overlay isGraphicClip false), this one the live PLAYER path (true).
    const demoOverlay = fromMlt(readFileSync(DEMO, "utf8"))
      .tracks.video.at(-1)
      ?.items.find((i) => i.kind === "clip") as ClipItem;
    const thisOverlay = tl.tracks.video.at(-1)?.items.find((i) => i.kind === "clip") as ClipItem;
    expect(isGraphicClip(demoOverlay)).toBe(false); // demo → footage compositor
    expect(isGraphicClip(thisOverlay)).toBe(true); // this → @remotion/player overlay
  });
});
