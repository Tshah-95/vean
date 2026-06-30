// Media / lint checker tests — BOTH directions, per the Move-1b non-negotiable:
//   1. POSITIVE — a hand-built BROKEN fixture trips EACH of the five media rules
//      with the EXACT expected `code` + `location` (and severity/data where it is
//      load-bearing). Silence isn't vacuous if every rule demonstrably fires.
//   2. NEGATIVE — clean fixtures (and, via tests/diagnostics-harness.test.ts, the
//      whole committed corpus) yield ZERO media diagnostics. The clean fixtures
//      here are NOT narrowed to dodge a rule: each is the SAME shape as its broken
//      twin with only the defect removed (an on-canvas rect, a present LUT, a
//      matching aspect, a standard rate, a single filter, an in-range dial), so a
//      pass proves the rule discriminates rather than abstains.
//
// The `media` checker reads facts the IR already carries — a clip's verbatim
// `extraProps` and its filter list — so the colorspace / aspect / sample-rate
// fixtures hand-build the `Timeline` (the builder/Zod path doesn't author
// `extraProps`), exactly as the LSP would hold an in-progress document.
import { describe, expect, it } from "vitest";
import { collectDiagnostics } from "../src/diagnostics";
import { VERTICAL, audioTrack, clip, filter, resetIds, timeline, videoTrack } from "../src/index";
import type { Clip, Profile, Timeline, Track } from "../src/ir/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────
/** Just the `media`-source diagnostics for a state (the focused subset). */
function mediaDiags(tl: Timeline) {
  return collectDiagnostics(tl, { only: ["media"] });
}
/** The media diagnostic with a given code, if any. */
function byCode(tl: Timeline, code: string) {
  return mediaDiags(tl).find((d) => d.code === code);
}

/** Hand-build a single-video-track timeline from already-built clips (bypasses
 *  the builder/Zod so a fixture can carry `extraProps` or an exotic value the
 *  LSP might hold pre-validation). */
function handTimeline(profile: Profile, clips: Clip[], trackId = "v1"): Timeline {
  const track: Track = { kind: "video", id: trackId, items: clips };
  return {
    profile,
    tracks: { video: [track], audio: [] },
    transitions: [],
    title: "media fixture",
  };
}

// ─── 1. Upscaling past 100% of the canvas ────────────────────────────────────
describe("media: upscaling-past-canvas", () => {
  it("FIRES on a static pixel rect wider/taller than the canvas (warning)", () => {
    resetIds();
    // VERTICAL canvas is 1080×1920; an affine rect of 1600×1920 scales past it.
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "up",
            dur: 60,
            filters: [filter("affine", { "transition.rect": "0 0 1600 1920 1" })],
          }),
        ),
      ],
    });
    const d = byCode(tl, "upscaling-past-canvas");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.location.clip).toBe("up");
    expect(d?.location.filter).toBe(0);
    expect(d?.data).toMatchObject({
      width: 1600,
      height: 1920,
      canvasWidth: 1080,
      canvasHeight: 1920,
    });
  });

  it("is SILENT on an on-canvas pixel rect (same shape, size ≤ canvas)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "fit",
            dur: 60,
            // Exactly the 1080×1920 canvas — fills it, does not exceed it.
            filters: [filter("affine", { "transition.rect": "0 0 1080 1920 1" })],
          }),
        ),
      ],
    });
    expect(byCode(tl, "upscaling-past-canvas")).toBeUndefined();
  });

  it("is SILENT on a percent rect (canvas-relative, never an upscale)", () => {
    resetIds();
    // The corpus qtblend uses a `%` rect; a >100% percent value is a composite
    // position, not a source upscale — out of this rule's scope on purpose.
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "pct",
            dur: 60,
            filters: [filter("qtblend", { rect: "0% 0% 100% 100% 1" })],
          }),
        ),
      ],
    });
    expect(byCode(tl, "upscaling-past-canvas")).toBeUndefined();
  });

  it("is SILENT on an ANIMATED rect (its peak is the driver/query's call)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "anim",
            dur: 60,
            // An animated rect that momentarily exceeds canvas is NOT flagged here
            // (uncertainty ⇒ silence); the corpus's animated affine matches this.
            filters: [
              filter("affine", { "transition.rect": "0=0 0 1080 1920 1;30~=0 0 1600 2000 1" }),
            ],
          }),
        ),
      ],
    });
    expect(byCode(tl, "upscaling-past-canvas")).toBeUndefined();
  });
});

