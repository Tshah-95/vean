// Golden tests for the navigation QUERIES (src/query/): resolveValueAtFrame
// ("go-to-definition for video") and findReferences ("find all references"). Both
// are PURE over the IR, so they're golden-tested against the committed corpus
// fixtures (real .mlt files) — the brightness fade, the animated rect/level, the
// field transition, and the source/property/adjacency reference sets.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAnim, valueAtFrame } from "../src/ir/keyframes";
import type { ColorValue, NumberValue, RectValue } from "../src/ir/keyframes";
import { fromMlt } from "../src/ir/parse";
import { findReferences } from "../src/query/references";
import { resolveValueAtFrame } from "../src/query/resolve";

const CORPUS = join(import.meta.dirname, "..", "corpus");
const multitrack = () => fromMlt(readFileSync(join(CORPUS, "vean-multitrack.mlt"), "utf8"));
const keyframesDoc = () => fromMlt(readFileSync(join(CORPUS, "vean-keyframes.mlt"), "utf8"));

// ═══════════════════════════════════════════════════════════════════════════
// valueAtFrame — the keyframe-model evaluator (the resolver's engine)
// ═══════════════════════════════════════════════════════════════════════════
describe("valueAtFrame — interpolation across the grammar", () => {
  it("linear interpolation between two number keyframes", () => {
    const m = parseAnim("0=0;10=1");
    expect((valueAtFrame(m, 0) as NumberValue).value).toBe(0);
    expect((valueAtFrame(m, 5) as NumberValue).value).toBeCloseTo(0.5, 6);
    expect((valueAtFrame(m, 10) as NumberValue).value).toBe(1);
  });

  it("discrete (|) HOLDS the left value until the next keyframe", () => {
    const m = parseAnim("0=0;20|=0.6;40=1");
    // 20|=0.6 holds 0.6 across [20,40) — frame 30 is still 0.6, not interpolated.
    expect((valueAtFrame(m, 30) as NumberValue).value).toBe(0.6);
    expect((valueAtFrame(m, 40) as NumberValue).value).toBe(1);
  });

  it("smooth (~) uses a Catmull-Rom curve (not a straight line)", () => {
    const m = parseAnim("0=0;20~=1;40=0");
    // At the midpoint of a smooth segment the value departs from the linear 0.5.
    const mid = (valueAtFrame(m, 30) as NumberValue).value;
    expect(mid).not.toBeCloseTo(0.5, 2);
  });

  it("clamps to the first/last keyframe outside the range", () => {
    const m = parseAnim("10=0.2;50=0.9");
    expect((valueAtFrame(m, 0) as NumberValue).value).toBe(0.2); // before first
    expect((valueAtFrame(m, 99) as NumberValue).value).toBe(0.9); // after last
  });

  it("interpolates a rect component-wise", () => {
    const m = parseAnim("0=0 0 100 100 1;10=100 50 200 200 0");
    const r = valueAtFrame(m, 5) as RectValue;
    expect(r.type).toBe("rect");
    expect(r.x).toBeCloseTo(50, 6);
    expect(r.y).toBeCloseTo(25, 6);
    expect(r.w).toBeCloseTo(150, 6);
    expect(r.opacity).toBeCloseTo(0.5, 6);
  });

  it("interpolates a color per channel (rounded to 0..255)", () => {
    const m = parseAnim("0=#000000;10=#ffffff");
    const c = valueAtFrame(m, 5) as ColorValue;
    expect(c.type).toBe("color");
    expect(c.r).toBe(128); // round(255*0.5)
    expect(c.g).toBe(128);
    expect(c.b).toBe(128);
  });

  it("resolves a negative/relative keyframe against length", () => {
    const m = parseAnim("0=0;-1=1"); // -1 = length-1
    // With length 100, -1 anchors at frame 99; frame 50 is halfway.
    expect((valueAtFrame(m, 50, { length: 100 }) as NumberValue).value).toBeCloseTo(0.505, 3);
    expect((valueAtFrame(m, 99, { length: 100 }) as NumberValue).value).toBe(1);
  });

  it("a static model returns its single value at any frame", () => {
    const m = parseAnim("0.75");
    expect((valueAtFrame(m, 999) as NumberValue).value).toBe(0.75);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveValueAtFrame — the scope-resolved effective value + path
// ═══════════════════════════════════════════════════════════════════════════
describe("resolveValueAtFrame — clip fade sentinel (the hot path)", () => {
  it("the V1 fade-in ramps ~0 at frame 0 to ~1 by the fade end (vean-multitrack)", () => {
    const tl = multitrack();
    // clip-0 (black) carries vean.fadeIn { frames: 12 }, playing from timeline 0.
    const at0 = resolveValueAtFrame(tl, { scope: "fade", clip: "clip-0", direction: "in" }, 0);
    expect(at0.scalar).toBe(0); // black at the head
    expect(at0.live).toBe(true);
    expect(at0.path.find((h) => h.produced)?.scope).toBe("fade");

    const atEnd = resolveValueAtFrame(tl, { scope: "fade", clip: "clip-0", direction: "in" }, 11);
    expect(atEnd.scalar).toBe(1); // fully up by the fade end (frame 11 = frames-1)

    const mid = resolveValueAtFrame(tl, { scope: "fade", clip: "clip-0", direction: "in" }, 5);
    expect(mid.scalar).toBeGreaterThan(0);
    expect(mid.scalar).toBeLessThan(1);
  });

  it("the V1 gold clip fade-OUT ramps 1 → 0 over its RENDERED tail (vean-multitrack)", () => {
    const tl = multitrack();
    // clip-1 (gold) carries vean.fadeOut { frames: 15 }. Its SOURCE playtime is 60,
    // but a 20-frame dissolve eats its head, so it RENDERS 40 frames on the timeline
    // at [45, 84] (verified against melt: the gold fades 1→0 over timeline 70..84,
    // and the whole timeline is 90 frames — frames past 84 do not exist for it).
    // The resolver must anchor the fade on the RENDERED span, not the source
    // playtime; querying the inflated source domain (tl 90..104) is the masked
    // defect this test now guards against (see GATE-MOVE1B §finding-c).
    const beforeFade = resolveValueAtFrame(
      tl,
      { scope: "fade", clip: "clip-1", direction: "out" },
      70,
    );
    expect(beforeFade.scalar).toBe(1); // still full at the rendered tail's start
    expect(beforeFade.live).toBe(true);

    // Midway through the rendered fade (tl 77 ≈ local 32 of the 40-frame render):
    // melt paints this as a partial fade, so the resolver must read between 0 and 1.
    const mid = resolveValueAtFrame(tl, { scope: "fade", clip: "clip-1", direction: "out" }, 77);
    expect(mid.scalar).toBeGreaterThan(0);
    expect(mid.scalar).toBeLessThan(1);

    // Frame 84 is the gold clip's RENDERED last frame (rendered start 45 + span 40 - 1).
    const tail = resolveValueAtFrame(tl, { scope: "fade", clip: "clip-1", direction: "out" }, 84);
    expect(tail.scalar).toBe(0);
    expect(tail.live).toBe(true);

    // Past the rendered end the clip is NOT live (frames 90..104 do not exist for it
    // in the 90-frame timeline — the old code wrongly reported these as live with a
    // mid-fade level, anchoring the fade on the inflated source domain).
    const past = resolveValueAtFrame(tl, { scope: "fade", clip: "clip-1", direction: "out" }, 95);
    expect(past.live).toBe(false);
    expect(past.scalar).toBe(0);
  });

  it("a missing fade reports notFound without throwing", () => {
    const tl = multitrack();
    const r = resolveValueAtFrame(tl, { scope: "fade", clip: "clip-3", direction: "in" }, 20);
    expect(r.value).toBeNull();
    expect(r.notFound).toMatch(/no fade/);
  });
});

describe("resolveValueAtFrame — clip escape-hatch animated filters (vean-keyframes)", () => {
  it("brightness.level resolves the marked ramp (linear → discrete hold → smooth)", () => {
    const tl = keyframesDoc();
    const t = (f: number) =>
      resolveValueAtFrame(
        tl,
        { scope: "clip", clip: "clip-0", service: "brightness", property: "level" },
        f,
      ).scalar;
    expect(t(0)).toBeCloseTo(0.2, 6); // first keyframe
    expect(t(10)).toBeCloseTo(0.4, 6); // linear 0.2→0.6 midpoint
    expect(t(30)).toBeCloseTo(0.6, 6); // 20|=0.6 holds across [20,40)
    expect(t(40)).toBeCloseTo(1, 6); // keyframe
    expect(t(59)).toBeCloseTo(0.5, 6); // last keyframe (clamp)
  });

  it("affine transition.rect resolves component-wise (the smooth mid keyframe)", () => {
    const tl = keyframesDoc();
    const r = resolveValueAtFrame(
      tl,
      { scope: "clip", clip: "clip-0", service: "affine", property: "transition.rect" },
      30,
    );
    const rect = r.value as RectValue;
    expect(rect.type).toBe("rect");
    // 30~=200 100 1520 880 0.8 is the exact mid keyframe.
    expect(rect.x).toBe(200);
    expect(rect.w).toBe(1520);
    expect(rect.opacity).toBeCloseTo(0.8, 6);
    expect(r.path.find((h) => h.produced)?.scope).toBe("clip");
  });

  it("the resolution path names each scope it walked, innermost-first", () => {
    const tl = keyframesDoc();
    // A target whose filter exists → produced at the clip scope immediately.
    const r = resolveValueAtFrame(
      tl,
      { scope: "clip", clip: "clip-0", service: "brightness", property: "level" },
      0,
    );
    expect(r.path[0]?.scope).toBe("clip");
    expect(r.path[0]?.produced).toBe(true);
  });

  it("an unknown filter property walks the full chain and produces nothing", () => {
    const tl = keyframesDoc();
    const r = resolveValueAtFrame(
      tl,
      { scope: "clip", clip: "clip-0", service: "nope", property: "missing" },
      0,
    );
    expect(r.value).toBeNull();
    // The chain was walked + named: clip → track → tractor (→ transition).
    expect(r.path.map((h) => h.scope)).toEqual(["clip", "track", "tractor"]);
    expect(r.path.every((h) => !h.produced)).toBe(true);
  });
});

describe("resolveValueAtFrame — field transition scope (vean-multitrack)", () => {
  it("resolves a transition property and flags live inside its window", () => {
    const tl = multitrack();
    // The qtblend transition spans timeline [15, 64] with compositing=0.
    const inside = resolveValueAtFrame(
      tl,
      { scope: "transition", index: 0, property: "compositing" },
      30,
    );
    expect((inside.value as NumberValue).value).toBe(0);
    expect(inside.live).toBe(true);
    expect(inside.path.find((h) => h.produced)?.scope).toBe("transition");

    const outside = resolveValueAtFrame(
      tl,
      { scope: "transition", index: 0, property: "compositing" },
      80,
    );
    expect(outside.live).toBe(false); // past the transition window
  });

  it("a missing transition / property reports notFound", () => {
    const tl = multitrack();
    expect(
      resolveValueAtFrame(tl, { scope: "transition", index: 9, property: "x" }, 0).notFound,
    ).toBeDefined();
    expect(
      resolveValueAtFrame(tl, { scope: "transition", index: 0, property: "nope" }, 30).notFound,
    ).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// findReferences — source / property / clip-adjacency
// ═══════════════════════════════════════════════════════════════════════════
describe("findReferences — by source", () => {
  it("finds every clip using a media path", () => {
    const tl = multitrack();
    const toneClip = tl.tracks.audio[0]?.items.find((it) => it.kind === "clip");
    const resource = (toneClip as { resource: string }).resource;
    const r = findReferences(tl, { kind: "source", resource });
    expect(r.kind).toBe("source");
    if (r.kind !== "source") throw new Error("kind");
    expect(r.clips).toHaveLength(1);
    expect(r.clips[0]?.uuid).toBe("clip-5");
    expect(r.clips[0]?.track).toBe("playlist2");
  });

  it("finds multiple clips sharing one source", () => {
    const tl = multitrack();
    // clip-0 and clip-1 are both #FF000000? No — black + gold differ. Use the gold.
    const r = findReferences(tl, { kind: "source", resource: "#FFFFD700" });
    if (r.kind !== "source") throw new Error("kind");
    expect(r.clips.map((c) => c.uuid)).toContain("clip-1");
  });
});

describe("findReferences — by property", () => {
  it("finds readers/writers of `frames` (the fade sentinels)", () => {
    const tl = multitrack();
    const r = findReferences(tl, { kind: "property", property: "frames" });
    if (r.kind !== "property") throw new Error("kind");
    const services = r.sites.map((s) =>
      s.owner.kind === "clip-filter" ? s.owner.service : s.owner.kind,
    );
    expect(services).toContain("vean.fadeIn");
    expect(services).toContain("vean.fadeOut");
    // Fade `frames` is a static integer, not an animation string.
    expect(r.sites.every((s) => s.animated === false)).toBe(true);
  });

  it("flags an animated writer (the keyframes corpus brightness.level)", () => {
    const tl = keyframesDoc();
    const r = findReferences(tl, { kind: "property", property: "level" });
    if (r.kind !== "property") throw new Error("kind");
    expect(r.sites.length).toBeGreaterThan(0);
    expect(r.sites.some((s) => s.animated)).toBe(true);
  });

  it("finds a transition property writer", () => {
    const tl = multitrack();
    const r = findReferences(tl, { kind: "property", property: "compositing" });
    if (r.kind !== "property") throw new Error("kind");
    expect(r.sites.some((s) => s.owner.kind === "transition")).toBe(true);
  });
});

describe("findReferences — clip adjacency / ripple set", () => {
  it("single-track: only the same-track later clip is in the set", () => {
    const tl = multitrack();
    const r = findReferences(tl, { kind: "clip", clip: "clip-0" });
    if (r.kind !== "clip") throw new Error("kind");
    expect(r.site?.uuid).toBe("clip-0");
    expect(r.affected.map((a) => a.uuid)).toEqual(["clip-1"]);
    expect(r.affected[0]?.relation).toBe("same-track-after");
  });

  it("ripple-all: cross-track content at/after the seam joins the set", () => {
    const tl = multitrack();
    const r = findReferences(tl, { kind: "clip", clip: "clip-0", ripple: true });
    if (r.kind !== "clip") throw new Error("kind");
    const ids = r.affected.map((a) => a.uuid).sort();
    // clip-1 (same track) + the cross-track overlay (clip-3) + the audio (clip-5).
    expect(ids).toEqual(["clip-1", "clip-3", "clip-5"]);
    const cross = r.affected.filter((a) => a.relation === "cross-track-after");
    expect(cross.map((a) => a.uuid).sort()).toEqual(["clip-3", "clip-5"]);
  });

  it("a missing clip reports notFound, no throw", () => {
    const tl = multitrack();
    const r = findReferences(tl, { kind: "clip", clip: "ghost" });
    if (r.kind !== "clip") throw new Error("kind");
    expect(r.notFound).toMatch(/not found/);
    expect(r.affected).toEqual([]);
  });
});
