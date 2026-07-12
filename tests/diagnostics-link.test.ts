// LINK checker — both directions of the Move-1 gate, per rule:
//   • a hand-built BROKEN fixture FIRES with the EXACT expected code + location,
//   • a clean/aligned fixture (and the whole committed corpus) is SILENT.
//
// The fixtures are hand-built IR because the trigger signals are the typed A/V
// `link` and stream `streams` fields — the exact shapes a detach op / a parsed
// real-world `.mlt` carries, which the ergonomic `timeline` builder doesn't
// synthesize. Silence is proven on PURPOSE-ALIGNED siblings (same shape, drift
// removed) so a clean test never passes by narrowing the fixture, plus a full pass
// over every corpus `.mlt` (the no-false-positive gate) — the corpus carries NO
// link/streams field, so the checker is silent on it by construction.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDiagnostics } from "../src/diagnostics";
import { link } from "../src/diagnostics/checks/link";
import { fromMlt } from "../src/ir/parse";
import { VERTICAL } from "../src/ir/profile";
import type { Clip, ClipLink, Item, StreamSelectors, Timeline, Track } from "../src/ir/types";

// ─── tiny IR builders (hand-built so we can attach link + streams) ─────────────
function clipNode(over: Partial<Clip> & Pick<Clip, "id" | "resource">): Clip {
  return { kind: "clip", in: 0, out: 89, filters: [], ...over };
}
/** A blank gap item (to shift a clip's timeline position on its track). */
function blank(length: number): Item {
  return { kind: "blank", length };
}
/** The video-role half of an A/V link. */
function videoLink(id: string, partnerIds: string[]): ClipLink {
  return { id, role: "video", partnerIds };
}
/** The audio-role half of an A/V link. */
function audioLink(id: string, partnerIds: string[]): ClipLink {
  return { id, role: "audio", partnerIds };
}
/** Video-only stream selectors (a detach's picture half). */
const VIDEO_ONLY: StreamSelectors = { audioIndex: -1, astream: -1, defaultAudioIndex: 1 };
/** Audio-only stream selectors (a detach's sound half). */
const AUDIO_ONLY: StreamSelectors = { videoIndex: -1, vstream: -1 };

function videoTrackNode(id: string, items: Item[]): Track {
  return { kind: "video", id, items };
}
function audioTrackNode(id: string, items: Item[]): Track {
  return { kind: "audio", id, items, hidden: true };
}
function tl(opts: { video?: Track[]; audio?: Track[] }): Timeline {
  return {
    profile: VERTICAL,
    tracks: { video: opts.video ?? [], audio: opts.audio ?? [] },
    transitions: [],
    title: "link test",
  };
}
/** Diagnostics from the link checker only (already source-stamped by it). */
function diags(state: Timeline) {
  return link(state);
}
function codesOf(state: Timeline): string[] {
  return diags(state).map((d) => d.code);
}

const SRC = "/footage/interview.mp4";

/** A cleanly-detached, IN-SYNC A/V pair on ONE video track (audio on a companion
 *  lane at the SAME position) — the well-formed detach output. Rules that fire on
 *  DRIFT must be silent on this; the ripple-hazard rule (cross-track by design) is
 *  the one exception that legitimately fires on the aligned cross-track shape. */
function alignedPair(): Timeline {
  return tl({
    video: [
      videoTrackNode("V1", [
        clipNode({
          id: "v",
          resource: SRC,
          in: 0,
          out: 89,
          streams: VIDEO_ONLY,
          link: videoLink("g1", ["a"]),
        }),
      ]),
    ],
    audio: [
      audioTrackNode("A1", [
        clipNode({
          id: "a",
          resource: SRC,
          in: 0,
          out: 89,
          streams: AUDIO_ONLY,
          link: audioLink("g1", ["v"]),
        }),
      ]),
    ],
  });
}

// ─── 1. dangling-link ──────────────────────────────────────────────────────────
describe("link · dangling-link — a link references a partner that no longer exists", () => {
  it("FIRES (error) when a linked clip's partner id is absent from the timeline", () => {
    // The video half survives but its audio partner "a" was deleted without unlinking.
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({ id: "v", resource: SRC, streams: VIDEO_ONLY, link: videoLink("g1", ["a"]) }),
        ]),
      ],
    });
    const d = diags(state).find((x) => x.code === "dangling-link");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("error");
    expect(d?.source).toBe("link");
    expect(d?.location).toMatchObject({ clip: "v", track: "V1" });
    expect(d?.data).toMatchObject({ linkId: "g1", missing: "a" });
  });

  it("SILENT when every named partner is present (a well-formed pair)", () => {
    expect(codesOf(alignedPair())).not.toContain("dangling-link");
  });

  it("SILENT for an unlinked clip (no link field at all)", () => {
    const state = tl({
      video: [videoTrackNode("V1", [clipNode({ id: "v", resource: SRC })])],
    });
    expect(codesOf(state)).not.toContain("dangling-link");
  });
});

