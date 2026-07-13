import { describe, expect, it } from "vitest";
import { scaledWaveformAmplitude, waveformDisplayGain } from "../viewer/src/waveformEnvelope";

describe("waveform display envelope", () => {
  it("amplifies a quiet voice-shaped envelope for timeline visibility", () => {
    const peaks = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? -0.12 : 0.14));
    expect(waveformDisplayGain(peaks)).toBeGreaterThan(5);
  });

  it("does not amplify already-strong audio beyond the lane", () => {
    const peaks = [-0.9, 0.95, -0.8, 0.88];
    expect(waveformDisplayGain(peaks)).toBeLessThanOrEqual(1);
  });

  it("clamps normalized samples to the SVG amplitude domain", () => {
    expect(scaledWaveformAmplitude(0.2, 12)).toBe(1);
    expect(scaledWaveformAmplitude(-0.2, 12)).toBe(-1);
  });
});
