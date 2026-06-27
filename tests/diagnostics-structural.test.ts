// Structural checker — BOTH directions, exhaustively. Every rule in
// `src/diagnostics/checks/structural.ts` is tested twice:
//   • POSITIVE — a hand-built BROKEN fixture trips it with the EXACT expected code,
//     severity, and location. (Silence isn't vacuous if each rule provably fires.)
//   • NEGATIVE — the near-miss VALID fixture is SILENT (no clip narrowing: the clean
//     fixture is a real, renderable timeline, one step away from the broken one).
//
// The no-false-positive gate over the committed corpus lives in
// tests/diagnostics-harness.test.ts (registry-driven, auto-covers this checker). Here
// we additionally prove silence on hand-built CLEAN timelines that exercise the SAME
// shapes the broken fixtures break — so a clean test never passes by being too small.
import { describe, expect, it } from "vitest";
import { type FileProbe, structural, structuralWith } from "../src/diagnostics/checks/structural";
import {
  VERTICAL,
  audioTrack,
  blank,
  clip,
  colorClip,
  dissolve,
  filter,
  resetIds,
  timeline,
  transition,
  videoTrack,
} from "../src/index";
import type { Timeline, Track, Transition } from "../src/ir/types";
import { split } from "../src/ops/split";
import { isEditError } from "../src/ops/types";

/** Codes a state produces under the pure structural checker. */
function codes(tl: Timeline): string[] {
  return structural(tl).map((d) => d.code);
}
/** The structural diagnostic with a given code, if any. */
function byCode(tl: Timeline, code: string) {
  return structural(tl).find((d) => d.code === code);
}

// ── Hand-build helpers (for states the builder/Zod would reject) ────────────────
/** A minimal video track of raw items (bypasses the builder's guards so we can author
 *  an otherwise-impossible broken IR the LSP might hold pre-validation). */
function rawVideoTrack(id: string, items: Track["items"]): Track {
  return { kind: "video", id, items };
}
function rawTimeline(
  tracks: { video?: Track[]; audio?: Track[] },
  transitions: Transition[] = [],
): Timeline {
  return {
    profile: VERTICAL,
    tracks: { video: tracks.video ?? [], audio: tracks.audio ?? [] },
    transitions,
    title: "broken-fixture",
  };
}

describe("structural — in/out beyond source (media clip exceeds source length)", () => {
  it("FIRES error when out ≥ source length", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/a.mp4", { id: "over", in: 0, out: 200, length: 100 }))],
    });
    const d = byCode(tl, "in-out-beyond-source");
    expect(d?.severity).toBe("error");
    expect(d?.location).toMatchObject({ clip: "over", track: expect.any(String) });
    expect(d?.data).toMatchObject({ out: 200, length: 100 });
  });

  it("FIRES error when in < 0", () => {
    const tl = rawTimeline({
      video: [
        rawVideoTrack("v", [
          {
            kind: "clip",
            id: "neg",
            resource: "/a.mp4",
            in: -5,
            out: 40,
            length: 100,
            filters: [],
          },
        ]),
      ],
    });
    const d = byCode(tl, "in-before-source-start");
    expect(d?.severity).toBe("error");
    expect(d?.location.clip).toBe("neg");
  });

  it("SILENT on a clip fully inside its source", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/a.mp4", { id: "ok", in: 0, out: 99, length: 100 }))],
    });
    expect(codes(tl)).not.toContain("in-out-beyond-source");
    expect(codes(tl)).not.toContain("in-before-source-start");
  });

  it("SILENT on a color GENERATOR (out == length-1 holds by construction; no source)", () => {
    resetIds();
    const tl = timeline(VERTICAL, { video: [videoTrack(colorClip(120, "gold"))] });
    expect(codes(tl)).toHaveLength(0);
  });

  it("SILENT on a length-less file clip (source duration is a melt probe, not in-IR)", () => {
    const tl = rawTimeline({
      video: [
        rawVideoTrack("v", [
          { kind: "clip", id: "noLen", resource: "/a.mp4", in: 0, out: 999, filters: [] },
        ]),
      ],
    });
    expect(codes(tl)).not.toContain("in-out-beyond-source");
  });
});