// ─── 2. av-desync ────────────────────────────────────────────────────────────────
describe("link · av-desync — a linked A/V pair drifted out of sync", () => {
  it("FIRES (warning) when the audio half was head-trimmed but the video wasn't", () => {
    // Video plays source [0..89]; the linked audio plays [10..99] — a one-sided head
    // trim (in drifted by 10). Anchored on the VIDEO member.
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({
            id: "v",
            resource: SRC,
            in: 0,
            out: 89,
            streams: VIDEO_ONLY,
            link: videoLink("g1", ["a"]),
          }),
        ]),
      ],
      audio: [
        audioTrackNode("A1", [
          clipNode({
            id: "a",
            resource: SRC,
            in: 10,
            out: 99,
            streams: AUDIO_ONLY,
            link: audioLink("g1", ["v"]),
          }),
        ]),
      ],
    });
    const d = diags(state).find((x) => x.code === "av-desync");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.source).toBe("link");
    // Anchored on the VIDEO clip; the audio is the related "see also".
    expect(d?.location).toMatchObject({ clip: "v", track: "V1" });
    expect(d?.related?.[0]?.location).toMatchObject({ clip: "a", track: "A1" });
    // Deltas are reported relative to the primary (video): audio in is +10 → the
    // partner's in-point differs by 10.
    expect(d?.data).toMatchObject({ linkId: "g1", inDelta: 10, outDelta: 10, posDelta: 0 });
  });

  it("FIRES when the linked partner drifted in timeline POSITION (moved on its track)", () => {
    // Same source windows, but the audio starts 15 frames later (a blank pushed it).
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({
            id: "v",
            resource: SRC,
            in: 0,
            out: 89,
            streams: VIDEO_ONLY,
            link: videoLink("g1", ["a"]),
          }),
        ]),
      ],
      audio: [
        audioTrackNode("A1", [
          blank(15),
          clipNode({
            id: "a",
            resource: SRC,
            in: 0,
            out: 89,
            streams: AUDIO_ONLY,
            link: audioLink("g1", ["v"]),
          }),
        ]),
      ],
    });
    const d = diags(state).find((x) => x.code === "av-desync");
    expect(d).toBeDefined();
    expect(d?.data).toMatchObject({ posDelta: 15, inDelta: 0, outDelta: 0 });
  });

  it("SILENT when the linked pair is perfectly aligned (in/out/position match)", () => {
    expect(codesOf(alignedPair())).not.toContain("av-desync");
  });

  it("SILENT when the clips are NOT linked, even if their windows differ", () => {
    // Two unlinked same-source clips are legitimate reuse — av-desync must not fire
    // (the shared-resource heuristic for UNLINKED clips is sync.ts's job, not this).
    const state = tl({
      video: [videoTrackNode("V1", [clipNode({ id: "v", resource: SRC, in: 0, out: 89 })])],
      audio: [audioTrackNode("A1", [clipNode({ id: "a", resource: SRC, in: 10, out: 99 })])],
    });
    expect(codesOf(state)).not.toContain("av-desync");
  });
});

// ─── 3. redundant-stream-selector (in-IR slice: dead audio filter) ──────────────
describe("link · redundant-stream-selector — audio off but an audio filter still on", () => {
  it("FIRES (info) when a video-only clip still carries a volume filter", () => {
    // The video-only half turns audio off (astream=-1) but a `volume` audio filter
    // is still attached — it operates on a stream that isn't decoded.
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({
            id: "v",
            resource: SRC,
            streams: VIDEO_ONLY,
            filters: [{ service: "volume", properties: { level: "0.5" } }],
          }),
        ]),
      ],
    });
    const d = diags(state).find((x) => x.code === "redundant-stream-selector");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("info");
    expect(d?.source).toBe("link");
    expect(d?.location).toMatchObject({ clip: "v", track: "V1", filter: 0 });
    expect(d?.data).toMatchObject({ service: "volume" });
  });

  it("SILENT when audio is ON (a selector present but not disabling audio)", () => {
    // audioIndex=0 (audio on) — the volume filter is LIVE, not dead.
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({
            id: "v",
            resource: SRC,
            streams: { audioIndex: 0 },
            filters: [{ service: "volume", properties: { level: "0.5" } }],
          }),
        ]),
      ],
    });
    expect(codesOf(state)).not.toContain("redundant-stream-selector");
  });

  it("SILENT when a video-only clip carries only VIDEO filters (nothing dead)", () => {
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({
            id: "v",
            resource: SRC,
            streams: VIDEO_ONLY,
            filters: [{ service: "brightness", properties: { level: "1.2" } }],
          }),
        ]),
      ],
    });
    expect(codesOf(state)).not.toContain("redundant-stream-selector");
  });

  it("SILENT for a clip with no stream selectors at all", () => {
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({ id: "v", resource: SRC, filters: [{ service: "volume", properties: {} }] }),
        ]),
      ],
    });
    expect(codesOf(state)).not.toContain("redundant-stream-selector");
  });
});

