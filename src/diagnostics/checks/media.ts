// Media / lint diagnostics — the asset + signal-path layer. Where `structural`
// catches an UNSERIALIZABLE timeline and `sync` catches A/V TIMING hazards, this
// checker catches MEDIA hazards: a frame scaled past the canvas (soft upscale), a
// log/wide-gamut source dropped on a Rec.709 timeline with no LUT, a pixel-aspect
// or audio-sample-rate that needs a resample, a filter stack that does nothing (a
// pair that cancels, or a literal duplicate), and a dial turned past a parameter's
// known range. These are the "lint" rules: the render succeeds, but the result is
// wrong or wasteful.
//
// Pure: reads the IR, returns Diagnostics, no I/O, no mutation (AGENTS.md Hard
// boundary #3 — the engine is stateless). CONSERVATIVE to the bone: each rule
// fires ONLY on an explicit, statically-determinable defect and is SILENT on every
// clean corpus file (the no-false-positive gate — a diagnostic on a valid timeline
// FAILS the Move-1 gate). The discipline that buys that silence:
//   - We read facts the IR ALREADY carries — a clip's verbatim `extraProps`
//     (`aspect_ratio`, `sample_rate`, `colorspace`/`color_trc`), its filter list,
//     and explicit PIXEL rects in a scale filter — never a probe of the media. A
//     fact the IR doesn't carry (the real source resolution, the true source fps)
//     is left to the DRIVER layer (which has I/O), surfaced through this same
//     `Diagnostic` type. No rule guesses.
//   - A value we can't read as an unambiguous static scalar (an ANIMATED string, a
//     unit-bearing token like `20dB`, a `%`-relative rect) is SKIPPED, never
//     flagged. Uncertainty is silence.
//
// FINALIZED SIGNATURE. `media: Checker` is the stable registry contract; the
// in-IR rules below are LIVE. The two rules that genuinely need I/O — a dangling
// FILE ref (the path is gone from disk) and upscaling from a SMALLER SOURCE (the
// file's pixel dimensions) — stay the DRIVER's job (see the `// TODO(driver)`
// markers); this checker handles the in-IR slice of each (an EMPTY resource; an
// explicit over-canvas scale FILTER) so the moment the driver lands its probe the
// two halves compose under one code family.
import { FADE_IN_SERVICE, FADE_OUT_SERVICE } from "../../ir/builder";
import { isAnimated } from "../../ir/keyframes";
import type { Clip, Filter, Profile, Timeline, Track } from "../../ir/types";
import { type Diagnostic, type DiagnosticInput, diag } from "../types";

// ─── Shared value readers (deliberately strict — uncertainty ⇒ silence) ──────

/** Read a property value as a finite static scalar, or `null` if it is anything
 *  uncertain: an ANIMATED string (contains `=`), a unit-bearing token (`20dB`,
 *  `100%`), or any non-numeric text. Strictness is the no-false-positive guard —
 *  a value we can't read as a plain number we do not judge. */
function staticScalar(value: string | number): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const s = value.trim();
  if (s === "") return null;
  if (isAnimated(s)) return null; // an animation string — out of scope here
  // A bare scalar only: reject anything carrying a unit, a percent, or extra text
  // (so `20dB`, `100%`, `normal` all read as "not a plain number" → skipped).
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Read a property value (string or number) as a lowercased string for substring
 *  matching (colorspace tags). Numbers stringify; everything trims. */
function asText(value: string | number): string {
  return String(value).trim().toLowerCase();
}

// ─── 1. Upscaling past 100% of the canvas (in-IR slice: an explicit scale) ───
// The DRIVER owns the "source file is smaller than the canvas" case (it needs the
// file's pixel dimensions — an ffprobe). The in-IR slice we CAN judge without I/O:
// a geometry filter (`affine`/`qtblend`/`affine.rect`/`transition.rect`) whose
// STATIC, PIXEL-valued rect is wider or taller than the project canvas — the
// author explicitly scaled the frame past 100%. We read ONLY a fully static rect
// in PIXELS; a `%` rect or an animated rect is skipped (its peak needs evaluation
// the driver/query owns), so the corpus's `%` qtblend and animated affine rects
// never trip this.
const RECT_PROPS = new Set(["rect", "transition.rect", "affine.rect", "geometry"]);

