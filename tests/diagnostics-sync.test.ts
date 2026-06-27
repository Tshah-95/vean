// SYNC checker — both directions of the Move-1b gate, per checker:
//   • a hand-built BROKEN fixture FIRES with the EXACT expected code + location,
//   • a clean fixture (and the whole committed corpus) is SILENT.
//
// The broken fixtures are hand-built IR because the trigger signals are producer
// extra-properties (a probed source fps `meta.media.frame_rate_*`, a `timewarp`
// `warp_speed`/`warp_pitch`) and a same-source A/V split that the ergonomic
// builder doesn't synthesize — these are exactly the shapes a parsed real-world
// `.mlt` carries. Silence is proven on PURPOSE-CLEAN siblings (same shape, hazard
// removed) so a clean test never passes by narrowing the fixture, plus a full pass
// over every corpus `.mlt` (the no-false-positive gate, in this file too).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDiagnostics } from "../src/diagnostics";
import { sync } from "../src/diagnostics/checks/sync";
import { fromMlt } from "../src/ir/parse";
import { VERTICAL } from "../src/ir/profile";
import type { Clip, Timeline, Track } from "../src/ir/types";

// ─── tiny IR builders (hand-built so we can attach extraProps + A/V splits) ────
function clipNode(over: Partial<Clip> & Pick<Clip, "id" | "resource">): Clip {
  return {
    kind: "clip",
    in: 0,
    out: 89,
    filters: [],
    ...over,
  };
}
function videoTrackNode(id: string, items: Clip[]): Track {
  return { kind: "video", id, items };
}
function audioTrackNode(id: string, items: Clip[]): Track {
  return { kind: "audio", id, items, hidden: true };
}
function tl(opts: { video?: Track[]; audio?: Track[]; profile?: Timeline["profile"] }): Timeline {
  return {
    profile: opts.profile ?? VERTICAL,
    tracks: { video: opts.video ?? [], audio: opts.audio ?? [] },
    transitions: [],
    title: "sync test",
  };
}
/** All diagnostics from the sync checker only (already source-stamped by it). */
function diags(state: Timeline) {
  return sync(state);
}
function codesOf(state: Timeline): string[] {
  return diags(state).map((d) => d.code);
}

// ─── 1. av-asymmetric-trim ────────────────────────────────────────────────────
describe("sync · av-asymmetric-trim — detached audio misaligned with its video", () => {
  const SRC = "/footage/interview.mp4";

  it("FIRES (warning) when same-source audio is head-trimmed differently than the video", () => {
    const state = tl({
      // Video plays source [10..99]; the detached audio plays [0..89] — a 10-frame
      // head-trim that didn't ripple to the audio ⇒ lip-sync drifts by 10 frames.
      video: [videoTrackNode("V1", [clipNode({ id: "v", resource: SRC, in: 10, out: 99 })])],
      audio: [audioTrackNode("A1", [clipNode({ id: "a", resource: SRC, in: 0, out: 89 })])],
    });
    const d = diags(state).find((x) => x.code === "av-asymmetric-trim");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.source).toBe("sync");
    // Anchored on the VIDEO clip; the audio is the related "see also".
    expect(d?.location).toMatchObject({ clip: "v", track: "V1" });
    expect(d?.related?.[0]?.location).toMatchObject({ clip: "a", track: "A1" });
    expect(d?.data).toMatchObject({ inDelta: -10, lenDelta: 0 });
  });

  it("FIRES when same-source audio plays a different LENGTH than the video", () => {
    const state = tl({
      video: [videoTrackNode("V1", [clipNode({ id: "v", resource: SRC, in: 0, out: 99 })])],
      audio: [audioTrackNode("A1", [clipNode({ id: "a", resource: SRC, in: 0, out: 89 })])],
    });
    const d = diags(state).find((x) => x.code === "av-asymmetric-trim");
    expect(d).toBeDefined();
    expect(d?.data).toMatchObject({ inDelta: 0, lenDelta: -10 });
  });

  it("SILENT when the linked audio is trimmed/positioned SYMMETRICALLY (correct A/V)", () => {
    // Same shape as the broken fixture, hazard removed: identical source windows.
    const state = tl({
      video: [videoTrackNode("V1", [clipNode({ id: "v", resource: SRC, in: 10, out: 99 })])],
      audio: [audioTrackNode("A1", [clipNode({ id: "a", resource: SRC, in: 10, out: 99 })])],
    });
    expect(codesOf(state)).not.toContain("av-asymmetric-trim");
  });

  it("SILENT when the same source is REUSED (ambiguous pairing, not a link)", () => {
    // Two video uses + one audio use of one source is legitimate reuse, not an A/V
    // link — firing here would be a false positive, so the rule stays quiet.
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({ id: "v1", resource: SRC, in: 0, out: 49 }),
          clipNode({ id: "v2", resource: SRC, in: 50, out: 99 }),
        ]),
      ],
      audio: [audioTrackNode("A1", [clipNode({ id: "a", resource: SRC, in: 0, out: 49 })])],
    });
    expect(codesOf(state)).not.toContain("av-asymmetric-trim");
  });

  it("SILENT when the audio-track clip is a DIFFERENT source (no shared resource)", () => {
    const state = tl({
      video: [videoTrackNode("V1", [clipNode({ id: "v", resource: SRC, in: 10, out: 99 })])],
      audio: [
        audioTrackNode("A1", [clipNode({ id: "a", resource: "/music/bed.wav", in: 0, out: 89 })]),
      ],
    });
    expect(codesOf(state)).not.toContain("av-asymmetric-trim");
  });
});

