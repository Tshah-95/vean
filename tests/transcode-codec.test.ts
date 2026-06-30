// codecSpec mapping tests — the pure codec→ffmpeg-flags table (the actual ffmpeg
// transcode is verified by a real run, never vitest). Asserts each media.transcodeCodec
// value maps to the right encoder, profile, and container.
import { describe, expect, it } from "vitest";
import { codecSpec } from "../src/driver/transcode";

describe("codecSpec", () => {
  it("maps ProRes tiers to prores_ks profiles in a .mov", () => {
    expect(codecSpec("prores422hq")).toMatchObject({ ext: ".mov" });
    expect(codecSpec("prores422hq").video).toEqual(
      expect.arrayContaining(["-c:v", "prores_ks", "-profile:v", "3"]),
    );
    expect(codecSpec("prores422").video).toEqual(expect.arrayContaining(["-profile:v", "2"]));
    expect(codecSpec("prores422lt").video).toEqual(expect.arrayContaining(["-profile:v", "1"]));
  });

  it("maps DNxHR tiers to the dnxhd encoder in a .mov", () => {
    expect(codecSpec("dnxhr_hq")).toMatchObject({ ext: ".mov" });
    expect(codecSpec("dnxhr_hq").video).toEqual(
      expect.arrayContaining(["-c:v", "dnxhd", "-profile:v", "dnxhr_hq"]),
    );
    expect(codecSpec("dnxhr_sq").video).toEqual(expect.arrayContaining(["-profile:v", "dnxhr_sq"]));
  });

  it("maps h264 to libx264 in an .mp4 with AAC audio", () => {
    const spec = codecSpec("h264");
    expect(spec.ext).toBe(".mp4");
    expect(spec.video).toEqual(expect.arrayContaining(["-c:v", "libx264"]));
    expect(spec.audio).toEqual(expect.arrayContaining(["-c:a", "aac"]));
  });

  it("uses PCM audio for the all-intra mezzanine codecs", () => {
    expect(codecSpec("prores422hq").audio).toEqual(expect.arrayContaining(["-c:a", "pcm_s16le"]));
    expect(codecSpec("dnxhr_hq").audio).toEqual(expect.arrayContaining(["-c:a", "pcm_s16le"]));
  });
});