/** Parse a STATIC pixel rect `"x y w h [opacity]"` → `{w,h}`, or `null` if the
 *  string is animated, percent-based, or not a 4+ number rect. */
function staticPixelRect(value: string | number): { w: number; h: number } | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s === "" || isAnimated(s)) return null; // animated rect: not our call
  if (s.includes("%")) return null; // percent rect is canvas-relative — never an upscale
  const parts = s.split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length < 4) return null;
  // w,h are the 3rd/4th components; require BOTH to be plain integers/decimals.
  const wTok = parts[2];
  const hTok = parts[3];
  if (wTok == null || hTok == null) return null;
  const w = staticScalar(wTok);
  const h = staticScalar(hTok);
  if (w == null || h == null) return null;
  return { w, h };
}

function checkUpscaling(clip: Clip, track: Track, profile: Profile): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  clip.filters.forEach((f, fi) => {
    for (const [key, raw] of Object.entries(f.properties)) {
      if (!RECT_PROPS.has(key)) continue;
      const rect = staticPixelRect(raw);
      if (!rect) continue;
      if (rect.w > profile.width || rect.h > profile.height) {
        out.push(
          diag({
            code: "upscaling-past-canvas",
            severity: "warning",
            message: `clip "${clip.id}" filter ${f.service}.${key} scales the frame to ${rect.w}×${rect.h}, past the ${profile.width}×${profile.height} canvas — the extra pixels are cropped and a sub-100% source would be soft`,
            location: { clip: clip.id, track: track.id, filter: fi },
            fix: `keep the scaled size within ${profile.width}×${profile.height}`,
            data: {
              width: rect.w,
              height: rect.h,
              canvasWidth: profile.width,
              canvasHeight: profile.height,
            },
          }),
        );
        break; // one per filter is enough signal
      }
    }
  });
  return out;
}

// ─── 2. Colorspace mismatch (log / wide gamut on Rec.709 with no LUT) ────────
// A clip can carry a colorspace hint VERBATIM in `extraProps` (Shotcut/melt write
// `color_trc`, `colorspace`, `color_primaries`, or a `mlt_image_format` note when
// they know the source is log or wide-gamut). If the TIMELINE is Rec.709
// (profile.colorspace 709 — every preset) and a clip declares a log/wide-gamut
// source but carries NO LUT/colorspace-correcting filter, the picture renders
// flat/wrong. We fire ONLY when a recognized log/wide-gamut TOKEN is explicitly
// present AND no LUT filter is attached — so a clip with no colorspace metadata
// (the whole clean corpus) is silent.
const COLORSPACE_HINT_KEYS = ["color_trc", "colorspace", "color_primaries", "color_space"];
/** Tokens that name a LOG transfer or a WIDE gamut needing conversion to 709. */
const LOG_WIDE_TOKENS = [
  "log", // s-log, v-log, c-log, log3, arri logc, "log"
  "slog",
  "vlog",
  "logc",
  "hlg", // hybrid log-gamma (HDR)
  "pq", // smpte2084 / perceptual quantizer (HDR)
  "smpte2084",
  "bt2020", // Rec.2020 wide gamut
  "rec2020",
  "2020",
];
/** Filter services that APPLY a LUT / colorspace conversion (presence clears the
 *  mismatch — the author handled it). */
const LUT_SERVICES = [
  "lut3d",
  "lut",
  "frei0r.coloradj_rgb",
  "avfilter.lut3d",
  "movit.lift_gamma_gain",
];

function hasLutFilter(clip: Clip): boolean {
  return clip.filters.some((f) => {
    const svc = f.service.toLowerCase();
    if (LUT_SERVICES.some((l) => svc.includes(l))) return true;
    // A filter explicitly named like a LUT in its Shotcut label also counts.
    const name = (f.shotcutName ?? "").toLowerCase();
    return name.includes("lut");
  });
}

