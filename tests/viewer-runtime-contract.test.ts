import { describe, expect, it, vi } from "vitest";
import { AudioScheduleGate } from "../viewer/src/audio/scheduleGate";
import { keepPlayerPaused } from "../viewer/src/remotion/pausePlayer";

describe("viewer lifecycle contracts", () => {
  it("schedules a recreated StrictMode audio graph at the same revision", () => {
    const gate = new AudioScheduleGate();
    const firstGraph = {};
    const recreatedGraph = {};

    expect(gate.shouldSchedule(firstGraph, 7)).toBe(true);
    expect(gate.shouldSchedule(firstGraph, 7)).toBe(false);
    gate.release(firstGraph);
    expect(gate.shouldSchedule(recreatedGraph, 7)).toBe(true);
  });

  it("unconditionally pauses a playing Remotion player", () => {
    const pause = vi.fn();
    keepPlayerPaused({ isPlaying: () => true, pause });
    expect(pause).toHaveBeenCalledOnce();
  });

  it("does not pause a player that is already paused", () => {
    const pause = vi.fn();
    keepPlayerPaused({ isPlaying: () => false, pause });
    expect(pause).not.toHaveBeenCalled();
  });
});
