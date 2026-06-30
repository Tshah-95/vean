// The vean intermediate representation — the typed video *document*. This is the
// EXTENDED IR: where studio's seed was a single ordered list of items on one
// implicit playlist, vean models the real MLT shape — a `<tractor>` of multiple
// `<playlist>` tracks (video + audio), explicit audio clips with gain, first-
// class filters and field-level transitions, and keyframe-bearing property
// strings. Everything is Zod-validated so a malformed timeline fails loudly,
// before `melt` ever runs, with a message pointing at the offending field.
//
// Two hard invariants thread through every type here (see AGENTS.md):
//   1. Frame-exact RATIONAL time. fps is `[num, den]` — 29.97 is `[30000,1001]`,
//      never the float `29.97`. Positions / in / out / length are INTEGER frames.
//   2. Stable identity. A clip is referred to by its `id` (a stable uuid-like
//      string), never by its ordinal index — indices are ephemeral.
//
// No `@/brand` coupling: colors are plain strings (`"#RRGGBB"`, `"#AARRGGBB"`,
// or a CSS color name). There is no palette lookup and nothing imported from
// outside this repo.
import { z } from "zod";

// ─── Primitives ──────────────────────────────────────────────────────────
/** A non-negative integer frame index/count. The atom of time in the IR. */
export const frame = z.number().int().nonnegative();
/** A signed integer frame (a property string may carry a negative time, e.g.
 *  `-1` = length-1; used inside animation strings, not as a track position). */
export const signedFrame = z.number().int();

/** A rational frame rate `[num, den]`. 30 = `[30,1]`, 29.97 = `[30000,1001]`,
 *  23.976 = `[24000,1001]`. NEVER a float — a float fps makes every downstream
 *  diagnostic subtly, permanently wrong. */
export const fpsSchema = z
  .tuple([z.number().int().positive(), z.number().int().positive()])
  .describe("rational fps [num, den]");
export type Fps = z.infer<typeof fpsSchema>;

// ─── Profile ─────────────────────────────────────────────────────────────
// The canvas a timeline renders onto — dimensions, rational fps, display aspect,
// pixel (sample) aspect, colorspace. A profile is NOT brand: the target platform
// decides 9:16 vs 16:9, not the palette. Presets live in `./profile`.
export const profileSchema = z.object({
  /** Free-form melt profile description (shown in the .mlt <profile>). */
  description: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  /** Rational frame rate `[num, den]`. */
  fps: fpsSchema,
  /** 1 = progressive, 0 = interlaced. */
  progressive: z.union([z.literal(0), z.literal(1)]).default(1),
  sampleAspectNum: z.number().int().positive().default(1),
  sampleAspectDen: z.number().int().positive().default(1),
  displayAspectNum: z.number().int().positive(),
  displayAspectDen: z.number().int().positive(),
  /** melt colorspace integer (601, 709, 240, …). */
  colorspace: z.number().int().positive().default(709),
});
export type Profile = z.infer<typeof profileSchema>;

// ─── Filter ──────────────────────────────────────────────────────────────
// An MLT `<filter>` attached to a clip (or, later, a track): a service name +
// its properties. A property value is a string or number; an ANIMATED property
// is an MLT animation string — its value contains an `=` (e.g. `"0=0;11=1"`).
// The keyframe model (`./keyframes`) parses/serializes those strings; this type
// stores them verbatim so an un-wrapped service round-trips losslessly.
export const propertyValue = z.union([z.string(), z.number()]);
export type PropertyValue = z.infer<typeof propertyValue>;

export const filterSchema = z.object({
  service: z.string().min(1),
  properties: z.record(z.string(), propertyValue).default({}),
  /** Shotcut tags a filter with a logical name via `shotcut:filter`; preserved
   *  for round-trip fidelity when present. */
  shotcutName: z.string().optional(),
});
export type Filter = z.infer<typeof filterSchema>;

