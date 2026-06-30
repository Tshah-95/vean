import { describe, expect, it } from "vitest";
// The MASTER CLOCK's time base (DESIGN-LIVE-PREVIEW §3, §6 Tier 2b, §8.6). The clock
// is a pure ESM module (no React); its rational frame⇄seconds math and the
// wall-clock⇄AudioContext time-source swap are environment-free and unit-testable.
// The rAF-driven `tick` itself is verified in the headless `drive` gate (a real
// browser), but the LOAD-BEARING invariant — exact integer-rational time, never a
// float fps — lives in these pure conversions, so they are pinned here.
//
// NOTE: `play()`/`pause()`/`tick()` call `requestAnimationFrame`/`performance.now`,
// absent in the node test env, so these tests stay on the paused/config surface
// (`configure`, `secondsForFrame`, `frameForSeconds`, `attachTimeSource`, `now`),
// which is exactly where the rational-time invariant is enforced.
import { MasterClock } from "../viewer/src/clock";

describe("MasterClock: rational frame⇄seconds (never a float fps)", () => {
  it("converts integer frames to seconds with EXACT rational fps (29.97 = 30000/1001)", () => {
    const clock = new MasterClock();
    clock.configure([30000, 1001], 1000); // 29.97
    // 30 frames at 29.97 = 30 * 1001 / 30000 = 1.001 s, exactly.
    expect(clock.secondsForFrame(30)).toBeCloseTo(1.001, 12);
    // Round-trips: secondsForFrame then frameForSeconds returns the integer frame.
    for (const f of [0, 1, 30, 100, 999]) {
      expect(clock.frameForSeconds(clock.secondsForFrame(f))).toBe(f);
    }
  });

  it("uses integer 30/1 fps without float drift", () => {
    const clock = new MasterClock();
    clock.configure([30, 1], 600);
    expect(clock.secondsForFrame(90)).toBeCloseTo(3, 12);
    expect(clock.frameForSeconds(3)).toBe(90);
  });
});

describe("MasterClock: time-source swap (wall-clock ⇄ AudioContext)", () => {
  it("defaults to a wall-clock time base and reports it via now()", () => {
    const clock = new MasterClock();
    const a = clock.now();
    const b = clock.now();
    expect(typeof a).toBe("number");
    // Monotonic non-decreasing (wall-clock seconds).
    expect(b).toBeGreaterThanOrEqual(a);
  });

  it("attachTimeSource swaps the base so now() reads the injected source", () => {
    const clock = new MasterClock();
    let audioTime = 12.5;
    clock.attachTimeSource(() => audioTime);
    expect(clock.now()).toBe(12.5);
    audioTime = 13.25;
    expect(clock.now()).toBe(13.25);
  });

  it("detachTimeSource reverts to wall-clock", () => {
    const clock = new MasterClock();
    clock.attachTimeSource(() => 99);
    expect(clock.now()).toBe(99);
    clock.detachTimeSource();
    // Back to wall-clock — not the pinned 99.
    expect(clock.now()).not.toBe(99);
  });

  it("attaching the SAME source twice is a no-op (idempotent)", () => {
    const clock = new MasterClock();
    const src = () => 7;
    clock.attachTimeSource(src);
    expect(clock.now()).toBe(7);
    clock.attachTimeSource(src); // no throw, still the same base
    expect(clock.now()).toBe(7);
  });

  it("a swap while PAUSED does not move the playhead (no re-anchor side effect)", () => {
    const clock = new MasterClock();
    clock.configure([30, 1], 300);
    clock.seekTo(42);
    expect(clock.getSnapshot().currentFrame).toBe(42);
    clock.attachTimeSource(() => 5);
    // Paused: the frame is unchanged by the time-source swap.
    expect(clock.getSnapshot().currentFrame).toBe(42);
    clock.detachTimeSource();
    expect(clock.getSnapshot().currentFrame).toBe(42);
  });
});