function checkColorspace(clip: Clip, track: Track, profile: Profile): DiagnosticInput[] {
  if (profile.colorspace !== 709) return []; // only flag a mismatch AGAINST a 709 timeline
  const extra = clip.extraProps;
  if (!extra) return [];
  for (const key of COLORSPACE_HINT_KEYS) {
    const v = extra[key];
    if (v == null) continue;
    const text = asText(v);
    const hit = LOG_WIDE_TOKENS.find((t) => text.includes(t));
    if (!hit) continue;
    if (hasLutFilter(clip)) return []; // the author applied a LUT — handled
    return [
      diag({
        code: "colorspace-mismatch",
        severity: "warning",
        message: `clip "${clip.id}" declares a log / wide-gamut source (${key}=${String(v)}) on a Rec.709 timeline with no LUT or colorspace filter — it will render flat/washed`,
        location: { clip: clip.id, track: track.id },
        fix: "add a LUT / colorspace-conversion filter, or set the timeline colorspace to match",
        data: { hint: key, value: String(v) },
      }),
    ];
  }
  return [];
}

// ─── 3. Pixel-aspect / audio sample-rate mismatch (needs a resample) ─────────
// A clip can carry its source pixel (sample) aspect or audio sample rate VERBATIM
// in `extraProps` (`aspect_ratio` / `sample_aspect`; `frequency` / `sample_rate`).
// When the source value differs from the project profile, melt silently resamples
// — a quality cost the author may not intend. We read ONLY an explicit, static,
// numeric hint and compare to the profile; absent or non-numeric hints (the clean
// corpus, whose clips carry none) are silent.
const PIXEL_ASPECT_KEYS = ["aspect_ratio", "sample_aspect", "sample_aspect_ratio"];
const SAMPLE_RATE_KEYS = ["frequency", "sample_rate", "audio_sample_rate"];

function checkAspectAndRate(clip: Clip, track: Track, profile: Profile): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  const extra = clip.extraProps;
  if (!extra) return out;

  // 3a. Pixel (sample) aspect. The profile's sample aspect is `num/den`; a clip
  //     `aspect_ratio` is melt's pixel-aspect ratio as a single number. Compare
  //     with a small epsilon (floating ratios) — only a genuine difference fires.
  const profileSar = profile.sampleAspectNum / profile.sampleAspectDen;
  for (const key of PIXEL_ASPECT_KEYS) {
    const v = extra[key];
    if (v == null) continue;
    const n = staticScalar(v);
    if (n == null || n <= 0) continue;
    if (Math.abs(n - profileSar) > 1e-3) {
      out.push(
        diag({
          code: "pixel-aspect-mismatch",
          severity: "warning",
          message: `clip "${clip.id}" pixel aspect ${n} differs from the timeline's ${profileSar} (${profile.sampleAspectNum}:${profile.sampleAspectDen}) — melt resamples it, distorting geometry`,
          location: { clip: clip.id, track: track.id },
          fix: "match the source pixel aspect to the timeline, or accept the resample",
          data: { source: n, timeline: profileSar },
        }),
      );
      break;
    }
  }

  // 3b. Audio sample rate. The IR profile has no sample-rate field (it is an
  //     audio-graph property melt fixes at render), but a clip can DECLARE its
  //     source rate; we flag a NON-STANDARD rate that forces a resample off the
  //     two ubiquitous targets (48000 / 44100). Conservative: a clip already at a
  //     standard rate is silent.
  const STANDARD_RATES = new Set([48000, 44100]);
  for (const key of SAMPLE_RATE_KEYS) {
    const v = extra[key];
    if (v == null) continue;
    const n = staticScalar(v);
    if (n == null || n <= 0) continue;
    if (!STANDARD_RATES.has(n)) {
      out.push(
        diag({
          code: "sample-rate-mismatch",
          severity: "warning",
          message: `clip "${clip.id}" audio sample rate ${n} Hz is non-standard — melt resamples it to the project rate, which can soften transients`,
          location: { clip: clip.id, track: track.id },
          fix: "conform the source to 48000 Hz (or accept the resample)",
          data: { source: n },
        }),
      );
      break;
    }
  }
  return out;
}