// ─── Provenance ────────────────────────────────────────────────────────────
// Where a clip's media came from — pinned to the clip so it survives EXPORT
// (the thing Palmier's lossy `.palmier`→NLE-XML path drops). `source` is the
// only required field; the rest describe a generative/captured origin so the
// agent (or a UI) can regenerate-in-place. Modeled as a first-class field (like
// `gain`/`label`) — NOT `extraProps` — and round-tripped through serialize/parse
// as namespaced `<property name="vean:provenance.*">` producer children, so it
// neither double-emits nor pollutes the generic extra-props map.
export const provenanceSource = z.enum(["import", "generative", "capture", "remotion"]);
export type ProvenanceSource = z.infer<typeof provenanceSource>;

export const provenanceSchema = z.object({
  /** How this clip's media originated. The only required field. */
  source: provenanceSource,
  /** Generative model id (e.g. a Veo/Kling/Runway model), when generated. */
  model: z.string().optional(),
  /** The prompt that produced the media, when generated. */
  prompt: z.string().optional(),
  /** Reference inputs (image/clip paths or ids) fed to the generator. */
  references: z.array(z.string()).optional(),
  /** The producing tool/surface (e.g. a CLI/MCP action id or app name). */
  tool: z.string().optional(),
  /** ISO-8601 timestamp the media was created/imported. */
  createdAt: z.string().optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/** The `<property>` namespace prefix carrying provenance on a producer. Shared by
 *  serialize + parse so the two halves never drift on the wire name. */
export const PROVENANCE_PROP_PREFIX = "vean:provenance.";

/** Encode a `Provenance` into ordered `[name, value]` producer-property pairs. The
 *  field order is fixed (schema order) so emission is deterministic; the array
 *  references are joined with `,` (no provenance reference may itself contain a
 *  comma — they are media paths/ids). Scalars stringify as-is. A round-trip with
 *  `decodeProvenance` is a fixpoint for every value the schema admits. */
export function encodeProvenanceProps(p: Provenance): Array<[string, string]> {
  const out: Array<[string, string]> = [[`${PROVENANCE_PROP_PREFIX}source`, p.source]];
  if (p.model != null) out.push([`${PROVENANCE_PROP_PREFIX}model`, p.model]);
  if (p.prompt != null) out.push([`${PROVENANCE_PROP_PREFIX}prompt`, p.prompt]);
  if (p.references != null) {
    out.push([`${PROVENANCE_PROP_PREFIX}references`, p.references.join(",")]);
  }
  if (p.tool != null) out.push([`${PROVENANCE_PROP_PREFIX}tool`, p.tool]);
  if (p.createdAt != null) out.push([`${PROVENANCE_PROP_PREFIX}createdAt`, p.createdAt]);
  return out;
}

/** Reconstruct a `Provenance` from the `vean:provenance.*` subset of a producer's
 *  properties. Returns `undefined` when the marker `source` is absent (so a
 *  document with no provenance leaves the field absent — byte-identical). Validated
 *  against the schema so a malformed `source` fails loudly, like the rest of the IR. */
export function decodeProvenanceProps(
  props: Record<string, PropertyValue>,
): Provenance | undefined {
  const get = (k: string): string | undefined => {
    const v = props[`${PROVENANCE_PROP_PREFIX}${k}`];
    return v == null ? undefined : String(v);
  };
  const source = get("source");
  if (source == null) return undefined;
  const referencesRaw = get("references");
  const candidate: Record<string, unknown> = { source };
  const model = get("model");
  if (model != null) candidate.model = model;
  const prompt = get("prompt");
  if (prompt != null) candidate.prompt = prompt;
  if (referencesRaw != null) {
    candidate.references = referencesRaw === "" ? [] : referencesRaw.split(",");
  }
  const tool = get("tool");
  if (tool != null) candidate.tool = tool;
  const createdAt = get("createdAt");
  if (createdAt != null) candidate.createdAt = createdAt;
  return provenanceSchema.parse(candidate);
}

/** Whether a producer-property name belongs to the provenance namespace (so the
 *  parser can keep it out of the generic `extraProps` map — it's modeled
 *  structurally and would otherwise double-emit). */
export function isProvenanceProp(name: string): boolean {
  return name.startsWith(PROVENANCE_PROP_PREFIX);
}

// ─── Clip ────────────────────────────────────────────────────────────────
// A window `[in, out]` (INCLUSIVE, 0-based source frames) onto a producer.
// playtime = out - in + 1. `length` is a SEPARATE source-duration property (not
// derivable from out) — required for synthesized producers (color), probed by
// melt for files. `resource` is a media path OR a color spec; `service: "color"`
// marks a solid. Identity is the stable `id`, not the position.
export const clipSchema = z.object({
  kind: z.literal("clip"),
  /** Stable uuid-like id — the load-bearing identity across a session. */
  id: z.string().min(1),
  /** Media-file path (stored root-relative) OR a color spec (#AARRGGBB / name). */
  resource: z.string().min(1),
  /** MLT load key (mlt_service). Omitted → melt infers from the resource. */
  service: z.string().optional(),
  /** Inclusive 0-based source in-point. */
  in: frame,
  /** Inclusive 0-based source out-point. playtime = out - in + 1. */
  out: frame,
  /** Total source duration in frames — SEPARATE from out. Required for color. */
  length: z.number().int().positive().optional(),
  /** Audio gain multiplier (1 = unity). Compiled to a `volume`/`gain` filter. */
  gain: z.number().nonnegative().optional(),
  /** MLT filters on this clip (fades, color, the animation-string escape hatch). */
  filters: z.array(filterSchema).default([]),
  /** Arbitrary producer-level `<property>` children carried verbatim for a lossless
   *  round-trip — `shotcut:caption`, `eof`, `aspect_ratio`, proxy hints, and any
   *  other non-essential metadata the parser doesn't model structurally. An ORDERED
   *  map (insertion = document order) so serialization is deterministic. The
   *  structural producer properties (`mlt_service`, `resource`, `length`,
   *  `shotcut:uuid`) are NEVER stored here — they're modeled by their own fields and
   *  would otherwise double-emit. Absent on vean's own emissions, so they stay
   *  byte-identical. */
  extraProps: z.record(z.string(), propertyValue).optional(),
  /** Optional human label, for legibility when the .mlt is read/diffed. */
  label: z.string().optional(),
  /** Remotion-overlay identity — present iff this clip is a baked alpha .mov
   *  produced from a Remotion composition. `id` names the composition; `props`
   *  carries the inputs it was rendered with. Round-trips through the
   *  `vean:composition` / `vean:compositionProps` producer properties. A clip is
   *  a Remotion overlay (FOOTAGE-composited) iff this field is set. */
  composition: z
    .object({
      id: z.string().min(1),
      props: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  /** Optional origin metadata (import / generative / capture / remotion). Pinned
   *  to the clip and round-tripped as `vean:provenance.*` producer properties so
   *  it survives export — modeled structurally (like `gain`/`label`), never in
   *  `extraProps`. */
  provenance: provenanceSchema.optional(),
});
export type Clip = z.infer<typeof clipSchema>;

// ─── Blank ───────────────────────────────────────────────────────────────
// A literal gap on a track (`<blank length="N"/>`), N frames long. A clip's
// position on a track is the implicit ordering of entries and blanks within the
// playlist — there are no absolute positions in the IR, only order + gaps.
export const blankSchema = z.object({
  kind: z.literal("blank"),
  length: z.number().int().positive(),
});
export type Blank = z.infer<typeof blankSchema>;

// ─── Dissolve (same-track) ───────────────────────────────────────────────
// A cross-fade BETWEEN two clips on the SAME track, `frames` long. The
// serializer compiles it into the Shotcut-native nested transition-tractor
// (a `luma` video dissolve + a `mix` audio cross-fade over the overlap, tagged
// with a `<property name="shotcut:transition">lumaMix</property>` child). It must
// sit between two clips on its track.
// Cross-TRACK compositing is a field `Transition` (below), not a Dissolve.
export const dissolveSchema = z.object({
  kind: z.literal("dissolve"),
  frames: z.number().int().positive(),
  /** Video transition service (default `luma`). */
  luma: z.string().default("luma"),
});
export type Dissolve = z.infer<typeof dissolveSchema>;

// ─── Track item / Track ──────────────────────────────────────────────────
// One track = one `<playlist>` = an ordered run of items. A track is video or
// audio; the kind drives the Shotcut hints (`shotcut:video`/`shotcut:audio`,
// `hide`) and which transition services are valid on the field.
export const itemSchema = z.discriminatedUnion("kind", [clipSchema, blankSchema, dissolveSchema]);
export type Item = z.infer<typeof itemSchema>;

export const trackKind = z.enum(["video", "audio"]);
export type TrackKind = z.infer<typeof trackKind>;

export const trackSchema = z.object({
  kind: trackKind,
  /** Stable id for the track's playlist (also the Shotcut name source). */
  id: z.string().min(1),
  /** Shotcut display name (V1, A1, …). Defaults derived in the builder. */
  name: z.string().optional(),
  /** Ordered items: clips, blanks, and same-track dissolve markers. */
  items: z.array(itemSchema).default([]),
  /** Audio tracks are hidden video (`hide=1`); set by the builder per kind. */
  hidden: z.boolean().optional(),
  /** Arbitrary playlist-level `<property>` children carried verbatim for a lossless
   *  round-trip — `shotcut:lock`, custom namespaces, and any other non-essential
   *  metadata the parser doesn't model structurally. An ORDERED map (insertion =
   *  document order) so serialization is deterministic. The structural playlist
   *  hints (`shotcut:video`, `shotcut:audio`, `shotcut:name`) are NEVER stored here —
   *  they're modeled by their own fields/derivation and would otherwise double-emit.
   *  Absent on vean's own emissions, so they stay byte-identical. */
  extraProps: z.record(z.string(), propertyValue).optional(),
});
export type Track = z.infer<typeof trackSchema>;

// ─── Transition (cross-track, field-level) ───────────────────────────────
// A transition on the MAIN tractor's field: a service over `[in, out]`
// (inclusive frames in TIMELINE space) referencing two tracks by their 0-based
// INTEGER index. This is cross-track compositing — `mix` (sum=1) for audio,
// `qtblend`/`frei0r.cairoblend`/`movit.overlay` for video. (Same-track
// cross-fades are `Dissolve`, compiled to a nested tractor instead.)
export const transitionSchema = z.object({
  service: z.string().min(1),
  /** 0-based track index of the A (lower) track. Load-bearing. */
  aTrack: z.number().int().nonnegative(),
  /** 0-based track index of the B (upper) track. */
  bTrack: z.number().int().nonnegative(),
  /** Inclusive frame range in TIMELINE space. */
  in: frame,
  out: frame,
  properties: z.record(z.string(), propertyValue).default({}),
});
export type Transition = z.infer<typeof transitionSchema>;

// ─── Timeline ────────────────────────────────────────────────────────────
// The whole document: a profile + named tracks split into video/audio + the
// field-level transitions composited over them. Track index across the main
// tractor is `[...tracks.video, ...tracks.audio]` order (with the implicit
// background producer at index 0 when emitted as a Shotcut doc) — that ordering
// is what a `Transition`'s aTrack/bTrack indexes into.
export const tracksSchema = z.object({
  video: z.array(trackSchema).default([]),
  audio: z.array(trackSchema).default([]),
});
export type Tracks = z.infer<typeof tracksSchema>;

export const timelineSchema = z.object({
  profile: profileSchema,
  tracks: tracksSchema,
  /** Field-level (cross-track) transitions on the main tractor. */
  transitions: z.array(transitionSchema).default([]),
  /** Arbitrary main-tractor-level `<property>` children carried verbatim for a
   *  lossless round-trip — Shotcut writes project metadata here
   *  (`shotcut:projectAudioChannels`, `shotcut:scaleFactor`, …). An ORDERED map
   *  (insertion = document order) so serialization is deterministic. The structural
   *  main-tractor attributes (`shotcut="1"`, `title`) are modeled separately, never
   *  stored here. Absent on vean's own emissions, so they stay byte-identical. */
  tractorProps: z.record(z.string(), propertyValue).optional(),
  title: z.string().default("vean timeline"),
});
export type Timeline = z.infer<typeof timelineSchema>;
