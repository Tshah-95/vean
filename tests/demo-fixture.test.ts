// demo-fixture — guards the committed Move-5 demo (corpus/demo/demo.mlt) WITHOUT
// rendering. The actual producer→composite→export render proof lives in the
// real gate `bun run verify:move5` (it regenerates the gitignored overlay); this
// test only asserts the committed timeline's STRUCTURE + determinism so a fixture
// regression is caught in CI without melt/remotion/ffmpeg.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fromMlt } from "../src/ir/parse";
import { toMlt } from "../src/ir/serialize";

const DEMO_MLT = join(import.meta.dirname, "..", "corpus", "demo", "demo.mlt");
const xml = readFileSync(DEMO_MLT, "utf8");

describe("corpus/demo/demo.mlt fixture", () => {
  const tl = fromMlt(xml);

  it("is VERTICAL 1080x1920 @ integer 30fps (Move-5 integer-fps invariant)", () => {
    expect(tl.profile.width).toBe(1080);
    expect(tl.profile.height).toBe(1920);
    expect(tl.profile.fps).toEqual([30, 1]);
  });

  it("has a footage base track and a GFX overlay track (≥2 video tracks)", () => {
    expect(tl.tracks.video.length).toBeGreaterThanOrEqual(2);
  });

  it("places the lower-third overlay clip on the upper (bottom-of-array) GFX track", () => {
    // The overlay track is the LAST video track (highest main-tractor index = top
    // melt compositing layer — see src/actions/graphic.ts).
    const gfx = tl.tracks.video.at(-1);
    expect(gfx).toBeDefined();
    if (!gfx) return;
    const items = gfx.items.filter((i) => i.kind === "clip");
    expect(items.length).toBe(1);
    const overlay = items[0] as { resource: string; out: number; in: number };
    expect(overlay.resource).toBe("corpus/demo/lower-third.mov");
    // 90-frame overlay (3s @30).
    expect(overlay.out - overlay.in + 1).toBe(90);
  });

  it("composites the overlay over the footage with a qtblend field transition", () => {
    const qt = tl.transitions.find((t) => t.service === "qtblend");
    expect(qt).toBeDefined();
    if (!qt) return;
    // a_track = base footage (lower index), b_track = GFX overlay (higher index, on top).
    expect(qt.aTrack).toBe(1);
    expect(qt.bTrack).toBe(2);
    expect(qt.in).toBe(0);
    expect(qt.out).toBe(89);
  });

  it("has a footage base that CROSS-FADES (a dissolve → moving footage under the overlay)", () => {
    const base = tl.tracks.video[0];
    expect(base).toBeDefined();
    if (!base) return;
    const hasDissolve = base.items.some((i) => i.kind === "dissolve");
    expect(hasDissolve).toBe(true);
  });

  it("carries an audio bed clip with fades on an audio track", () => {
    expect(tl.tracks.audio.length).toBeGreaterThanOrEqual(1);
    const a1 = tl.tracks.audio[0];
    expect(a1).toBeDefined();
    if (!a1) return;
    const clips = a1.items.filter((i) => i.kind === "clip");
    expect(clips.length).toBe(1);
    const tone = clips[0] as { resource: string; filters?: unknown[] };
    expect(tone.resource).toBe("corpus/tone.wav");
    // The fade marker + gain resolve to volume filters on the producer.
    expect((tone.filters ?? []).length).toBeGreaterThan(0);
  });

  it("round-trips byte-identically (committed fixture is a determinism fixpoint)", () => {
    expect(toMlt(tl)).toBe(xml);
    expect(toMlt(fromMlt(toMlt(tl)))).toBe(xml);
  });
});
