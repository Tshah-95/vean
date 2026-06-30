// The renderer-binary override hook: the Mac app points melt/ffmpeg/ffprobe at its
// bundled sidecars via VEAN_MELT/VEAN_FFMPEG/VEAN_FFPROBE; unset, the driver falls
// back to the bare name on PATH (the source/CLI/Homebrew path). This is the seam
// that lets one driver serve both the system-deps artifact and the bundled app.
import { afterEach, describe, expect, it } from "vitest";
import { resolveBin } from "../src/driver/melt";

const KEYS = [
  "VEAN_MELT",
  "VEAN_MELT_BIN",
  "VEAN_FFMPEG",
  "VEAN_FFMPEG_BIN",
  "VEAN_FFPROBE",
  "VEAN_FFPROBE_BIN",
];

function clear() {
  for (const k of KEYS) delete process.env[k];
}

describe("resolveBin", () => {
  afterEach(clear);

  it("falls back to the bare name when no override is set", () => {
    clear();
    expect(resolveBin("melt")).toBe("melt");
    expect(resolveBin("ffmpeg")).toBe("ffmpeg");
    expect(resolveBin("ffprobe")).toBe("ffprobe");
  });

  it("honors the primary VEAN_* overrides", () => {
    clear();
    process.env.VEAN_MELT = "/opt/vean/melt";
    process.env.VEAN_FFMPEG = "/opt/vean/ffmpeg";
    process.env.VEAN_FFPROBE = "/opt/vean/ffprobe";
    expect(resolveBin("melt")).toBe("/opt/vean/melt");
    expect(resolveBin("ffmpeg")).toBe("/opt/vean/ffmpeg");
    expect(resolveBin("ffprobe")).toBe("/opt/vean/ffprobe");
  });

  it("accepts the *_BIN spelling and prefers the primary name", () => {
    clear();
    process.env.VEAN_MELT_BIN = "/a/melt";
    expect(resolveBin("melt")).toBe("/a/melt");
    process.env.VEAN_MELT = "/b/melt";
    expect(resolveBin("melt")).toBe("/b/melt");
  });

  it("passes through unknown binary names unchanged", () => {
    clear();
    expect(resolveBin("convert")).toBe("convert");
  });
});