// ─── 4. ripple-link-hazard ──────────────────────────────────────────────────────
describe("link · ripple-link-hazard — an in-sync pair a per-track ripple would break", () => {
  it("FIRES (warning) on an in-sync A/V pair that spans two tracks", () => {
    const d = diags(alignedPair()).find((x) => x.code === "ripple-link-hazard");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.source).toBe("link");
    expect(d?.location).toMatchObject({ clip: "v", track: "V1" });
    expect(d?.related?.[0]?.location).toMatchObject({ clip: "a", track: "A1" });
    expect(d?.data).toMatchObject({ linkId: "g1", trackA: "V1", trackB: "A1" });
  });

  it("SILENT when the linked pair sits on the SAME track (ripples together)", () => {
    // Both linked halves on one video track, back to back — a ripple on that track
    // shifts both, so there is no cross-track desync hazard. (Contrived, but proves
    // the same-track guard.)
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({ id: "v", resource: SRC, in: 0, out: 89, link: videoLink("g1", ["a"]) }),
          clipNode({ id: "a", resource: SRC, in: 0, out: 89, link: audioLink("g1", ["v"]) }),
        ]),
      ],
    });
    expect(codesOf(state)).not.toContain("ripple-link-hazard");
  });

  it("SILENT when the pair is ALREADY drifted (that's av-desync, not a latent hazard)", () => {
    // A drifted cross-track pair is av-desync's concern; ripple-hazard fires only on
    // an IN-SYNC pair (the latent case), so it must NOT double-report a drifted one.
    const state = tl({
      video: [
        videoTrackNode("V1", [
          clipNode({
            id: "v",
            resource: SRC,
            in: 0,
            out: 89,
            streams: VIDEO_ONLY,
            link: videoLink("g1", ["a"]),
          }),
        ]),
      ],
      audio: [
        audioTrackNode("A1", [
          clipNode({
            id: "a",
            resource: SRC,
            in: 10,
            out: 99,
            streams: AUDIO_ONLY,
            link: audioLink("g1", ["v"]),
          }),
        ]),
      ],
    });
    const cs = codesOf(state);
    expect(cs).toContain("av-desync");
    expect(cs).not.toContain("ripple-link-hazard");
  });

  it("SILENT for an unlinked clip on its own track", () => {
    const state = tl({
      video: [videoTrackNode("V1", [clipNode({ id: "v", resource: SRC })])],
      audio: [audioTrackNode("A1", [clipNode({ id: "a", resource: "/music/bed.wav" })])],
    });
    expect(codesOf(state)).not.toContain("ripple-link-hazard");
  });
});

// ─── The no-false-positive gate, asserted in this file too ────────────────────
describe("link · SILENT on every clean corpus file (no-false-positive gate)", () => {
  const CORPUS = join(import.meta.dirname, "..", "corpus");
  const corpusFiles = readdirSync(CORPUS).filter((f) => f.endsWith(".mlt"));

  it("found corpus files (the gate isn't vacuous)", () => {
    expect(corpusFiles.length).toBeGreaterThan(0);
  });

  for (const file of corpusFiles) {
    it(`emits zero link diagnostics on ${file}`, () => {
      const state = fromMlt(readFileSync(join(CORPUS, file), "utf8"));
      // Run via the shared engine, filtered to this checker, so we exercise the exact
      // registry path the harness uses. The corpus carries NO link/streams field, so
      // even the info-severity redundant-stream rule is silent — assert the FULL set.
      const only = collectDiagnostics(state, { only: ["link"] });
      expect(only, JSON.stringify(only, null, 2)).toHaveLength(0);
    });
  }
});