describe("structural — keyframes outside clip bounds (after a trim)", () => {
  it("FIRES warning when EVERY keyframe is past the played window (a dead clamp)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "k",
            dur: 50,
            // Both keyframes past window [0,49] → melt clamps to the first value, the
            // ramp renders flat (verified against melt). This is the real defect.
            filters: [filter("brightness", { level: "100=0;200=1" })],
          }),
        ),
      ],
    });
    const d = byCode(tl, "keyframe-outside-clip");
    expect(d?.severity).toBe("warning");
    expect(d?.location).toMatchObject({ clip: "k", filter: 0 });
    expect(d?.data).toMatchObject({ windowEnd: 49, lastFrame: 200 });
  });

  it("FIRES on an all-past-window TIMECODE animation (regex-resolution defect, hunt #2)", () => {
    resetIds();
    // Both keyframes are timecodes that resolve (at 30 fps) to frames 150 and 300 —
    // ALL past the [0,49] window. The OLD ad-hoc regex stripped each timecode at its
    // first ':' to frame 0 (in-window) and MISSED this entirely; resolving through
    // parseAnim/fps catches it. (A timecode whose anchor IS in-window stays silent —
    // see the live-gradient case below.)
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "tc",
            dur: 50,
            filters: [filter("brightness", { level: "00:00:05.000=0;00:00:10.000=1" })],
          }),
        ),
      ],
    });
    const d = byCode(tl, "keyframe-outside-clip");
    expect(d?.severity).toBe("warning");
    expect(d?.data).toMatchObject({ windowEnd: 49, lastFrame: 300 });
  });

  it("SILENT on a live gradient toward an out-of-window anchor (in-window keyframe present)", () => {
    resetIds();
    // 0 is in-window; 200 is the interpolation TARGET — melt paints a live gradient
    // toward it (verified: ramps 0→~0.245, it renders). An out-of-window keyframe is
    // not a defect when an in-window keyframe anchors it.
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "grad",
            dur: 50,
            filters: [filter("brightness", { level: "0=0;200=1" })],
          }),
        ),
      ],
    });
    expect(codes(tl)).not.toContain("keyframe-outside-clip");
  });

  it("SILENT on a TIMECODE animation whose anchor IS in-window", () => {
    resetIds();
    // 0=0 in-window; the timecode 00:00:10.000 (frame 300) is just the target — a
    // live gradient, exactly like the plain-integer case above.
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "tcok",
            dur: 50,
            filters: [filter("brightness", { level: "0=0;00:00:10.000=1" })],
          }),
        ),
      ],
    });
    expect(codes(tl)).not.toContain("keyframe-outside-clip");
  });

  it("SILENT after split() keeps a head half's full-span ramp verbatim (false-positive, hunt #3)", () => {
    resetIds();
    // A clip with a full-length escape-hatch ramp; clean before the split.
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "A",
            dur: 100,
            length: 100,
            filters: [filter("brightness", { level: "0=0;99=1" })],
          }),
        ),
      ],
    });
    expect(codes(tl)).not.toContain("keyframe-outside-clip");
    // split at frame 40 → the HEAD half (window [0,39]) keeps "0=0;99=1" verbatim BY
    // DESIGN (DESIGN-MOVE1.md §3): the in-window gradient still interpolates toward
    // the real target. A routine split must NOT flip a clean doc to a warning.
    const res = split(tl, { uuid: "A", frame: 40 });
    if (isEditError(res)) throw new Error(`split failed: ${res.kind}`);
    expect(codes(res.state)).not.toContain("keyframe-outside-clip");
  });

  it("SILENT on in-window + relative(negative) keyframes", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "k",
            dur: 50,
            filters: [filter("brightness", { level: "0=0;49=1;-1=0.5" })],
          }),
        ),
      ],
    });
    expect(codes(tl)).not.toContain("keyframe-outside-clip");
  });

  it("SILENT on a fade SENTINEL (no keyframe string of its own)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/a.mp4", { id: "f", dur: 50, fadeIn: 12, fadeOut: 12 }))],
    });
    expect(codes(tl)).not.toContain("keyframe-outside-clip");
  });
});

