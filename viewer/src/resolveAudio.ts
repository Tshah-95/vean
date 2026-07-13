// The TIER-2b AUDIO RESOLVER — the read-side mirror of the serializer's AUDIO track
// walk, evaluated over a whole track into a flat list of SCHEDULED CLIPS for the Web
// Audio graph (DESIGN-LIVE-PREVIEW.md §6 Tier 2b, §7, §8.6, §9 step 6).
//
// `resolveLayers.ts` answers "what VISUAL layers cover frame F" for the compositor.
// Audio is different: a Web Audio graph schedules each source AHEAD of the playhead
// (`AudioBufferSourceNode.start(when, offset, duration)`), so it needs the WHOLE
// timeline placement of every audio clip up front — not a per-frame query. This
// module produces that: for each audio track, the placed clips with their integer
// timeline span, the source media offset, and the resolved gain (static + fade
// automation), so the graph can schedule them sample-accurately against the clock.
//
// ── FRAME-EXACT INTEGER PLACEMENT (vean's load-bearing invariant) ──────────────
// All placement + media-offset math is integer frames, mirroring `walkTrack`'s
// dissolve-trimming exactly so the audio placement matches the video placement
// (a same-track audio dissolve is the `mix` cross-fade `serialize.ts:361` emits,
// the audio twin of the `luma` video dissolve — an OVERLAP that trims `d` frames
// off each neighbour, NOT an inserted gap). Frames→seconds happens ONLY at the
// schedule boundary in the graph, via the exact rational `frame * fps[1] / fps[0]`.
//
// ── GAIN (§7 "volume/gain → Web Audio gain node", exact) ───────────────────────
// A clip's audio gain is the IR `clip.gain` (static, ≠1 unity) PLUS any fade — the
// builder compiles fadeIn/fadeOut to a `volume` filter whose `gain` is a keyframe
// string (`0=0;5=1;84=1;89=0`), and a static gain to a `volume`/`gain` filter with a
// bare number. We resolve both: the static multiplier, and a set of automation
// points (segment-frame → linear gain) the graph schedules as
// `linearRampToValueAtTime` on the clip's gain node. This is the audio analog of
// `resolveLayers`' `resolveClipVisual` (which does the SAME for visual opacity).
import { isAnimated, parseAnim, scalarOf, valueAtFrame } from "./keyframes";
import {
  type ClipFilter,
  type ClipItem,
  type Item,
  type Timeline,
  type Track,
  isGraphicClip,
  isRemotionOverlay,
} from "./types";

/** The fade-sentinel filter services the builder emits (mirror `resolveLayers.ts`
 *  / `src/ir/builder.ts`). On an AUDIO clip a fade compiles to a `volume`/`gain`
 *  keyframe; but the round-tripped form may still arrive as a fade sentinel. */
const FADE_IN_SERVICE = "vean.fadeIn";
const FADE_OUT_SERVICE = "vean.fadeOut";

/** One automation point: gain `value` at `frame` frames into the played SEGMENT
 *  (0 = the segment's first played frame). The graph converts the frame to a clock
 *  time at the schedule boundary. */
export interface GainPoint {
  frame: number;
  value: number;
}

/** A single audio clip placed on a track, ready for the Web Audio graph to schedule.
 *  Times are INTEGER timeline frames; the graph converts to seconds via the exact
 *  rational fps at schedule time. */
export interface AudioClip {
  /** The track this clip plays on (its own gain/mute/solo bus in the graph). */
  trackId: string;
  /** The clip's stable producer uuid (identity for the per-clip resource cache). */
  uuid: string;
  /** Absolute/relative source path the graph fetches + `decodeAudioData`s. */
  resource: string;
  /** First timeline frame the clip is audible (inclusive). */
  timelineStart: number;
  /** Last timeline frame the clip is audible (inclusive). */
  timelineEnd: number;
  /** SOURCE frame the clip starts at — `clip.in` (+ any dissolve head-trim). The
   *  graph offsets the buffer read by `mediaOffset * fps[1] / fps[0]` seconds. */
  mediaOffset: number;
  /** Static gain multiplier (1 = unity). The clip's `gain` × any non-animated
   *  `volume` filter. Fades ride on `gainAutomation`, not here. */
  baseGain: number;
  /** Linear gain automation points (segment-frame → value). Empty when the clip has
   *  no fade. The graph schedules these as `linearRampToValueAtTime` on the clip
   *  gain node, multiplied by `baseGain`. */
  gainAutomation: GainPoint[];
}

