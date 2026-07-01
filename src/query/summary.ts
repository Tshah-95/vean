// The timeline INVENTORY query — a compact, structured read of "what is on this
// timeline, where, in frames." This is the missing text half of the inspect pair:
// `inspect.timeline` renders PIXELS (a still strip you look at to VERIFY); this
// renders STRUCTURE (tracks, clips, frame spans, overlays, audio, diagnostics) you
// read to ORIENT before diving in. Palmier splits the same two jobs across
// `get_timeline` (structured text) + `inspect_timeline` (frames); we had only the
// second — `summarizeTimeline` is the first.
//
// PURE + IR-only: `summarizeTimeline(state)` reads the typed IR and returns plain
// data, no I/O, no mutation, no engine coupling. It reuses the SAME frame-math
// primitives the ops use (`startOf`/`trackLength`/`playtime`) so the reported
// spans are exactly the rendered coordinates melt produces — a dissolve overlap is
// counted once, not twice, and the summary never drifts from the edit algebra.
// Diagnostics are OPTIONAL and passed IN (the action supplies `collectDiagnostics`)
// so this module stays decoupled from the diagnostics engine and trivially
// testable. Frame-exact throughout: every position is an integer frame (the
// canonical truth); the `timecode` strings are a derived human aid, never a source
// of truth.
import type { Diagnostic, Severity } from "../diagnostics/types";
import type { Clip, Fps, Item, Timeline, Track } from "../ir/types";
import { isFadeIn, isFadeOut, startOf, trackLength } from "../ops/primitives";

// ─── Output shape ────────────────────────────────────────────────────────────

/** The whole structured read of a timeline. Every frame field is an integer; the
 *  `duration`/`timecode` strings are derived human aids. */
export interface TimelineSummary {
  title: string;
  profile: {
    description: string;
    width: number;
    height: number;
    /** Rational fps `[num, den]` — the canonical rate (never a float). */
    fps: Fps;
    /** `num/den` as a number, for humans (30, 29.97, 23.976). Display only. */
    fpsRatio: number;
  };
  /** Longest track's rendered frame length — the timeline's total extent. */
  totalFrames: number;
  /** `totalFrames` in seconds (display only). */
  seconds: number;
  /** `totalFrames` as a timecode (display only). */
  duration: string;
  counts: {
    videoTracks: number;
    audioTracks: number;
    clips: number;
    blanks: number;
    dissolves: number;
    transitions: number;
    diagnostics: { error: number; warning: number; info: number; hint: number };
  };
  /** Tracks in MAIN-TRACTOR order: `[...video, ...audio]`. Each carries the
   *  `tractorIndex` a transition's aTrack/bTrack references (background = 0). */
  tracks: TrackSummary[];
  transitions: TransitionSummary[];
  /** The flat diagnostic set (empty when none were supplied or none found). */
  diagnostics: DiagnosticSummary[];
}

export interface TrackSummary {
  /** The index a `Transition`'s aTrack/bTrack references. The serialized doc keeps
   *  an implicit background producer at index 0, so real tracks are 1-based:
   *  `tractorIndex = position-in-[...video,...audio] + 1`. */
  tractorIndex: number;
  kind: "video" | "audio";
  id: string;
  /** Display name (the IR `name`, else the derived `V1`/`A1` Shotcut convention). */
  name: string;
  /** Rendered track length in frames (dissolve overlaps counted once). */
  length: number;
  items: ItemSummary[];
}

/** A timeline span in RENDERED coordinates: `[start, end]` inclusive, `frames`
 *  wide. Shared by every item kind so a walker can treat them uniformly. */
interface SpanBase {
  start: number;
  end: number;
  frames: number;
  timecode: { start: string; end: string };
}

export type ItemSummary = ClipSummary | BlankSummary | DissolveSummary;

export interface ClipSummary extends SpanBase {
  kind: "clip";
  /** The stable uuid — how you refer to this clip in an op (never the index). */
  id: string;
  resource: string;
  label?: string;
  service?: string;
  /** The source window `[in, out]` (inclusive) + total source length when known. */
  source: { in: number; out: number; length?: number };
  /** Raw audio gain multiplier when non-unity (1 is omitted). `0` = muted. */
  gain?: number;
  /** `gain` as decibels, when finite (omitted for unity and for muted `gain=0`). */
  gainDb?: number;
  /** Fade-in / fade-out length in frames, when present. */
  fadeInFrames?: number;
  fadeOutFrames?: number;
  /** A Remotion overlay: `composited` = a baked alpha `.mov` (has `composition`);
   *  `graphic` = a live-rendered graphic clip (label `graphic:<id>`). */
  overlay?: "composited" | "graphic";
  /** The composition id this overlay renders (baked `composition.id` or the
   *  `graphic:<id>` label target). */
  composition?: string;
  /** Media origin (`import`/`generative`/`capture`/`remotion`), when pinned. */
  provenance?: string;
  /** Count of diagnostics anchored to this clip (0 when clean / none supplied). */
  diagnostics: number;
}