describe("structural — orphaned filter (no service / absent target)", () => {
  it("FIRES error on a filter with an empty service name", () => {
    const tl = rawTimeline({
      video: [
        rawVideoTrack("v", [
          {
            kind: "clip",
            id: "orf",
            resource: "/a.mp4",
            in: 0,
            out: 40,
            length: 100,
            filters: [{ service: "", properties: {} }],
          },
        ]),
      ],
    });
    const d = byCode(tl, "orphaned-filter");
    expect(d?.severity).toBe("error");
    expect(d?.location).toMatchObject({ clip: "orf", filter: 0 });
  });

  it("SILENT on a clip whose filters all name a service", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", { id: "g", dur: 40, filters: [filter("brightness", { level: 1 })] }),
        ),
      ],
    });
    expect(codes(tl)).not.toContain("orphaned-filter");
  });
});

describe("structural — dissolve overlap + anchoring (insufficient overlap / dangling marker)", () => {
  it("FIRES dissolve-too-long when the dissolve exceeds a neighbour", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(30, "black"), dissolve(20), colorClip(15, "gold"))],
    });
    const d = byCode(tl, "dissolve-too-long");
    expect(d?.severity).toBe("error");
    expect(d?.data).toMatchObject({ dissolveFrames: 20, shortestNeighbour: 15 });
  });

  it("FIRES dissolve-half when one side is a blank (a half-anchored marker)", () => {
    // A dissolve between a clip and a BLANK has nothing to fade into on one side.
    const tl = rawTimeline({
      video: [
        rawVideoTrack("v", [
          {
            kind: "clip",
            id: "c0",
            resource: "#FF000000",
            service: "color",
            in: 0,
            out: 29,
            length: 30,
            filters: [],
          },
          { kind: "dissolve", frames: 10, luma: "luma" },
          { kind: "blank", length: 20 },
        ]),
      ],
    });
    const d = byCode(tl, "dissolve-half");
    expect(d?.severity).toBe("error");
    expect(d?.location.track).toBe("v");
    expect(d?.data).toMatchObject({ missingSide: "trailing" });
    expect(codes(tl)).not.toContain("dissolve-too-long"); // half short-circuits overlap
  });

  it("FIRES dissolve-unanchored when the marker is between two blanks (fully dangling)", () => {
    const tl = rawTimeline({
      video: [
        rawVideoTrack("v", [
          { kind: "blank", length: 10 },
          { kind: "dissolve", frames: 5, luma: "luma" },
          { kind: "blank", length: 10 },
        ]),
      ],
    });
    const d = byCode(tl, "dissolve-unanchored");
    expect(d?.severity).toBe("error");
    expect(d?.location.track).toBe("v");
  });

  it("FIRES clip-overconsumed when a clip is too short for its two dissolves", () => {
    // clip of 10f flanked by a 6f and a 6f dissolve → 12f consumed > 10f available.
    const tl = rawTimeline({
      video: [
        rawVideoTrack("v", [
          {
            kind: "clip",
            id: "a",
            resource: "#FF000000",
            service: "color",
            in: 0,
            out: 29,
            length: 30,
            filters: [],
          },
          { kind: "dissolve", frames: 6, luma: "luma" },
          {
            kind: "clip",
            id: "mid",
            resource: "#FFFFD700",
            service: "color",
            in: 0,
            out: 9,
            length: 10,
            filters: [],
          },
          { kind: "dissolve", frames: 6, luma: "luma" },
          {
            kind: "clip",
            id: "b",
            resource: "#FF0000FF",
            service: "color",
            in: 0,
            out: 29,
            length: 30,
            filters: [],
          },
        ]),
      ],
    });
    const d = byCode(tl, "clip-overconsumed");
    expect(d?.severity).toBe("error");
    expect(d?.location.clip).toBe("mid");
    expect(d?.data).toMatchObject({ clipFrames: 10, consumed: 12 });
  });

  it("SILENT on a valid dissolve (≤ both neighbours, properly anchored)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(45, "black"), dissolve(20), colorClip(60, "gold"))],
    });
    expect(codes(tl)).toHaveLength(0);
  });

  it("SILENT on a clip whose two dissolves fit within it (boundary: consumed == span)", () => {
    // mid clip 20f, two 10f dissolves → consumed 20 == span 20 (exactly fits).
    const tl = rawTimeline({
      video: [
        rawVideoTrack("v", [
          {
            kind: "clip",
            id: "a",
            resource: "#FF000000",
            service: "color",
            in: 0,
            out: 29,
            length: 30,
            filters: [],
          },
          { kind: "dissolve", frames: 10, luma: "luma" },
          {
            kind: "clip",
            id: "mid",
            resource: "#FFFFD700",
            service: "color",
            in: 0,
            out: 19,
            length: 20,
            filters: [],
          },
          { kind: "dissolve", frames: 10, luma: "luma" },
          {
            kind: "clip",
            id: "b",
            resource: "#FF0000FF",
            service: "color",
            in: 0,
            out: 29,
            length: 30,
            filters: [],
          },
        ]),
      ],
    });
    expect(codes(tl)).toHaveLength(0);
  });
});