/** The resolved audio schedule for a timeline: every audible audio clip across all
 *  audio tracks, plus the set of track ids (so the graph can build one bus/track).
 *  Identity is the clip uuid + track id, both stable across edits that only move a
 *  clip — so a re-schedule after an edit reuses decoded buffers. */
export interface ResolvedAudio {
  clips: AudioClip[];
  trackIds: string[];
}

/** Is this a synthetic/color producer (no decodable audio)? A `color` clip's
 *  resource is a hex/named color, not a file — it carries no audio. */
function isColorClip(clip: ClipItem): boolean {
  return clip.service === "color";
}

/** Resolve a clip's static gain + fade automation over its played segment.
 *  `segLen` is the segment's played length in frames (0-based frames 0..segLen-1).
 *  Mirrors `resolveLayers.ts resolveClipVisual` but for AUDIO gain instead of visual
 *  opacity, and reads the `volume`/`gain` filters (not `brightness`/`level`). */
function resolveClipGain(
  clip: ClipItem,
  segLen: number,
): { baseGain: number; automation: GainPoint[] } {
  let baseGain = clip.gain ?? 1;
  const automation: GainPoint[] = [];
  for (const f of clip.filters ?? []) {
    if (f.service === "volume" || f.service === "gain") {
      const raw = String(f.properties.gain ?? f.properties.level ?? "");
      if (!raw) continue;
      if (isAnimated(raw)) {
        // A fade (or any animated gain) → sample the keyframe ramp at each segment
        // frame the curve has a breakpoint, so the graph's linear ramps reproduce
        // it. We sample at every keyframe frame within the segment plus the segment
        // ends, which is enough for the linear/discrete fade ramps vean emits.
        addAutomationFromAnim(raw, segLen, automation);
      } else {
        // A static gain multiplier (a bare number) stacks into baseGain — `melt`
        // applies the volume filters in order, multiplicatively.
        const n = Number(raw);
        if (Number.isFinite(n)) baseGain *= n;
      }
    } else if (f.service === FADE_IN_SERVICE) {
      addFadeIn(f, segLen, automation);
    } else if (f.service === FADE_OUT_SERVICE) {
      addFadeOut(f, segLen, automation);
    }
    // Non-volume audio filters (panner, EQ, …) are out of Tier-2b scope: the graph
    // applies gain only. They do not flag `approximate` (that is a VISUAL concern in
    // §7); the audio path simply plays the unfiltered source at the resolved gain.
  }
  // Always anchor the curve at the segment ends so a partial ramp holds its level
  // for the rest of the clip (the graph needs an endpoint to ramp toward / hold).
  if (automation.length > 0) {
    if (!automation.some((p) => p.frame === 0)) {
      automation.unshift({ frame: 0, value: gainAt(automation, 0) });
    }
    if (!automation.some((p) => p.frame === segLen - 1)) {
      automation.push({ frame: segLen - 1, value: gainAt(automation, segLen - 1) });
    }
    automation.sort((a, b) => a.frame - b.frame);
  }
  return { baseGain, automation };
}

/** Sample an animated `volume`/`gain` keyframe string into automation points at
 *  each of its breakpoints within `[0, segLen)`, via the shared keyframe resolver
 *  (so the ramp is byte-faithful to the exporter). */
function addAutomationFromAnim(raw: string, segLen: number, out: GainPoint[]): void {
  const model = parseAnim(raw);
  const frames = new Set<number>();
  for (const kf of model.keyframes) {
    if (kf.frame >= 0 && kf.frame < segLen) frames.add(kf.frame);
  }
  frames.add(0);
  frames.add(segLen - 1);
  for (const frame of frames) {
    const v = valueAtFrame(model, frame, { length: segLen });
    const s = v ? scalarOf(v) : null;
    if (s != null) out.push({ frame, value: Math.max(0, s) });
  }
}

/** A fadeIn sentinel → a linear ramp 0→1 over the first `frames` segment frames
 *  (matching `serialize.ts resolveFades`: `0=0; n-1=1`). */
function addFadeIn(f: ClipFilter, segLen: number, out: GainPoint[]): void {
  const n = Math.min(Number(f.properties.frames ?? 0), segLen);
  if (n <= 0) return;
  out.push({ frame: 0, value: 0 });
  out.push({ frame: Math.max(0, n - 1), value: 1 });
}

/** A fadeOut sentinel → a linear ramp 1→0 over the last `frames` segment frames
 *  (`len-n=1; len-1=0`). */