// ─── 2. Colorspace mismatch (log / wide gamut on Rec.709, no LUT) ─────────────
describe("media: colorspace-mismatch", () => {
  it("FIRES on a log source on a 709 timeline with no LUT (warning)", () => {
    const logClip: Clip = {
      kind: "clip",
      id: "slog",
      resource: "/footage/a7s.mov",
      in: 0,
      out: 120,
      filters: [],
      extraProps: { color_trc: "arib-std-b67-slog3" },
    };
    const tl = handTimeline(VERTICAL, [logClip]); // VERTICAL.colorspace === 709
    const d = byCode(tl, "colorspace-mismatch");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.location.clip).toBe("slog");
    expect(d?.data).toMatchObject({ hint: "color_trc" });
  });

  it("FIRES on a Rec.2020 source on a 709 timeline with no LUT", () => {
    const wideClip: Clip = {
      kind: "clip",
      id: "bt2020",
      resource: "/footage/wide.mov",
      in: 0,
      out: 120,
      filters: [],
      extraProps: { color_primaries: "bt2020" },
    };
    const tl = handTimeline(VERTICAL, [wideClip]);
    expect(byCode(tl, "colorspace-mismatch")?.location.clip).toBe("bt2020");
  });

  it("is SILENT when a LUT filter handles the conversion (same source + a LUT)", () => {
    const corrected: Clip = {
      kind: "clip",
      id: "slog-lut",
      resource: "/footage/a7s.mov",
      in: 0,
      out: 120,
      filters: [filter("lut3d", { file: "/luts/slog3-to-709.cube" })],
      extraProps: { color_trc: "arib-std-b67-slog3" },
    };
    const tl = handTimeline(VERTICAL, [corrected]);
    expect(byCode(tl, "colorspace-mismatch")).toBeUndefined();
  });

  it("is SILENT on a clip with no colorspace metadata (the whole clean corpus)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/a.mp4", { id: "plain", dur: 60 }))],
    });
    expect(byCode(tl, "colorspace-mismatch")).toBeUndefined();
  });
});

// ─── 3. Pixel-aspect / audio sample-rate mismatch ────────────────────────────
describe("media: pixel-aspect-mismatch + sample-rate-mismatch", () => {
  it("FIRES pixel-aspect-mismatch on an anamorphic source on a square-pixel timeline", () => {
    // VERTICAL is square-pixel (sample aspect 1:1); a 1.46 PAR source (DVCPRO HD)
    // would be resampled — distorting geometry.
    const anamorphic: Clip = {
      kind: "clip",
      id: "ana",
      resource: "/footage/dvcprohd.mov",
      in: 0,
      out: 120,
      filters: [],
      extraProps: { aspect_ratio: "1.4593" },
    };
    const tl = handTimeline(VERTICAL, [anamorphic]);
    const d = byCode(tl, "pixel-aspect-mismatch");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.location.clip).toBe("ana");
    expect(d?.data).toMatchObject({ source: 1.4593, timeline: 1 });
  });

  it("FIRES sample-rate-mismatch on a non-standard audio rate", () => {
    const oddRate: Clip = {
      kind: "clip",
      id: "rate",
      resource: "/audio/odd.wav",
      in: 0,
      out: 120,
      filters: [],
      extraProps: { frequency: "32000" },
    };
    const tl = handTimeline(VERTICAL, [oddRate]);
    const d = byCode(tl, "sample-rate-mismatch");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.location.clip).toBe("rate");
    expect(d?.data).toMatchObject({ source: 32000 });
  });

  it("is SILENT on a square-pixel source (aspect matches the timeline)", () => {
    const square: Clip = {
      kind: "clip",
      id: "sq",
      resource: "/footage/sq.mov",
      in: 0,
      out: 120,
      filters: [],
      extraProps: { aspect_ratio: "1" },
    };
    const tl = handTimeline(VERTICAL, [square]);
    expect(byCode(tl, "pixel-aspect-mismatch")).toBeUndefined();
  });

  it("is SILENT on a standard 48 kHz source", () => {
    const std: Clip = {
      kind: "clip",
      id: "std",
      resource: "/audio/std.wav",
      in: 0,
      out: 120,
      filters: [],
      extraProps: { frequency: "48000" },
    };
    const tl = handTimeline(VERTICAL, [std]);
    expect(byCode(tl, "sample-rate-mismatch")).toBeUndefined();
  });
});