describe("structural — field transition: track refs, self-composite, window, overlap", () => {
  // A clean two-video-track timeline with a valid field composite, mirroring the
  // corpus vean-multitrack shape: aTrack=1 (V1), bTrack=2 (V2), window inside content.
  function cleanTwoTrack(): Timeline {
    resetIds();
    return timeline(
      VERTICAL,
      {
        video: [
          videoTrack(clip("/a.mp4", { id: "v1", dur: 90, length: 200 })),
          videoTrack(clip("/b.mp4", { id: "v2", dur: 90, length: 200 })),
        ],
      },
      // qtblend composites V2 (index 2) over V1 (index 1) over [10, 80] — well inside
      // both tracks' 90-frame content.
      { transitions: [transition("qtblend", 1, 2, 10, 80)] },
    );
  }

  it("SILENT on a valid two-track field composite (the near-miss clean fixture)", () => {
    expect(codes(cleanTwoTrack())).toHaveLength(0);
  });

  it("SILENT on a background-anchored always-active transition (in=out=0, aTrack=0)", () => {
    // Shotcut's routine auto-stamp: mix over the background, degenerate [0,0] window.
    resetIds();
    const tl = timeline(
      VERTICAL,
      { video: [videoTrack(clip("/a.mp4", { id: "v1", dur: 90, length: 200 }))] },
      { transitions: [transition("mix", 0, 1, 0, 0, { sum: 1, always_active: 1 })] },
    );
    expect(codes(tl)).toHaveLength(0);
  });

  it("SILENT when the window EXTENDS PAST content but still intersects it (Shotcut writes these)", () => {
    resetIds();
    const tl = timeline(
      VERTICAL,
      {
        video: [
          videoTrack(clip("/a.mp4", { id: "v1", dur: 120, length: 200 })),
          videoTrack(blank(15), clip("/b.mp4", { id: "v2", dur: 90, length: 200 })),
        ],
      },
      // window [15, 119]; V2 content is [15,104] → intersects, extends past → OK.
      { transitions: [transition("qtblend", 1, 2, 15, 119)] },
    );
    expect(codes(tl)).toHaveLength(0);
  });

  it("FIRES transition-track-out-of-range when a side points past the real tracks", () => {
    const base = cleanTwoTrack();
    // 2 tracks → valid indices 1..2; index 3 is out of range.
    base.transitions = [
      { service: "qtblend", aTrack: 1, bTrack: 3, in: 10, out: 80, properties: {} },
    ];
    const d = byCode(base, "transition-track-out-of-range");
    expect(d?.severity).toBe("error");
    expect(d?.location.transition).toBe(0);
    expect(d?.data).toMatchObject({ side: "b", index: 3, trackCount: 2 });
  });

  it("FIRES transition-self-composite when a == b", () => {
    const base = cleanTwoTrack();
    base.transitions = [
      { service: "qtblend", aTrack: 1, bTrack: 1, in: 10, out: 80, properties: {} },
    ];
    const d = byCode(base, "transition-self-composite");
    expect(d?.severity).toBe("error");
    expect(d?.data).toMatchObject({ index: 1 });
  });

  it("FIRES transition-inverted-window when in > out", () => {
    const base = cleanTwoTrack();
    base.transitions = [
      { service: "qtblend", aTrack: 1, bTrack: 2, in: 80, out: 10, properties: {} },
    ];
    const d = byCode(base, "transition-inverted-window");
    expect(d?.severity).toBe("error");
    expect(d?.data).toMatchObject({ in: 80, out: 10 });
    expect(d?.location.transition).toBe(0);
  });

  it("FIRES transition-no-overlap when the window starts past a real track's content", () => {
    resetIds();
    const tl = timeline(
      VERTICAL,
      {
        video: [
          videoTrack(clip("/a.mp4", { id: "v1", dur: 200, length: 400 })),
          videoTrack(clip("/b.mp4", { id: "v2", dur: 50, length: 400 })), // content [0,49]
        ],
      },
      // window [100,150] begins after V2 content ends (49) → no overlap on b_track.
      { transitions: [transition("qtblend", 1, 2, 100, 150)] },
    );
    // The b_track (index 2 → IR track [1], the second video track) is the empty side.
    const bTrackId = tl.tracks.video[1]?.id;
    const d = byCode(tl, "transition-no-overlap");
    expect(d?.severity).toBe("error");
    // location.track is the offending track's STABLE id (not a clip id).
    expect(d?.location).toMatchObject({ transition: 0, track: bTrackId });
    expect(d?.data).toMatchObject({ side: "b", windowStart: 100, contentEnd: 49 });
  });
});