// ─── 4. Redundant / self-cancelling filter stack ─────────────────────────────
// Two filter defects detectable from the list alone, both wasted work:
//   (a) DUPLICATE — two filters with the same service AND byte-identical static
//       properties (the second is a no-op layered on the first). Animated filters
//       are skipped (two animated passes can legitimately compose).
//   (b) SELF-CANCELLING — a known inverse PAIR whose static dials cancel (e.g. two
//       `brightness` levels whose product is 1: 0.5 then 2.0 → identity). We model
//       only the cases we can prove cancel; anything uncertain is silent.
// Fade SENTINELS are excluded (a fade-in + fade-out are not a redundant pair).

/** A stable signature of a filter for duplicate detection: service + its static
 *  properties serialized in a canonical (sorted) order. Returns `null` if ANY
 *  property is animated (we don't dedup animated filters — they can compose). */
function staticSignature(f: Filter): string | null {
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(f.properties)) {
    const s = String(v);
    if (isAnimated(s)) return null; // an animated filter — never call it a duplicate
    entries.push([k, s]);
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return `${f.service}|${entries.map(([k, v]) => `${k}=${v}`).join(";")}`;
}

function isFadeSentinel(f: Filter): boolean {
  return f.service === FADE_IN_SERVICE || f.service === FADE_OUT_SERVICE;
}

function checkRedundantFilters(clip: Clip, track: Track): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  const filters = clip.filters;

  // (a) Exact duplicates (same service + identical static props).
  const seen = new Map<string, number>();
  filters.forEach((f, fi) => {
    if (isFadeSentinel(f)) return;
    const sig = staticSignature(f);
    if (sig == null) return; // animated — skip
    const first = seen.get(sig);
    if (first != null) {
      out.push(
        diag({
          code: "redundant-filter",
          severity: "info",
          message: `clip "${clip.id}" has a duplicate ${f.service} filter at index ${fi} — identical to the one at index ${first}, so it does nothing`,
          location: { clip: clip.id, track: track.id, filter: fi },
          fix: "remove the duplicate filter",
          related: [
            {
              location: { clip: clip.id, track: track.id, filter: first },
              message: "the original filter",
            },
          ],
          data: { service: f.service, duplicateOf: first },
        }),
      );
    } else {
      seen.set(sig, fi);
    }
  });

  // (b) Self-cancelling multiplicative pair: two `brightness`/`volume` filters
  //     whose static scalar `level` multiplies to ~1 (gain up then exactly back
  //     down). Only fires when BOTH levels are plain static scalars > 0.
  const MULT_IDENTITY_SERVICES = new Set(["brightness", "volume", "gain"]);
  const levels: { fi: number; service: string; level: number }[] = [];
  filters.forEach((f, fi) => {
    if (isFadeSentinel(f)) return;
    if (!MULT_IDENTITY_SERVICES.has(f.service)) return;
    const raw = f.properties.level ?? f.properties.gain;
    if (raw == null) return;
    const n = staticScalar(raw);
    if (n == null || n <= 0) return;
    levels.push({ fi, service: f.service, level: n });
  });
  for (let i = 0; i < levels.length; i++) {
    const a = levels[i];
    if (a == null) continue;
    for (let j = i + 1; j < levels.length; j++) {
      const b = levels[j];
      if (b == null) continue;
      if (a.service !== b.service) continue;
      // Skip the trivial 1×1 (two unity passes) — that's the DUPLICATE rule's job,
      // not a "cancelling" pair; flag only a genuine up-then-down (e.g. 0.5 · 2).
      if (a.level === 1 || b.level === 1) continue;
      if (Math.abs(a.level * b.level - 1) < 1e-6) {
        out.push(
          diag({
            code: "self-cancelling-filters",
            severity: "info",
            message: `clip "${clip.id}" ${a.service} filters at indices ${a.fi} and ${b.fi} cancel out (${a.level} × ${b.level} = 1) — the pair has no net effect`,
            location: { clip: clip.id, track: track.id, filter: b.fi },
            fix: "remove both filters — they undo each other",
            related: [
              {
                location: { clip: clip.id, track: track.id, filter: a.fi },
                message: "the other half of the cancelling pair",
              },
            ],
            data: { service: a.service, a: a.level, b: b.level },
          }),
        );
      }
    }
  }
  return out;
}

