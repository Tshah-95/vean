/**
 * Choose a display-only gain for a waveform envelope.
 *
 * Recorded speech often peaks far below full scale. Drawing raw PCM amplitude
 * makes a perfectly usable sync track look like a flat line, especially in a
 * 40px timeline lane. We normalize against the 95th-percentile bucket magnitude
 * so ordinary speech fills the lane while isolated clicks do not set the scale.
 * This never changes playback gain; it only changes the SVG envelope.
 */
export function waveformDisplayGain(peaks: readonly number[]): number {
  const magnitudes: number[] = [];
  for (let i = 0; i + 1 < peaks.length; i += 2) {
    magnitudes.push(Math.max(Math.abs(peaks[i] ?? 0), Math.abs(peaks[i + 1] ?? 0)));
  }
  if (magnitudes.length === 0) return 1;
  magnitudes.sort((a, b) => a - b);
  const reference = magnitudes[Math.floor((magnitudes.length - 1) * 0.95)] ?? 0;
  // A floor keeps near-silence from becoming a full-height noise block; the cap
  // still makes a -18dB-ish voice take substantially easier to sync by eye.
  return Math.min(12, 0.78 / Math.max(0.04, reference));
}

export function scaledWaveformAmplitude(value: number, gain: number): number {
  return Math.max(-1, Math.min(1, value * gain));
}
