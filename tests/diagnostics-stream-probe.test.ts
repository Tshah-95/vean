// STREAM-SELECTOR probe RULES — the two selector defects that need the SOURCE
// file's real stream layout (a fact the IR doesn't carry), so they are PURE
// functions over an already-gathered `SourceProbe`, unit-tested WITHOUT ffprobe
// (the I/O orchestrator is exercised by a real render path, never vitest). Same
// shape as tests/diagnostics-probe.test.ts (the fps rule).
//
// BOTH directions, per the Move-1 discipline:
//   • POSITIVE — audio disabled on a file with no audio (redundant), and a selector
//     index past the file's audio-stream count (invalid), each trip the expected code.
//   • NEGATIVE — audio-off on a file that HAS audio, an in-range index, a selector-
//     less clip, and (the load-bearing guard) an UNKNOWN stream count are all SILENT.
import { describe, expect, it } from "vitest";
import {
  invalidStreamSelectorDiagnostic,
  redundantStreamSelectorDiagnostic,
} from "../src/diagnostics/probe";
import type { SourceProbe } from "../src/driver/probe";
import type { Clip } from "../src/ir/types";

const loc = { clip: "c0", track: "V1" };

/** A source probe with a settable audio-stream count (the only field these rules
 *  read); everything else is a neutral baseline. `audioStreams: null` = "unknown". */
function probe(audioStreams: number | null): SourceProbe {
  return {
    path: "/footage/clip.mp4",
    rFrameRate: { num: 30, den: 1 },
    avgFrameRate: { num: 30, den: 1 },
    nbFrames: 300,
    durationSec: 10,
    width: 1920,
    height: 1080,
    color: { space: null, transfer: null, primaries: null },
    audioStreams,
  };
}

/** A clip carrying the given stream selectors (or none). */
function clip(over: Partial<Clip> = {}): Clip {
  return {
    kind: "clip",
    id: "c0",
    resource: "/footage/clip.mp4",
    in: 0,
    out: 89,
    filters: [],
    ...over,
  };
}

const codes = (ds: { code: string }[]): string[] => ds.map((d) => d.code).sort();

// ─── redundant-stream-selector (probe slice: audio off on a silent file) ─────────
describe("redundantStreamSelectorDiagnostic — audio disabled on a file with no audio", () => {
  it("FIRES (info) when the clip turns audio off and the source has 0 audio streams", () => {
    const c = clip({ streams: { audioIndex: -1, astream: -1 } });
    const ds = redundantStreamSelectorDiagnostic(c, probe(0), loc);
    expect(codes(ds)).toEqual(["redundant-stream-selector"]);
    const d = ds[0];
    expect(d?.severity).toBe("info");
    expect(d?.location).toEqual({ clip: "c0", track: "V1" });
    expect(d?.data).toMatchObject({ audioStreams: 0 });
  });

  it("is SILENT when the file HAS audio (disabling it is meaningful, not redundant)", () => {
    const c = clip({ streams: { audioIndex: -1, astream: -1 } });
    expect(redundantStreamSelectorDiagnostic(c, probe(1), loc)).toEqual([]);
  });

  it("is SILENT when audio is ON (no -1 selector)", () => {
    const c = clip({ streams: { audioIndex: 0 } });
    expect(redundantStreamSelectorDiagnostic(c, probe(0), loc)).toEqual([]);
  });

  it("is SILENT for a clip with no stream selectors at all", () => {
    expect(redundantStreamSelectorDiagnostic(clip(), probe(0), loc)).toEqual([]);
  });

  it("is SILENT when the audio-stream count is UNKNOWN (the guard — judge nothing)", () => {
    const c = clip({ streams: { audioIndex: -1, astream: -1 } });
    expect(redundantStreamSelectorDiagnostic(c, probe(null), loc)).toEqual([]);
  });
});

// ─── invalid-stream-selector (index past the file's stream count) ────────────────
describe("invalidStreamSelectorDiagnostic — a selector index beyond the source's streams", () => {
  it("FIRES (error) when astream indexes past the audio-stream count", () => {
    // astream=3 on a file with a single audio stream (valid indices 0..0).
    const c = clip({ streams: { astream: 3 } });
    const ds = invalidStreamSelectorDiagnostic(c, probe(1), loc);
    expect(codes(ds)).toEqual(["invalid-stream-selector"]);
    const d = ds[0];
    expect(d?.severity).toBe("error");
    expect(d?.location).toEqual({ clip: "c0", track: "V1" });
    expect(d?.data).toMatchObject({ selector: "astream", index: 3, audioStreams: 1 });
  });

  it("FIRES on an absolute audio_index past the count when astream is unset", () => {
    const c = clip({ streams: { audioIndex: 2 } });
    const ds = invalidStreamSelectorDiagnostic(c, probe(2), loc); // valid 0..1
    expect(codes(ds)).toEqual(["invalid-stream-selector"]);
    expect(ds[0]?.data).toMatchObject({ selector: "audio_index", index: 2, audioStreams: 2 });
  });

  it("reports astream (which overrides audio_index) when BOTH are out of range", () => {
    const c = clip({ streams: { astream: 5, audioIndex: 9 } });
    const ds = invalidStreamSelectorDiagnostic(c, probe(1), loc);
    expect(ds).toHaveLength(1);
    expect(ds[0]?.data).toMatchObject({ selector: "astream", index: 5 });
  });

  it("is SILENT for an IN-RANGE selector (index within the count)", () => {
    const c = clip({ streams: { astream: 0 } });
    expect(invalidStreamSelectorDiagnostic(c, probe(1), loc)).toEqual([]);
    const c2 = clip({ streams: { audioIndex: 1 } });
    expect(invalidStreamSelectorDiagnostic(c2, probe(2), loc)).toEqual([]);
  });

  it("is SILENT for the OFF sentinel (-1) — turning audio off is always valid", () => {
    const c = clip({ streams: { audioIndex: -1, astream: -1 } });
    expect(invalidStreamSelectorDiagnostic(c, probe(1), loc)).toEqual([]);
  });

  it("is SILENT for a clip with no selectors", () => {
    expect(invalidStreamSelectorDiagnostic(clip(), probe(1), loc)).toEqual([]);
  });

  it("is SILENT when the audio-stream count is UNKNOWN (the guard — skip gracefully)", () => {
    const c = clip({ streams: { astream: 3 } });
    expect(invalidStreamSelectorDiagnostic(c, probe(null), loc)).toEqual([]);
  });

  it("is SILENT for VIDEO selectors — the probe carries no video-stream count (guard)", () => {
    // vstream/video_index are NOT validated: the probe reads only the first video
    // stream, not a count, so we skip them rather than risk a false positive.
    const c = clip({ streams: { vstream: 9, videoIndex: 9 } });
    expect(invalidStreamSelectorDiagnostic(c, probe(1), loc)).toEqual([]);
  });
});