// ─── 4. Redundant / self-cancelling filter stack ─────────────────────────────
describe("media: redundant-filter + self-cancelling-filters", () => {
  it("FIRES redundant-filter on two byte-identical static filters (info)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "dup",
            dur: 60,
            filters: [
              filter("brightness", { level: "0.5" }),
              filter("brightness", { level: "0.5" }), // identical → no-op
            ],
          }),
        ),
      ],
    });
    const d = byCode(tl, "redundant-filter");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("info");
    expect(d?.location.clip).toBe("dup");
    expect(d?.location.filter).toBe(1); // the SECOND (duplicate) filter
    expect(d?.data).toMatchObject({ duplicateOf: 0 });
    expect(d?.related?.[0]?.location.filter).toBe(0);
  });

  it("FIRES self-cancelling-filters on a 0.5 · 2 brightness pair (info)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "cancel",
            dur: 60,
            filters: [
              filter("brightness", { level: "0.5" }),
              filter("brightness", { level: "2" }), // 0.5 × 2 = 1 → net identity
            ],
          }),
        ),
      ],
    });
    const d = byCode(tl, "self-cancelling-filters");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("info");
    expect(d?.location.clip).toBe("cancel");
    expect(d?.location.filter).toBe(1);
    expect(d?.data).toMatchObject({ service: "brightness", a: 0.5, b: 2 });
    expect(d?.related?.[0]?.location.filter).toBe(0);
  });

  it("is SILENT on two DIFFERENT static filters (no duplicate, no cancel)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "ok",
            dur: 60,
            filters: [
              filter("brightness", { level: "0.8" }),
              filter("saturation", { level: "1.2" }),
            ],
          }),
        ),
      ],
    });
    expect(byCode(tl, "redundant-filter")).toBeUndefined();
    expect(byCode(tl, "self-cancelling-filters")).toBeUndefined();
  });

  it("is SILENT on two ANIMATED filters with the same service (they can compose)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "anim2",
            dur: 60,
            filters: [
              filter("brightness", { level: "0=0;11=1" }), // a fade ramp
              filter("brightness", { level: "0=1;59=0.5" }), // a different ramp
            ],
          }),
        ),
      ],
    });
    expect(byCode(tl, "redundant-filter")).toBeUndefined();
    expect(byCode(tl, "self-cancelling-filters")).toBeUndefined();
  });
});

// ─── 5. Dial value outside a known filter-param range ─────────────────────────
describe("media: dial-out-of-range", () => {
  // The FILTER dial-range checks (a brightness / volume / etc. dial past a modeled
  // range) moved to `checks/dials.ts` — catalog-backed against the real `melt -query`
  // ranges (e.g. brightness `level` 0..15, not a hand-guessed 0..4) — and are tested
  // in tests/dials.test.ts. The media checker keeps ONLY the first-class gain-FIELD
  // check (below), plus the silence guards proving it never spuriously fires on a
  // filter-bearing clip.
  it("is SILENT on an in-range brightness level (the corpus's 0..1 values)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "fine",
            dur: 60,
            filters: [filter("brightness", { level: "0.6" })],
          }),
        ),
      ],
    });
    expect(byCode(tl, "dial-out-of-range")).toBeUndefined();
  });

  it("is SILENT on a unit-bearing value (`20dB` is not a plain scalar)", () => {
    resetIds();
    // The corpus carries `max_gain = 20dB` on a volume filter; a unit token is
    // skipped by the static-scalar reader, so it is never range-checked.
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "db",
            dur: 60,
            filters: [filter("volume", { level: "1", max_gain: "20dB", window: 75 })],
          }),
        ),
      ],
    });
    expect(byCode(tl, "dial-out-of-range")).toBeUndefined();
  });

  it("is SILENT on an UNMODELED filter param (the table only covers known dials)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "unk",
            dur: 60,
            filters: [filter("some.unknown.filter", { weirdParam: "99999" })],
          }),
        ),
      ],
    });
    expect(byCode(tl, "dial-out-of-range")).toBeUndefined();
  });

  // ─── First-class Clip.gain FIELD (not a filter) — the field/filter parity gate ──
  // gain is a clip FIELD that only becomes a `volume`/`gain` filter at serialize
  // time, so the filter-loop range check never sees it. A nonsensical gain must
  // fire the SAME `dial-out-of-range` it would as a filter — otherwise the identical
  // value is caught in one form and silently missed in the other.
  it("FIRES on an out-of-range Clip.gain FIELD (1000 = +60 dB)", () => {
    resetIds();
    // The first-class gain FIELD: a nonsensical 1000 (+60 dB) must fire. The FILTER
    // form of the same value is the catalog dials checker's job (dials.test.ts).
    const asField = timeline(VERTICAL, {
      audio: [audioTrack(clip("/vo.wav", { id: "vg", dur: 120, gain: 1000 }))],
    });
    const d = byCode(asField, "dial-out-of-range");
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.location.clip).toBe("vg");
    // It addresses the FIELD (no filter index) and reports the gain value + flag.
    expect(d?.location.filter).toBeUndefined();
    expect(d?.data).toMatchObject({
      service: "gain",
      param: "gain",
      value: 1000,
      field: true,
      max: 8,
    });
  });

  it("is SILENT on an in-range Clip.gain field (the corpus's 0.8 mix level)", () => {
    resetIds();
    // 0.8 is the exact gain vean-multitrack's audio clip carries — must stay clean.
    const tl = timeline(VERTICAL, {
      audio: [audioTrack(clip("/vo.wav", { id: "vok", dur: 120, gain: 0.8 }))],
    });
    expect(byCode(tl, "dial-out-of-range")).toBeUndefined();
  });
});

// ─── Whole-checker discipline: a fully clean timeline emits NO media diagnostic ─
describe("media: a clean timeline emits zero media diagnostics", () => {
  it("a normal clip with a fade + an in-range graded filter is silent", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "clean",
            dur: 90,
            fadeIn: 12,
            fadeOut: 15,
            filters: [filter("brightness", { level: "1.1" })],
          }),
        ),
      ],
    });
    expect(mediaDiags(tl)).toEqual([]);
  });
});