function addFadeOut(f: ClipFilter, segLen: number, out: GainPoint[]): void {
  const n = Math.min(Number(f.properties.frames ?? 0), segLen);
  if (n <= 0) return;
  out.push({ frame: segLen - n, value: 1 });
  out.push({ frame: segLen - 1, value: 0 });
}

/** Linearly interpolate the gain at `frame` from the (unsorted) points collected so
 *  far — used only to anchor the segment ends. */
function gainAt(points: GainPoint[], frame: number): number {
  const sorted = [...points].sort((a, b) => a.frame - b.frame);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return 1;
  if (frame <= first.frame) return first.value;
  if (frame >= last.frame) return last.value;
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1];
    const b = sorted[i];
    if (!a || !b) continue;
    if (frame >= a.frame && frame <= b.frame) {
      const span = b.frame - a.frame;
      if (span <= 0) return b.value;
      return a.value + (b.value - a.value) * ((frame - a.frame) / span);
    }
  }
  return last.value;
}

/** Options for `placeAudioTrack`. On a VIDEO track we source the clips' EMBEDDED
 *  audio (a footage clip is video+audio together — melt mixes a video track's audio
 *  on render), but skip graphic (Remotion overlay) clips via `skipGraphic`. Audio
 *  tracks pass no opts (every non-color clip is audible). */
interface PlaceOpts {
  skipGraphic?: boolean;
}

/** Whether this placed producer is configured to decode audio. The source may
 * physically contain an audio stream while the VIDEO half of a typed detach has
 * explicitly disabled it with `astream=-1`/`audio_index=-1`. Relative selectors
 * override absolute selectors, matching MLT and the core IR's `hasAudio` helper. */
function clipDecodesAudio(clip: ClipItem): boolean {
  const streams = clip.streams;
  if (streams == null) return true;
  if (streams.astream != null) return streams.astream !== -1;
  if (streams.audioIndex != null) return streams.audioIndex !== -1;
  return true;
}

/** Walk ONE audio track into placed clips, mirroring `walkTrack`'s dissolve-trimming
 *  placement EXACTLY (a same-track audio dissolve trims `d` frames off each
 *  neighbour and occupies `d` frames itself — the `mix` cross-fade).
 *
 *  NOTE on `hidden`: on an AUDIO track, `hidden` is the audio-track MARKER, NOT a
 *  mute. The parser sets `track.hidden = true` for every audio track (MLT spells an
 *  audio track `hide="video"` — its video is hidden, it plays audio). So an audio
 *  track is ALWAYS audible here; we must NOT skip it for `hidden`. (`resolveAudio`
 *  only ever passes audio tracks to this function.) */
function placeAudioTrack(track: Track, out: AudioClip[], opts: PlaceOpts = {}): void {
  const items = track.items;
  let cursor = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;
    if (it.kind === "blank") {
      cursor += it.length;
      continue;
    }
    if (it.kind === "dissolve") {
      // The audio cross-fade overlap. Each neighbour's edge is scheduled solo by the
      // adjacent clip's own placement (with its head/tail trimmed below); the
      // overlap frames themselves are the `mix` sum=1 cross-fade. For preview, we
      // schedule BOTH neighbours through the overlap (their gain ramps approximate
      // the equal-power-ish `mix`), so we do not emit a separate dissolve clip —
      // the trimmed neighbours already cover [start, start+d). Advance the cursor.
      placeDissolveEdges(items, i, cursor, out, track.id, opts);
      cursor += it.frames;
      continue;
    }
    // A clip — trim head/tail for adjacent dissolves (those frames belong to the
    // overlap), exactly like `walkTrack` / `resolveLayerOnTrack`.
    const before = items[i - 1];
    const after = items[i + 1];
    const trimHead = before?.kind === "dissolve" ? before.frames : 0;
    const trimTail = after?.kind === "dissolve" ? after.frames : 0;
    const inn = it.in + trimHead;
    const out2 = it.out - trimTail;
    if (out2 < inn) {
      // Wholly consumed by its dissolve(s) — its edges are scheduled by
      // placeDissolveEdges; no solo segment.
      continue;
    }
    const segLen = out2 - inn + 1;
    const start = cursor;
    cursor += segLen;
    if (isColorClip(it) || !clipDecodesAudio(it)) continue;
    // On a VIDEO track, skip graphic clips AND Remotion overlays — both are visual
    // overlays; any baked audio in their .mov is silent/incidental, and fetching a
    // large overlay .mov to decode it is wasteful. Audio tracks pass skipGraphic=false.
    if (opts.skipGraphic && (isGraphicClip(it) || isRemotionOverlay(it))) continue;
    const { baseGain, automation } = resolveClipGain(it, segLen);
    out.push({
      trackId: track.id,
      uuid: it.id,
      resource: it.resource,
      timelineStart: start,
      timelineEnd: start + segLen - 1,
      mediaOffset: inn,
      baseGain,
      gainAutomation: automation,
    });
  }
}

