// The DIALS schema — the typed knob model for an MLT service's parameters. A
// "dial" is one tunable parameter (a filter/transition property): its value
// kind, its admissible range, its unit, its default, and whether it animates.
// This is the spec the dial-range diagnostic checks a clip's filter properties
// against, and the schema a future UI draws sliders/pickers from.
//
// PROVENANCE. The catalog is GENERATED from `melt -query` (the authoritative
// per-service schema MLT ships) and then MERGED with a small hand-curated
// override table (`./overrides`) that fills the gaps melt's metadata leaves —
// one-sided ranges (`minimum` with no `maximum`), missing units, and the handful
// of services whose ranges melt does not publish at all. The generator
// (`./generate`, a subprocess tool) writes the static `./catalog` data; the pure
// engine (`src/ir`, `src/diagnostics`) only ever READS that static data, so it
// stays I/O-free and deterministic (Hard boundary #3 — no subprocess on the pure
// path). `melt -query` is the source of truth; the override table is the patch.
//
// Two invariants thread through, matching the IR proper:
//   • Ranges are NUMERIC bounds in the parameter's own unit — never a float fps,
//     never a frame count masquerading as a ratio.
//   • A dial is referred to by its stable `identifier` (the MLT property name),
//     never an index — the same stable-identity rule the rest of the IR follows.
import { z } from "zod";

// ─── Dial value kinds ────────────────────────────────────────────────────────
/** The value family a dial carries, lifted from melt's `type` field and narrowed
 *  to the kinds vean reasons about. `float`/`integer` are range-checkable scalars;
 *  `boolean` is 0/1; `string`/`color`/`rect`/`geometry` are structured/opaque
 *  values the range check does not bound (it only validates them when an override
 *  supplies an enum or pattern). `properties` is melt's wildcard bag (`producer.*`)
 *  — never range-checked, carried so the catalog is COMPLETE (a UI can still list
 *  it) without the diagnostic ever firing on it. */
export const dialKind = z.enum([
  "float",
  "integer",
  "boolean",
  "string",
  "color",
  "rect",
  "geometry",
  "properties",
]);
export type DialKind = z.infer<typeof dialKind>;

// ─── A unit (advisory, for the UI + human-readable diagnostics) ───────────────
/** The physical/semantic unit a dial's number is expressed in, when known. Most
 *  come from the override table (melt rarely publishes units). Advisory only — the
 *  range check uses the numeric bounds, not the unit; the unit sharpens the human
 *  message ("level 30 exceeds maximum 15" vs "… 15 (gain ×)"). */
export const dialUnit = z.enum([
  "ratio", // a unitless multiplier (brightness level, gain ×)
  "percent", // 0..100 (or 0..1 with a percent flag)
  "decibel", // dB (audio level/limit)
  "degree", // rotation
  "pixel", // a length in pixels
  "frame", // a frame count/index
  "second", // a duration in seconds
  "hertz", // a frequency
  "index", // an enum/mode selector (0,1,2,…)
]);
export type DialUnit = z.infer<typeof dialUnit>;

// ─── An enum option (for a `values:`-bearing parameter) ───────────────────────
/** One admissible value of an enumerated dial (melt's `values:` list, e.g.
 *  `0 (source over)`). `value` is the wire value; `label` the human gloss. The
 *  range check, for an enum dial, validates membership instead of numeric bounds. */
export const dialOption = z.object({
  value: z.union([z.number(), z.string()]),
  label: z.string().optional(),
});
export type DialOption = z.infer<typeof dialOption>;

// ─── One dial (one tunable parameter) ─────────────────────────────────────────
/** A single tunable parameter of a service. `identifier` is the stable MLT
 *  property name (the key under a filter's `properties`). `min`/`max` are the
 *  admissible numeric bounds when known (either or both may be absent — a
 *  one-sided or unbounded dial); the diagnostic only fires when a value falls
 *  OUTSIDE a present bound, so an absent bound is "no upper/lower limit," never a
 *  false positive. `options`, when present, makes this an enum (membership-checked
 *  instead of range-checked). `animation` mirrors melt's `animation: yes` — an
 *  animated dial's value may be a keyframe string, which the diagnostic resolves
 *  through the keyframe engine before bounds-checking. `deprecated` flags a knob
 *  melt marks `(*DEPRECATED*)` — kept for completeness, never recommended. */
export const dial = z.object({
  /** Stable MLT property name (the `properties` key on a filter/transition). */
  identifier: z.string().min(1),
  /** Human title from melt (`title:`). */
  title: z.string().optional(),
  /** The value family (narrowed from melt's `type:`). */
  kind: dialKind,
  /** Admissible lower bound in the dial's unit, when known. */
  min: z.number().optional(),
  /** Admissible upper bound in the dial's unit, when known. */
  max: z.number().optional(),
  /** The default value melt ships, when published. */
  default: z.union([z.number(), z.string(), z.boolean()]).optional(),
  /** The dial's unit, when known (mostly from the override table). */
  unit: dialUnit.optional(),
  /** Enumerated admissible values (melt's `values:` list), when this is an enum. */
  options: z.array(dialOption).optional(),
  /** True iff melt marks the parameter animatable (`animation: yes`). */
  animation: z.boolean().optional(),
  /** True iff melt marks the parameter `(*DEPRECATED*)`. */
  deprecated: z.boolean().optional(),
  /** Where a bound/unit came from: `melt` (published) or `override` (curated). */
  source: z.enum(["melt", "override"]).optional(),
});
export type Dial = z.infer<typeof dial>;

// ─── One service (a filter or transition) and its dials ───────────────────────
/** The kind of MLT service a dial schema describes. vean range-checks `filter`
 *  (clip-attached) and `transition` (field-level) services; `producer`/`consumer`
 *  schemas are out of the dial diagnostic's scope. */
export const serviceKind = z.enum(["filter", "transition", "producer", "consumer"]);
export type ServiceKind = z.infer<typeof serviceKind>;

/** A whole service's dial schema: its MLT `identifier` (the `mlt_service` value a
 *  filter/transition carries) + its parameters keyed by identifier. `dials` is an
 *  ORDERED map (melt's parameter order) so the catalog serializes deterministically
 *  and a UI lists knobs in the author's expected order. */
export const dialService = z.object({
  identifier: z.string().min(1),
  kind: serviceKind,
  title: z.string().optional(),
  /** Schema version melt reported (`schema_version:`), for provenance. */
  schemaVersion: z.string().optional(),
  dials: z.array(dial).default([]),
});
export type DialService = z.infer<typeof dialService>;

// ─── The catalog (identifier → service schema) ────────────────────────────────
/** The whole dial catalog: every generated/curated service, keyed by its MLT
 *  `identifier`. Stored as a static object literal in `./catalog` (generated by
 *  `./generate`), validated by this schema, and read by the dial-range diagnostic
 *  + the future dials UI. */
export const dialCatalog = z.record(z.string(), dialService);
export type DialCatalog = z.infer<typeof dialCatalog>;
