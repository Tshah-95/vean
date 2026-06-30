// Media-catalog enrichment tests — the PURE projection from a `SourceProbe` (+ a
// content hash) onto the typed catalog columns the 0002 migration added. Pure (no DB,
// no ffprobe), so it pins the column mapping without spawning anything. The projection
// lives in the DRIVER layer (`src/driver/probe.ts`) precisely so it imports without
// `bun:sqlite`; the I/O `probeAndCatalogAsset` (ffprobe + a real DB write, in
// `src/state/media.ts`) is covered by the render/CLI integration path, not vitest.
import { describe, expect, it } from "vitest";
import { type SourceProbe, probeFactsFromSource } from "../src/driver/probe";

/** A full video-stream probe with an audio stream + colorspace tags. */
const fullProbe: SourceProbe = {
  path: "/footage/a.mp4",
  rFrameRate: { num: 30000, den: 1001 }, // 29.97, the rational form (never a float)
  avgFrameRate: { num: 30000, den: 1001 },
  nbFrames: 300,
  durationSec: 10.01,
  width: 1920,
  height: 1080,
  color: { space: "bt709", transfer: "bt709", primaries: "bt709" },
  audioStreams: 2,
};

describe("probeFactsFromSource — typed catalog projection", () => {
  it("maps every probe fact onto its column, keeping fps RATIONAL", () => {
    const facts = probeFactsFromSource(fullProbe, "deadbeefcafe0001");
    expect(facts).toMatchObject({
      durationSec: 10.01,
      fpsNum: 30000, // rational num — NOT a float 29.97
      fpsDen: 1001,
      width: 1920,
      height: 1080,
      audioStreams: 2,
      colorSpace: "bt709",
      colorTransfer: "bt709",
      colorPrimaries: "bt709",
      contentHash: "deadbeefcafe0001",
    });
    // A real ISO timestamp is stamped for the probe time.
    expect(facts.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Number.isNaN(Date.parse(facts.probedAt))).toBe(false);
  });

  it("leaves video columns null for an audio-only source (no video stream)", () => {
    const audioOnly: SourceProbe = {
      path: "/audio/vo.wav",
      rFrameRate: null,
      avgFrameRate: null,
      nbFrames: null,
      durationSec: 42.5,
      width: null,
      height: null,
      color: { space: null, transfer: null, primaries: null },
      audioStreams: 1,
    };
    const facts = probeFactsFromSource(audioOnly, null);
    expect(facts).toMatchObject({
      durationSec: 42.5,
      fpsNum: null,
      fpsDen: null,
      width: null,
      height: null,
      audioStreams: 1,
      colorSpace: null,
      contentHash: null,
    });
  });

  it("is all-null (except the timestamp) for an unprobeable source (probe === null)", () => {
    const facts = probeFactsFromSource(null, null);
    expect(facts).toMatchObject({
      durationSec: null,
      fpsNum: null,
      fpsDen: null,
      width: null,
      height: null,
      audioStreams: null,
      colorSpace: null,
      colorTransfer: null,
      colorPrimaries: null,
      contentHash: null,
    });
    // Even an unprobeable source records WHEN we tried, so a re-scan can tell
    // "probed, nothing there" from "never probed".
    expect(facts.probedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