/** Schedule the two cross-faded EDGES of an audio dissolve as short clips covering
 *  the overlap `[start, start+d)`, so the preview plays both sources through the
 *  cross-fade. Each edge ramps its gain (out: 1→0, in: 0→1) approximating the `mix`
 *  sum=1 cross-fade. This is preview judgment audio, not the bit-exact `melt` mix. */
function placeDissolveEdges(
  items: Item[],
  dissolveIndex: number,
  start: number,
  out: AudioClip[],
  trackId: string,
  opts: PlaceOpts = {},
): void {
  const prev = items[dissolveIndex - 1];
  const next = items[dissolveIndex + 1];
  const d = items[dissolveIndex];
  if (!d || d.kind !== "dissolve") return;
  const frames = d.frames;
  if (frames <= 0) return;
  const audible = (c: ClipItem) =>
    !isColorClip(c) &&
    clipDecodesAudio(c) &&
    !(opts.skipGraphic && (isGraphicClip(c) || isRemotionOverlay(c)));
  // The OUTGOING edge: prev's last `frames` source frames, fading 1→0.
  if (prev?.kind === "clip" && audible(prev)) {
    const fromSrc = prev.out - frames + 1;
    out.push({
      trackId,
      uuid: prev.id,
      resource: prev.resource,
      timelineStart: start,
      timelineEnd: start + frames - 1,
      mediaOffset: Math.max(prev.in, fromSrc),
      baseGain: prev.gain ?? 1,
      gainAutomation:
        frames > 1
          ? [
              { frame: 0, value: 1 },
              { frame: frames - 1, value: 0 },
            ]
          : [{ frame: 0, value: 0 }],
    });
  }
  // The INCOMING edge: next's first `frames` source frames, fading 0→1.
  if (next?.kind === "clip" && audible(next)) {
    out.push({
      trackId,
      uuid: next.id,
      resource: next.resource,
      timelineStart: start,
      timelineEnd: start + frames - 1,
      mediaOffset: next.in,
      baseGain: next.gain ?? 1,
      gainAutomation:
        frames > 1
          ? [
              { frame: 0, value: 0 },
              { frame: frames - 1, value: 1 },
            ]
          : [{ frame: 0, value: 1 }],
    });
  }
}

/**
 * Resolve the FULL audio schedule of a timeline: every audible audio clip across
 * all audio tracks, with integer timeline placement + resolved gain/fade, plus the
 * track ids for the graph's per-track bus. This is what the Web Audio graph
 * schedules against the master clock (DESIGN-LIVE-PREVIEW §6 Tier 2b, §8.6).
 *
 * Pure: same `timeline` → same schedule. The graph keys decoded buffers by clip
 * `resource`, so a re-resolve after an edit that only moves clips reuses buffers.
 */
export function resolveAudio(timeline: Timeline): ResolvedAudio {
  const clips: AudioClip[] = [];
  const trackIds: string[] = [];
  // Every audio track is audible: `track.hidden` on an audio track is the
  // audio-track MARKER (MLT `hide="video"`), not a mute (see `placeAudioTrack`). So
  // we do NOT skip on `hidden` here — that would silence ALL audio (the parser flags
  // every audio track hidden). We read `timeline.tracks.audio`, which the parser
  // already separated from the video tracks.
  for (const track of timeline.tracks.audio) {
    trackIds.push(track.id);
    placeAudioTrack(track, clips);
  }
  // VIDEO tracks ALSO carry their clips' EMBEDDED audio. A normal MP4 on a video
  // track is video+audio together (the Shotcut model), and melt mixes a video
  // track's clip audio on export (the track is not muted). Sourcing it here makes
  // the live preview match the render instead of being silent — the gap that made
  // the editor look broken (no sound for footage on V1). Graphic (Remotion overlay)
  // clips are skipped; a clip with no audio stream is dropped at decode (loadBuffer
  // returns null), so this never adds phantom sources.
  for (const track of timeline.tracks.video) {
    trackIds.push(track.id);
    placeAudioTrack(track, clips, { skipGraphic: true });
  }
  return { clips, trackIds };
}
