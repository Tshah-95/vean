// The dial-schema OVERRIDE table — the hand-curated patch over what `melt -query`
// publishes. melt's per-service metadata is authoritative but INCOMPLETE in three
// recurring ways the generator can't fix from the query alone:
//
//   1. ONE-SIDED ranges — a parameter ships a `minimum` with no `maximum` (or vice
//      versa), e.g. brightness `alpha` (`minimum: -1`, no max). melt means "no
//      upper bound"; sometimes there genuinely is one (a sane authoring ceiling).
//   2. MISSING ranges — a knob with neither bound published (most `float`/`integer`
//      params), where a real, documented admissible range exists in MLT's source /
//      Shotcut's filter UI (the spec we mine).
//   3. MISSING units — melt almost never publishes a unit; the unit sharpens the
//      diagnostic message and drives the right UI widget.
//
// Each override is keyed `service → param identifier` and merged OVER the queried
// schema by the generator (`./generate`): a present override field wins; an absent
// one leaves melt's value intact. Provenance is preserved — an overridden bound is
// stamped `source: "override"` so a reader can tell curated bounds from published
// ones. Keep this table SMALL and JUSTIFIED: only services vean emits/round-trips,
// only bounds with a real source. An over-tight curated max is a false-positive
// generator, which violates the zero-false-positive bar the dial check is held to,
// so prefer LEAVING a bound absent (unbounded) over guessing a ceiling.
import type { DialKind, DialUnit } from "./types";

/** A single parameter override: any subset of the curated fields. An absent field
 *  defers to melt's queried value; a present one overrides it. `min`/`max` may be
 *  set independently (to complete a one-sided range) or together (a full range melt
 *  omitted). `clearMax`/`clearMin` explicitly REMOVE a melt-published bound that is
 *  wrong (a sentinel like `0` that isn't a real ceiling). */
export type DialOverride = {
  min?: number;
  max?: number;
  /** Drop melt's published `maximum` (it is a sentinel, not a real ceiling). */
  clearMax?: boolean;
  /** Drop melt's published `minimum` (it is a sentinel, not a real floor). */
  clearMin?: boolean;
  unit?: DialUnit;
  /** Override the inferred value kind (rare — when melt's `type` is too loose). */
  kind?: DialKind;
};

/** `serviceIdentifier → paramIdentifier → override`. Only the curated entries; a
 *  service/param absent here takes melt's queried schema unchanged. */
export const DIAL_OVERRIDES: Record<string, Record<string, DialOverride>> = {
  // ── brightness — the fade primitive's underlying service. `level` is the
  // animated knob (0..15 in melt; 1 = unity, 0 = black). `alpha` ships a
  // one-sided `minimum: -1` (−1 = "follow level"); its real upper authoring
  // bound is 1 (opaque). Units: both are unitless ratios.
  brightness: {
    level: { unit: "ratio" }, // melt publishes 0..15 — keep, just unit it
    alpha: { max: 1, unit: "ratio" }, // complete the one-sided [-1, 1] range
  },

  // ── volume — the audio level service (the gain primitive compiles here). `level`
  // is the animated dB-or-ratio knob; melt publishes no bounds. `gain`/`max_gain`
  // are dB strings. We do NOT pin a numeric max on a dB string (it's not a plain
  // float), so the diagnostic leaves string dials alone — units are advisory.
  volume: {
    level: { unit: "decibel" },
    window: { min: 0, unit: "frame" }, // smoothing window, in frames, ≥ 0
  },

  // ── gain — the simple audio multiplier (some Shotcut chains use `gain` not
  // `volume`). `gain` is a unitless multiplier ≥ 0; `limiter`/`normalise` are dB.
  gain: {
    gain: { min: 0, unit: "ratio" },
    window: { min: 0, unit: "frame" },
  },

  // ── qtblend — the workhorse video compositing/transform transition. `rect` is a
  // geometry; `rotation` is degrees (melt publishes no bound — a rotation is
  // cyclic, so we leave it UNBOUNDED rather than guess ±360). `compositing` is the
  // Porter-Duff enum melt DOES publish via `values:` (the generator captures it).
  qtblend: {
    rotation: { unit: "degree" },
    opacity: { min: 0, max: 1, unit: "ratio" }, // 0..1 opacity, if present
  },

  // ── affine — the transform/position escape-hatch filter. Its real knobs live
  // under the `transition.*` wildcard bag (melt types that `properties`); we unit
  // the few flat ones we round-trip.
  affine: {
    // (no flat numeric knobs to bound; the geometry lives in transition.rect)
  },

  // ── luma — the same-track dissolve's wipe service. `softness` is a 0..1 edge
  // feather; `frequency`/`bands` are wipe-pattern knobs.
  luma: {
    softness: { min: 0, max: 1, unit: "ratio" },
  },

  // ── mix — the audio cross-fade transition. `start`/`end` are 0..1 mix levels.
  mix: {
    start: { min: 0, max: 1, unit: "ratio" },
    end: { min: 0, max: 1, unit: "ratio" },
  },

  // ── oldfilm / grain — the stylize filters in the corpus. Their intensity knobs
  // are percentages melt under-specifies.
  oldfilm: {
    delta: { unit: "ratio" },
    every: { min: 0, unit: "frame" },
  },
  grain: {
    noise: { min: 0, unit: "ratio" },
  },
};