describe("structural — missing media file (dangling producer→file, ON DISK)", () => {
  it("is a NO-OP on the pure path (no probe injected → no I/O, no diagnostic)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/definitely/missing.mp4", { id: "m", dur: 40, length: 100 }))],
    });
    expect(structural(tl).map((d) => d.code)).not.toContain("missing-media-file");
  });

  it("FIRES error when an INJECTED probe reports the file absent", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/definitely/missing.mp4", { id: "m", dur: 40, length: 100 }))],
    });
    const probe: FileProbe = { fileExists: (p) => p !== "/definitely/missing.mp4" };
    const d = structuralWith(probe)(tl).find((x) => x.code === "missing-media-file");
    expect(d?.severity).toBe("error");
    expect(d?.location.clip).toBe("m");
    expect(d?.data).toMatchObject({ resource: "/definitely/missing.mp4" });
  });

  it("SILENT (with probe) on a file that DOES exist", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/exists.mp4", { id: "ok", dur: 40, length: 100 }))],
    });
    const probe: FileProbe = { fileExists: () => true };
    expect(structuralWith(probe)(tl).map((d) => d.code)).not.toContain("missing-media-file");
  });

  it("SILENT (with probe) on a color GENERATOR — it has no file to resolve", () => {
    resetIds();
    const tl = timeline(VERTICAL, { video: [videoTrack(colorClip(40, "gold"))] });
    const probe: FileProbe = { fileExists: () => false }; // would fire if it probed
    expect(structuralWith(probe)(tl).map((d) => d.code)).not.toContain("missing-media-file");
  });

  it("resolves a ROOT-RELATIVE resource against the injected root before probing", () => {
    const tl = rawTimeline({
      video: [
        rawVideoTrack("v", [
          {
            kind: "clip",
            id: "rel",
            resource: "assets/clip.mp4",
            in: 0,
            out: 39,
            length: 100,
            filters: [],
          },
        ]),
      ],
    });
    const seen: string[] = [];
    const probe: FileProbe = {
      root: "/project",
      fileExists: (p) => {
        seen.push(p);
        return false;
      },
    };
    const d = structuralWith(probe)(tl).find((x) => x.code === "missing-media-file");
    expect(seen).toContain("/project/assets/clip.mp4"); // root-resolved
    expect(d?.data).toMatchObject({ resolved: "/project/assets/clip.mp4" });
  });
});

describe("structural — whole-checker silence on clean hand-built timelines", () => {
  it("a multi-track clean timeline (clips, blank, dissolve, fades, audio, composite) emits NOTHING", () => {
    resetIds();
    const tl = timeline(
      VERTICAL,
      {
        video: [
          videoTrack(
            clip("/a.mp4", { id: "v1", dur: 90, length: 300, fadeIn: 12 }),
            dissolve(15),
            colorClip(60, "gold", { fadeOut: 10 }),
          ),
          videoTrack(blank(20), clip("/b.mp4", { id: "v2", dur: 90, length: 300 })),
        ],
        audio: [audioTrack(clip("/vo.wav", { id: "a1", dur: 150, length: 600, gain: 0.8 }))],
      },
      { transitions: [transition("qtblend", 1, 2, 20, 100)] },
    );
    expect(structural(tl)).toEqual([]);
  });
});