// ─── 5. Dial value outside a known filter-param range ────────────────────────
// A small, EXTENSIBLE table of the parameter ranges we model TODAY (the full
// `melt -query` catalog is Move 5 — ROADMAP "Move 5+"). Each entry is a filter
// service → param → `[min, max]` (a bound omitted = one-sided). We check ONLY a
// STATIC scalar value against an entry that EXISTS in the table; an unmodeled
// param, an animated value, or a unit-bearing token is skipped — so adding a row
// can only ADD coverage, never a false positive on existing corpus values.
type Range = { min?: number; max?: number; unit?: string };
const PARAM_RANGES: Record<string, Record<string, Range>> = {
  // brightness `level`: a non-negative multiplier (1 = unity). Shotcut's UI caps
  // the slider at 200% (level 2.0); we use a generous 0..4 so a real grade never
  // trips while a nonsensical negative / >4 does. (corpus values are 0..1.)
  brightness: { level: { min: 0, max: 4 } },
  // volume / gain `level`: a non-negative multiplier; > 8× (≈ +18 dB) is almost
  // always an error. A `level` carrying a `dB` unit string is skipped by
  // staticScalar (so the corpus's `20dB` max_gain never trips).
  volume: { level: { min: 0, max: 8 }, gain: { min: 0, max: 8 } },
  gain: { gain: { min: 0, max: 8 } },
  // opacity-style 0..1 dials seen on common filters.
  "frei0r.alpha0ps": { alpha: { min: 0, max: 1 } },
};

/** The audio-gain range, shared by the `volume`/`gain` FILTER check and the
 *  first-class `Clip.gain` FIELD check below — one source of truth so the same
 *  nonsensical multiplier is judged identically whichever form it lives in. */
const GAIN_RANGE: Range = PARAM_RANGES.gain?.gain ?? { min: 0, max: 8 };