export interface BlankSummary extends SpanBase {
  kind: "blank";
}

export interface DissolveSummary extends SpanBase {
  kind: "dissolve";
  /** The video transition service (default `luma`). */
  service: string;
}

export interface TransitionSummary {
  index: number;
  service: string;
  aTrack: number;
  bTrack: number;
  start: number;
  end: number;
  frames: number;
  timecode: { start: string; end: string };
}

export interface DiagnosticSummary {
  code: string;
  severity: Severity;
  message: string;
  clip?: string;
  track?: string;
  transition?: number;
}

// ─── Display helpers (pure, deterministic) ───────────────────────────────────

/** Exact rational fps as a ratio — frame⇄second math, never a float fps. */
function fpsRatio(fps: Fps): number {
  return fps[0] / fps[1];
}

/** Whole frames → seconds at the rational rate: `frames · den / num`. */
function framesToSeconds(frames: number, fps: Fps): number {
  return (frames * fps[1]) / fps[0];
}

/** A frame count → a stable, brief timecode. `M:SS.mmm` under an hour, else
 *  `H:MM:SS.mmm`. Milliseconds (not `:FF`) so a fractional-fps rate reads exactly;
 *  the integer `frames` beside it is always the canonical value. */
export function frameTimecode(frames: number, fps: Fps): string {
  const total = framesToSeconds(frames, fps);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const ss = secs.toFixed(3).padStart(6, "0"); // "07.000", "12.500"
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${ss}`;
  }
  return `${minutes}:${ss}`;
}

/** A gain multiplier → decibels, rounded to 0.1 dB, or `undefined` when the value
 *  has no finite dB (unity `1` is a no-op; muted `0` is `-Infinity`). */
function gainToDb(gain: number): number | undefined {
  if (gain === 1 || gain <= 0) return undefined;
  return Math.round(20 * Math.log10(gain) * 10) / 10;
}

/** The Shotcut-style display name for a track when the IR carries none: `V1`, `A1`,
 *  … numbered from the bottom (index 0) up, per kind. */
function deriveTrackName(kind: "video" | "audio", ordinal: number): string {
  return `${kind === "video" ? "V" : "A"}${ordinal}`;
}

// ─── Item summarization ──────────────────────────────────────────────────────

/** Fade lengths (in frames) declared on a clip's filters. Fades are keyed on the
 *  filter NAME (a vean sentinel or a Shotcut `fadeIn*`/`fadeOut*`), never a bare
 *  2-keyframe shape — so a genuine edge-anchored ramp is not mistaken for a fade. */
function fadeFrames(clip: Clip): { in?: number; out?: number } {
  let fadeIn: number | undefined;
  let fadeOut: number | undefined;
  for (const f of clip.filters) {
    if (isFadeIn(f)) fadeIn = Number(f.properties.frames ?? 0) || fadeIn;
    else if (isFadeOut(f)) fadeOut = Number(f.properties.frames ?? 0) || fadeOut;
  }
  return { in: fadeIn, out: fadeOut };
}

/** Classify a clip's overlay identity from the IR alone (no preview coupling),
 *  matching the viewer's precedence (isGraphicClip wins over a bare composition
 *  field): a clip is a LIVE `graphic` overlay if its resource is under
 *  `cache/remotion/` OR it carries a `graphic:` label — even when it also names a
 *  composition (the composition just names which comp renders live). Only a
 *  `composition` field WITHOUT those markers is the baked, footage-`composited` path. */
function overlayOf(clip: Clip): { overlay?: "composited" | "graphic"; composition?: string } {
  const isGraphic =
    /cache\/remotion\//.test(clip.resource.replace(/\\/g, "/")) ||
    /^graphic\b/i.test(clip.label ?? "");
  if (isGraphic) {
    const labelId = clip.label?.startsWith("graphic:")
      ? clip.label.slice("graphic:".length)
      : undefined;
    return { overlay: "graphic", composition: clip.composition?.id ?? labelId };
  }
  if (clip.composition) return { overlay: "composited", composition: clip.composition.id };
  return {};
}

/** Summarize one item given its rendered span + the count of diagnostics on it. */
function summarizeItem(item: Item, span: SpanBase, diagCount: number): ItemSummary {
  if (item.kind === "blank") return { kind: "blank", ...span };
  if (item.kind === "dissolve") return { kind: "dissolve", service: item.luma, ...span };

  const clip = item;
  const { overlay, composition } = overlayOf(clip);
  const { in: fadeInFrames, out: fadeOutFrames } = fadeFrames(clip);
  const out: ClipSummary = {
    kind: "clip",
    id: clip.id,
    resource: clip.resource,
    source: { in: clip.in, out: clip.out, length: clip.length },
    diagnostics: diagCount,
    ...span,
  };
  if (clip.label != null) out.label = clip.label;
  if (clip.service != null) out.service = clip.service;
  if (clip.gain != null && clip.gain !== 1) {
    out.gain = clip.gain;
    const db = gainToDb(clip.gain);
    if (db != null) out.gainDb = db;
  }
  if (fadeInFrames) out.fadeInFrames = fadeInFrames;
  if (fadeOutFrames) out.fadeOutFrames = fadeOutFrames;
  if (overlay) out.overlay = overlay;
  if (composition) out.composition = composition;
  if (clip.provenance) out.provenance = clip.provenance.source;
  return out;
}

/** Summarize one track's item run in rendered coordinates. Spans come from
 *  `startOf` boundaries (dissolve-aware), so `[start, end]` and `frames` agree with
 *  melt's output and every positional op. */
function summarizeTrack(
  track: Track,
  tractorIndex: number,
  ordinal: number,
  fps: Fps,
): TrackSummary {
  const { items } = track;
  const length = trackLength(items);
  // Boundary prefix: bounds[i] = rendered start of items[i]; bounds[n] = length.
  // Using startOf for each boundary keeps this identical to the ops' frame math.
  const bounds: number[] = items.map((_, i) => startOf(items, i));
  bounds.push(length);

  const itemSummaries = items.map((item, i): ItemSummary => {
    const start = bounds[i] as number;
    const end = (bounds[i + 1] as number) - 1;
    const frames = (bounds[i + 1] as number) - start;
    const span: SpanBase = {
      start,
      end,
      frames,
      timecode: { start: frameTimecode(start, fps), end: frameTimecode(end + 1, fps) },
    };
    return summarizeItem(item, span, 0);
  });

  return {
    tractorIndex,
    kind: track.kind,
    id: track.id,
    name: track.name ?? deriveTrackName(track.kind, ordinal),
    length,
    items: itemSummaries,
  };
}

// ─── The summarizer ──────────────────────────────────────────────────────────

/** Build a structured inventory of `state`. `diagnostics` (optional) are folded in
 *  — counted per-clip and surfaced as a flat list; omit them for a pure structural
 *  read. */
export function summarizeTimeline(
  state: Timeline,
  diagnostics: readonly Diagnostic[] = [],
): TimelineSummary {
  const { fps } = state.profile;

  // Per-clip diagnostic tally (by stable clip uuid), for the ClipSummary count.
  const perClip = new Map<string, number>();
  for (const d of diagnostics) {
    const clip = d.location.clip;
    if (clip) perClip.set(clip, (perClip.get(clip) ?? 0) + 1);
  }

  // Main-tractor track order is [...video, ...audio]; real tracks are 1-based
  // (background producer occupies index 0). Ordinals number V1/A1… per kind.
  const orderedTracks: Track[] = [...state.tracks.video, ...state.tracks.audio];
  const tracks = orderedTracks.map((track, i) => {
    const kind = track.kind;
    const ordinal =
      kind === "video"
        ? state.tracks.video.indexOf(track) + 1
        : state.tracks.audio.indexOf(track) + 1;
    const summary = summarizeTrack(track, i + 1, ordinal, fps);
    // Attach per-clip diagnostic counts now that we have the ordered tracks.
    for (const item of summary.items) {
      if (item.kind === "clip") item.diagnostics = perClip.get(item.id) ?? 0;
    }
    return summary;
  });

  const totalFrames = tracks.reduce((max, t) => Math.max(max, t.length), 0);

  // Transitions in TIMELINE space (inclusive `[in, out]`).
  const transitions: TransitionSummary[] = state.transitions.map((t, index) => ({
    index,
    service: t.service,
    aTrack: t.aTrack,
    bTrack: t.bTrack,
    start: t.in,
    end: t.out,
    frames: t.out - t.in + 1,
    timecode: { start: frameTimecode(t.in, fps), end: frameTimecode(t.out + 1, fps) },
  }));

  const severity = { error: 0, warning: 0, info: 0, hint: 0 };
  const diagSummaries: DiagnosticSummary[] = diagnostics.map((d) => {
    severity[d.severity]++;
    const out: DiagnosticSummary = { code: d.code, severity: d.severity, message: d.message };
    if (d.location.clip != null) out.clip = d.location.clip;
    if (d.location.track != null) out.track = d.location.track;
    if (d.location.transition != null) out.transition = d.location.transition;
    return out;
  });

  let clips = 0;
  let blanks = 0;
  let dissolves = 0;
  for (const t of orderedTracks) {
    for (const it of t.items) {
      if (it.kind === "clip") clips++;
      else if (it.kind === "blank") blanks++;
      else dissolves++;
    }
  }

  return {
    title: state.title,
    profile: {
      description: state.profile.description,
      width: state.profile.width,
      height: state.profile.height,
      fps,
      fpsRatio: fpsRatio(fps),
    },
    totalFrames,
    seconds: framesToSeconds(totalFrames, fps),
    duration: frameTimecode(totalFrames, fps),
    counts: {
      videoTracks: state.tracks.video.length,
      audioTracks: state.tracks.audio.length,
      clips,
      blanks,
      dissolves,
      transitions: state.transitions.length,
      diagnostics: severity,
    },
    tracks,
    transitions,
    diagnostics: diagSummaries,
  };
}