// ─── 2. clip-fps-mismatch ─────────────────────────────────────────────────────
describe("sync · clip-fps-mismatch — source fps differs from the timeline profile", () => {
  const SRC = "/footage/shot24.mp4";

  it("FIRES (warning) when a 24 fps source renders on a 30 fps timeline", () => {
    // VERTICAL is 30 fps; the probed source is 24 fps (24000/1000).
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({
            id: "shot",
            resource: SRC,
            in: 0,
            out: 47,
            extraProps: { "meta.media.frame_rate_num": 24000, "meta.media.frame_rate_den": 1000 },
          }),
        ]),
      ],
    });
    const d = diags(state).find((x) => x.code === "clip-fps-mismatch");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.source).toBe("sync");
    expect(d?.location).toMatchObject({ clip: "shot", track: "V1" });
    expect(d?.data).toMatchObject({
      sourceFpsNum: 24000,
      sourceFpsDen: 1000,
      profileFpsNum: 30,
      profileFpsDen: 1,
    });
  });

  it("SILENT when the source fps EQUALS the profile fps (as an unreduced rational)", () => {
    // Same shape, hazard removed: 30000/1000 == 30/1 (cross-multiplied, no float).
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({
            id: "shot",
            resource: SRC,
            in: 0,
            out: 89,
            extraProps: { "meta.media.frame_rate_num": 30000, "meta.media.frame_rate_den": 1000 },
          }),
        ]),
      ],
    });
    expect(codesOf(state)).not.toContain("clip-fps-mismatch");
  });

  it("SILENT when the source fps was never probed (no meta.media.* props)", () => {
    const state = tl({
      video: [videoTrackNode("V1", [clipNode({ id: "shot", resource: SRC, in: 0, out: 89 })])],
    });
    expect(codesOf(state)).not.toContain("clip-fps-mismatch");
  });
});

// ─── 3. speed-change-no-pitch ─────────────────────────────────────────────────
describe("sync · speed-change-no-pitch — retimed clip whose audio isn't pitch-corrected", () => {
  const SRC = "/footage/talk.mp4";

  it("FIRES (warning) for a 2× speed clip with audio and no pitch compensation", () => {
    const state = tl({
      audio: [
        audioTrackNode("A1", [
          clipNode({
            id: "fast",
            resource: SRC,
            in: 0,
            out: 44,
            // warp_speed present + ≠ 1, warp_pitch absent ⇒ no compensation.
            extraProps: { warp_speed: 2, mlt_service: "timewarp" },
          }),
        ]),
      ],
    });
    const d = diags(state).find((x) => x.code === "speed-change-no-pitch");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.source).toBe("sync");
    expect(d?.location).toMatchObject({ clip: "fast", track: "A1" });
    expect(d?.data).toMatchObject({ speed: 2, warpPitch: 0 });
  });

  it("SILENT when pitch compensation IS on (warp_pitch=1)", () => {
    // Same shape, hazard removed: pitch is preserved.
    const state = tl({
      audio: [
        audioTrackNode("A1", [
          clipNode({
            id: "fast",
            resource: SRC,
            in: 0,
            out: 44,
            extraProps: { warp_speed: 2, warp_pitch: 1 },
          }),
        ]),
      ],
    });
    expect(codesOf(state)).not.toContain("speed-change-no-pitch");
  });

  it("SILENT at unit speed (warp_speed=1 — not a real retime)", () => {
    const state = tl({
      audio: [
        audioTrackNode("A1", [
          clipNode({ id: "norm", resource: SRC, in: 0, out: 89, extraProps: { warp_speed: 1 } }),
        ]),
      ],
    });
    expect(codesOf(state)).not.toContain("speed-change-no-pitch");
  });

  it("SILENT when the retimed clip has its audio disabled (audio_index=-1)", () => {
    // A speed change on a video-only source has no audio to pitch-shift.
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({
            id: "broll",
            resource: SRC,
            in: 0,
            out: 44,
            extraProps: { warp_speed: 2, audio_index: -1 },
          }),
        ]),
      ],
    });
    expect(codesOf(state)).not.toContain("speed-change-no-pitch");
  });
});

// ─── The no-false-positive gate, asserted in this file too ────────────────────
describe("sync · SILENT on every clean corpus file (no-false-positive gate)", () => {
  const CORPUS = join(import.meta.dirname, "..", "corpus");
  const corpusFiles = readdirSync(CORPUS).filter((f) => f.endsWith(".mlt"));

  it("found corpus files (the gate isn't vacuous)", () => {
    expect(corpusFiles.length).toBeGreaterThan(0);
  });

  for (const file of corpusFiles) {
    it(`emits zero sync diagnostics on ${file}`, () => {
      const state = fromMlt(readFileSync(join(CORPUS, file), "utf8"));
      // Run via the shared engine, filtered to this checker, so we exercise the
      // exact registry path the harness uses.
      const only = collectDiagnostics(state, { only: ["sync"] });
      expect(only, JSON.stringify(only, null, 2)).toHaveLength(0);
    });
  }
});