function checkDialRanges(clip: Clip, track: Track): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  // The first-class `Clip.gain` FIELD. Gain is modeled as a clip field that only
  // becomes a `volume`/`gain` FILTER at serialize time (serialize.ts gainFilters),
  // so the filter loop below never sees it — yet `gain: 1000` (+60 dB) is exactly
  // as nonsensical as `filter("volume", { level: 1000 })`, which DOES fire. Check
  // the field directly against the SAME range so the two forms agree (the gain Op
  // and a hand/IR-set multiplier both bypass any clamp — this is the only place the
  // field's range is enforced). Gain is always a static number on the IR field.
  if (clip.gain != null) {
    const g = clip.gain;
    const belowMin = GAIN_RANGE.min != null && g < GAIN_RANGE.min;
    const aboveMax = GAIN_RANGE.max != null && g > GAIN_RANGE.max;
    if (belowMin || aboveMax) {
      const bound = belowMin ? `min ${GAIN_RANGE.min}` : `max ${GAIN_RANGE.max}`;
      out.push(
        diag({
          code: "dial-out-of-range",
          severity: "warning",
          message: `clip "${clip.id}" gain = ${g} is outside its known range [${GAIN_RANGE.min ?? "−∞"}, ${GAIN_RANGE.max ?? "∞"}] (past ${bound}) — it compiles to a volume filter at that multiplier`,
          location: { clip: clip.id, track: track.id },
          fix: `set the clip's gain within [${GAIN_RANGE.min ?? "−∞"}, ${GAIN_RANGE.max ?? "∞"}]`,
          data: {
            service: "gain",
            param: "gain",
            value: g,
            field: true,
            ...(GAIN_RANGE.min != null ? { min: GAIN_RANGE.min } : {}),
            ...(GAIN_RANGE.max != null ? { max: GAIN_RANGE.max } : {}),
          },
        }),
      );
    }
  }
  clip.filters.forEach((f, fi) => {
    const table = PARAM_RANGES[f.service];
    if (!table) return;
    for (const [param, range] of Object.entries(table)) {
      const raw = f.properties[param];
      if (raw == null) continue;
      const n = staticScalar(raw);
      if (n == null) continue; // animated / unit-bearing / non-numeric → skip
      const belowMin = range.min != null && n < range.min;
      const aboveMax = range.max != null && n > range.max;
      if (belowMin || aboveMax) {
        const bound = belowMin ? `min ${range.min}` : `max ${range.max}`;
        out.push(
          diag({
            code: "dial-out-of-range",
            severity: "warning",
            message: `clip "${clip.id}" filter ${f.service}.${param} = ${n} is outside its known range [${range.min ?? "−∞"}, ${range.max ?? "∞"}] (past ${bound})`,
            location: { clip: clip.id, track: track.id, filter: fi },
            fix: `set ${f.service}.${param} within [${range.min ?? "−∞"}, ${range.max ?? "∞"}]`,
            data: {
              service: f.service,
              param,
              value: n,
              ...(range.min != null ? { min: range.min } : {}),
              ...(range.max != null ? { max: range.max } : {}),
            },
          }),
        );
      }
    }
  });
  return out;
}

// TODO(driver): dangling FILE ref — the resource is a path that doesn't exist on
// disk. A filesystem stat, which the diagnostics engine forbids (no I/O). The
// DRIVER (`src/driver`) probes the media and surfaces a `missing-media-file`
// Diagnostic through this same type, merged into the set by a caller that has I/O.
//
// TODO(driver): upscaling from a SMALLER SOURCE — the source frame is smaller than
// the canvas, so melt scales it up (soft). Needs the source resolution (an
// ffprobe); the driver surfaces it under the SAME `upscaling-past-canvas` family
// as the in-IR scale-filter slice above, so the two compose.

/** A clip with no resource string points at nothing — a structurally dangling
 *  reference detectable WITHOUT I/O (a missing FILE is a driver-layer probe, but
 *  an EMPTY resource is a graph defect). The IR Zod schema requires
 *  `resource.min(1)`, so this only trips an in-progress / hand-built state the LSP
 *  may hold before validation — a cheap, I/O-free guard. */
function checkEmptyResource(clip: Clip, track: Track): DiagnosticInput[] {
  if (clip.resource && clip.resource.trim() !== "") return [];
  return [
    diag({
      code: "dangling-resource",
      severity: "error",
      message: `clip "${clip.id}" has an empty resource — it references no media`,
      location: { clip: clip.id, track: track.id },
      fix: "set the clip's resource to a media path or a color spec",
    }),
  ];
}

/** The media checker: run every in-IR media/lint rule over every clip. */
export function media(state: Timeline): Diagnostic[] {
  const out: DiagnosticInput[] = [];
  const profile = state.profile;
  for (const track of [...state.tracks.video, ...state.tracks.audio]) {
    for (const it of track.items) {
      if (it.kind !== "clip") continue;
      out.push(...checkEmptyResource(it, track));
      out.push(...checkUpscaling(it, track, profile));
      out.push(...checkColorspace(it, track, profile));
      out.push(...checkAspectAndRate(it, track, profile));
      out.push(...checkRedundantFilters(it, track));
      out.push(...checkDialRanges(it, track));
    }
  }
  // The registry stamps `source`; attach a placeholder so the type is a full
  // Diagnostic for the registry to finalize.
  return out.map((d) => ({ ...d, source: "media" }));
}
