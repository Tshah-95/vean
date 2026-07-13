// The TIER-1 LAYER RESOLVER — the multi-track, dissolve-aware, fade-resolved
// read-side mirror of the serializer's `walkTrack` (`src/ir/serialize.ts:454`),
// EVALUATED AT A FRAME (DESIGN-LIVE-PREVIEW.md §4, §6 Tier 1, §7).
//
// Tier 0 (`resolveVisible.ts`) answered the cheapest question — "the ONE topmost
// footage clip live at the frame" — for a pooled `<video>`. Tier 1's compositor
// needs the WHOLE z-stack: every layer that covers the frame, across all video
// tracks, with same-track dissolves resolved to a crossfade (from/to + progress)
// and per-clip fades/opacity resolved to a concrete alpha. That stack is what
// `renderFrame` composites in one WebGL2 pass (lower track index = lower z).
//
// ── WHY THIS MUST MIRROR walkTrack EXACTLY (the dissolve overlap) ────────────
// A same-track `dissolve(d)` is NOT an inserted `d`-frame gap — it is an OVERLAP.
// `walkTrack` TRIMS `d` frames off the preceding clip's tail and `d` frames off
// the following clip's head, and the dissolve itself occupies `d` timeline frames
// where the two trimmed edges cross-fade. So the read-side placement MUST trim the
// same way, or the preview geometry diverges from `melt`'s and the gate's f45/f80
// pixels won't land. (Tier 0's `placeItems` counts the dissolve additively — fine
// when dissolves were out of scope, WRONG for Tier 1. This module supersedes it
// for the compositor.) Concretely, for the Move-5 demo V1
//   base-a(len63) · dissolve(18) · base-b(len63)
// walkTrack emits: base-a solo [0,44] · dissolve [45,62] · base-b solo [63,107]
// (total 108 = the timeline length), NOT base-a[0,62]·diss[63,80]·base-b[81,143].
//
// ── FRAME-EXACT INTEGER MATH ─────────────────────────────────────────────────
// All placement + source-frame math is integer frames (vean's load-bearing
// invariant). The only frames→seconds conversion is at the decode boundary in the
// compositor, via the exact rational `sourceFrame * fps[1] / fps[0]` (never a
// float fps).
import { isAnimated, parseAnim, scalarOf, valueAtFrame } from "./keyframes";
import type { RectValue } from "./keyframes";
import { type ClipItem, type Item, type Timeline, type Track, isGraphicClip } from "./types";

/** The main-tractor track index of `tracks.video[videoIndex]`. Index 0 is the
 *  background producer; video tracks follow (1-based), then audio — the inverse of
 *  `src/actions/graphic.ts mainTractorIndexOfVideo`. A `qtblend`/over-composite
 *  field `Transition` references its tracks by THIS index. */
function videoIndexOfMainTractor(mainIndex: number): number {
  return mainIndex - 1;
}

/** The over-composite field-transition services vean emits: a `qtblend` (or
 *  `cairoblend`/`frei0r.cairoblend`) compositing the `bTrack` (higher index = ON
 *  TOP) over the `aTrack` (the base below). vean's graphic action always emits
 *  `qtblend` (`src/actions/graphic.ts`); but a `qtblend` is ALSO how any upper
 *  video CLIP composites over the footage below — it is NOT a "this is a Remotion
 *  overlay" marker. The Remotion-overlay marker is the clip being a GRAPHIC clip
 *  (`isGraphic` — a `graphic:` label or a `cache/remotion/` resource), which
 *  `resolveLayerOnTrack` already excludes per-clip (the `<Player>` draws it). */
const OVERLAY_BLEND_SERVICES = new Set(["qtblend", "cairoblend", "frei0r.cairoblend"]);

/** The 0-based `tracks.video` indices the footage compositor SKIPS because the
 *  `@remotion/player` overlay draws them ON TOP (§4: two compositors, one editor
 *  track). A track is skipped ONLY when, AT THIS FRAME, it is the `bTrack` of an
 *  over-composite transition AND the covering clip is an actual GRAPHIC clip — i.e.
 *  the clip the live `<Player>` will redraw.
 *
 *  This is the load-bearing correction (verified on `projects/retire`): a plain
 *  pre-rendered video file on a `qtblend` over-composite track (e.g. retire's
 *  `chat.mov`, a baked carlo overlay; or the demo's `corpus/demo/lower-third.mov`)
 *  is NOT a graphic clip and the `<Player>` never renders it — so the footage
 *  compositor MUST decode + composite it, exactly as `melt` over-composites it on
 *  export. Skipping it unconditionally (the prior structural-only rule) dropped the
 *  overlay entirely and left the hardcoded `<Player>` `LowerThird` as the only thing
 *  on top — wrong for every project that isn't the Move-5 demo. Graphic clips are
 *  still excluded (here AND per-clip in `resolveLayerOnTrack`), so the Remotion seam
 *  is unchanged where a real graphic clip is present. */
function overlayTrackIndices(timeline: Timeline, frame: number): Set<number> {
  const out = new Set<number>();
  for (const t of timeline.transitions) {
    if (!OVERLAY_BLEND_SERVICES.has(t.service)) continue;
    const videoIndex = videoIndexOfMainTractor(t.bTrack);
    const track = timeline.tracks.video[videoIndex];
    if (!track) continue;
    // Skip the track ONLY when the clip covering this frame is a graphic clip the
    // `<Player>` owns. `resolveLayerOnTrack` returns a layer for a non-graphic clip
    // and null for a graphic one; a non-null result here means "footage to draw".
    const layer = resolveLayerOnTrack(track, videoIndex, frame);
    if (layer === null && coversWithGraphic(track, frame)) out.add(videoIndex);
  }
  return out;
}

/** True iff a GRAPHIC clip covers `frame` on `track` — the case where
 *  `resolveLayerOnTrack` returned null because the `<Player>` owns the layer (as
 *  opposed to null for a blank / past-the-end, where nothing is drawn anyway).
 *  Mirrors `resolveLayerOnTrack`'s dissolve-trimming placement walk so the coverage
 *  test lines up frame-exactly. */
function coversWithGraphic(track: Track, frame: number): boolean {
  if (track.hidden) return false;
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
      cursor += it.frames;
      continue;
    }
    const before = items[i - 1];
    const after = items[i + 1];
    const trimHead = before?.kind === "dissolve" ? before.frames : 0;
    const trimTail = after?.kind === "dissolve" ? after.frames : 0;
    const segLen = it.out - trimTail - (it.in + trimHead) + 1;
    if (segLen <= 0) continue;
    const start = cursor;
    cursor += segLen;
    if (frame < start || frame >= start + segLen) continue;
    return isGraphic(it);
  }
  return false;
}

/** The fade-sentinel filter services the builder emits (mirror of
 *  `src/ir/builder.ts` FADE_IN_SERVICE / FADE_OUT_SERVICE). A clip's `fadeIn` /
 *  `fadeOut` arrive as `{ service: "vean.fadeIn", properties: { frames: N } }`. */
const FADE_IN_SERVICE = "vean.fadeIn";
const FADE_OUT_SERVICE = "vean.fadeOut";

/** What a single composited layer is. `solid` is a color-fill quad (a `color`
 *  clip); `footage` is a decoded video frame (keyed by `uuid` + `sourceFrame`);
 *  `dissolve` is a same-track crossfade between two sub-layers at `progress`. */
export type Layer = SolidLayer | FootageLayer | DissolveLayer;

/** Common z-ordering + opacity carried by every top-level layer. Lower
 *  `trackIndex` = lower z (drawn first); upper tracks composite on top. */
interface LayerBase {
  /** The 0-based `tracks.video` index this layer lives on (its z-order). */
  trackIndex: number;
  /** Resolved alpha 0..1 at the frame (fade in/out + the animation escape hatch).
   *  1 when no fade/opacity filter applies. */
  opacity: number;
  /** True iff this layer carries a service the browser maps only `approximate`ly
   *  (§7) — a non-default blur kernel, a frei0r filter, an unknown blend. The
   *  compositor may overlay an on-demand `melt` still for the frame (§6.3). */
  approximate: boolean;
  /** Exact destination rectangle in normalized canvas coordinates (top-left
   * origin). Resolved from qtblend.rect, or affine transition.rect when no field
   * qtblend owns the track. */
  geometry: LayerGeometry;
}

export type LayerGeometry = { x: number; y: number; width: number; height: number };
const FULL_GEOMETRY: LayerGeometry = { x: 0, y: 0, width: 1, height: 1 };

export interface SolidLayer extends LayerBase {
  kind: "solid";
  /** The clip's stable producer uuid (identity for caches / diagnostics). */
  uuid: string;
  /** `#RRGGBB` / `#AARRGGBB` / named color — the `color` clip's `resource`. */
  color: string;
}

export interface FootageLayer extends LayerBase {
  kind: "footage";
  uuid: string;
  /** Absolute/relative source path the decoder demuxes (the proxy is built from
   *  this). */
  resource: string;
  /** Integer SOURCE frame = `clip.in + (frame - clipStart)`, clamped to
   *  `[in, out]`. The compositor converts to seconds at the decode boundary. */
  sourceFrame: number;
  in: number;
  out: number;
}

export interface DissolveLayer extends LayerBase {
  kind: "dissolve";
  /** The OUTGOING (tail of the preceding clip) sub-layer. */
  from: SolidLayer | FootageLayer;
  /** The INCOMING (head of the following clip) sub-layer. */
  to: SolidLayer | FootageLayer;
  /** Crossfade progress 0..1 = `(frame - dissolveStart) / (frames - 1)` clamped.
   *  At 0 the frame is all `from`; at 1 all `to`. */
  progress: number;
  /** The MLT video transition service (`luma` default). A bare `luma` (no luma
   *  file) is the exact `mix(from,to,progress)` fade; a luma-file matte wipe is
   *  Tier-1-exact via the luma shader (§7) — but vean's same-track dissolve only
   *  carries a service name here, so the compositor treats `luma` as the fade. */
  service: string;
}

/** The resolved z-stack at a frame: layers ordered BOTTOM-UP (index 0 = lowest z).
 *  `renderFrame` draws them in this order onto a black canvas. */
export interface ResolvedFrame {
  layers: Layer[];
  /** True iff ANY layer is `approximate` — the compositor surfaces the optional
   *  `melt`-still affordance for the frame (§6.3). */
  hasApproximate: boolean;
}

/** Is this clip a Remotion graphic overlay? Those are drawn by the
 *  `@remotion/player` overlay ON TOP of the compositor canvas (unchanged), so they
 *  are NOT footage/solid layers here (DESIGN §4: two compositors, one editor
 *  track). */
function isGraphic(item: Item): boolean {
  return item.kind === "clip" && isGraphicClip(item);
}

/** Is this a `color` clip (a solid fill, not a decodable file)? */
function isColorClip(clip: ClipItem): boolean {
  return clip.service === "color";
}

/** The services the browser composites EXACTLY (§7). Everything else on a clip's
 *  filter list flags the layer `approximate` → optional `melt`-still fallback. */
const EXACT_FILTER_SERVICES = new Set([
  FADE_IN_SERVICE,
  FADE_OUT_SERVICE,
  "brightness", // fade level (resolved to opacity) — §7 exact
  "volume", // audio gain/fade — handled on the audio path, visually a no-op
  "panner",
  "affine", // transition.rect is resolved exactly below
]);

/** Resolve a static or animated MLT rect into normalized canvas geometry. Rect
 * keyframes use absolute timeline frames on field transitions and clip-local
 * frames on affine filters; the caller supplies the correct coordinate. */
function resolveGeometry(
  raw: string,
  frame: number,
  width: number,
  height: number,
  length: number,
): { geometry: LayerGeometry; opacity: number } | null {
  if (!raw.trim()) return null;
  // The generic keyframe grammar intentionally carries percent-valued x/y/w/h
  // rects as opaque (only rect opacity is percent in that core grammar), while
  // qtblend explicitly allows all-four-percent geometry. Normalize those four
  // coordinates to fractions for this service-specific resolver before using the
  // shared interpolator; the canonical property string remains untouched.
  const normalizePercentRect = (value: string): string =>
    value
      .split(";")
      .map((entry) => {
        const eq = entry.lastIndexOf("=");
        const lhs = eq >= 0 ? entry.slice(0, eq + 1) : "";
        const body = eq >= 0 ? entry.slice(eq + 1) : entry;
        const parts = body.trim().split(/\s+/);
        if (parts.length !== 5 || !parts.slice(0, 4).every((part) => part.endsWith("%"))) {
          return entry;
        }
        const normalized = parts.map((part, index) =>
          index < 4 ? String(Number.parseFloat(part.slice(0, -1)) / 100) : part,
        );
        return `${lhs}${normalized.join(" ")}`;
      })
      .join(";");
  const value = valueAtFrame(parseAnim(normalizePercentRect(raw)), frame, { length });
  if (!value || value.type !== "rect") return null;
  const rect = value as RectValue;
  // Percent coordinates are parsed as fractions by the shared keyframe port.
  // MLT requires all rect coordinates to share the unit, so one `%` token is a
  // sufficient discriminator for x/y/w/h.
  const percent = raw.includes("%");
  const x = percent ? rect.x : rect.x / width;
  const y = percent ? rect.y : rect.y / height;
  const w = percent ? rect.w : rect.w / width;
  const h = percent ? rect.h : rect.h / height;
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  return {
    geometry: { x, y, width: w, height: h },
    opacity: Math.min(1, Math.max(0, rect.opacity)),
  };
}

/** Resolve a clip's visual ALPHA at a 0-based segment frame `segFrame` (0 = the
 *  segment's first played frame), plus whether it carries an `approximate`
 *  service. Mirrors the serializer's fade compilation (`resolveFades`) and the
 *  keyframe engine: a head fade ramps 0→1 over `fadeIn` frames, a tail fade 1→0
 *  over the last `fadeOut`. The `brightness`/`level` animation-string form (and
 *  the escape-hatch `opacity`) resolve through the shared keyframe resolver so the
 *  ramp is byte-faithful to the exporter (§4 step 3, §8.1). */
function resolveClipVisual(
  clip: ClipItem,
  segFrame: number,
  segLen: number,
  profile: Timeline["profile"],
): { opacity: number; approximate: boolean; geometry: LayerGeometry } {
  let opacity = 1;
  let approximate = false;
  let geometry = FULL_GEOMETRY;
  for (const f of clip.filters ?? []) {
    if (f.service === FADE_IN_SERVICE) {
      const n = Number(f.properties.frames ?? 0);
      if (n > 0 && segFrame < n) {
        // The serializer emits `0=0; n-1=1` (linear). Match it exactly.
        opacity *= Math.min(1, Math.max(0, n <= 1 ? 1 : segFrame / (n - 1)));
      }
    } else if (f.service === FADE_OUT_SERVICE) {
      const n = Number(f.properties.frames ?? 0);
      if (n > 0 && segFrame > segLen - 1 - n) {
        // `len-n=1; len-1=0` (linear).
        const into = segFrame - (segLen - n);
        opacity *= Math.min(1, Math.max(0, n <= 1 ? 0 : 1 - into / (n - 1)));
      }
    } else if (f.service === "brightness" && typeof f.properties.level === "string") {
      // A `brightness` fade compiled to a `level` keyframe string (`0=0;n-1=1`):
      // resolve it through the shared engine and multiply RGB ≈ alpha (§7 exact).
      const raw = String(f.properties.level);
      if (isAnimated(raw)) {
        const v = valueAtFrame(parseAnim(raw), segFrame, { length: segLen });
        const s = v ? scalarOf(v) : null;
        if (s != null) opacity *= Math.min(1, Math.max(0, s));
      }
    } else if (f.service === "opacity" || f.service === "qtblend") {
      // The escape-hatch opacity (or a qtblend with an opacity string) — exact.
      const raw = String(f.properties.opacity ?? f.properties.level ?? "");
      if (raw && isAnimated(raw)) {
        const v = valueAtFrame(parseAnim(raw), segFrame, { length: segLen });
        const s = v ? scalarOf(v) : null;
        if (s != null) opacity *= Math.min(1, Math.max(0, s));
      } else if (raw) {
        const n = Number(raw);
        if (Number.isFinite(n)) opacity *= Math.min(1, Math.max(0, n));
      }
    } else if (f.service === "affine" && f.properties["transition.rect"] != null) {
      const resolved = resolveGeometry(
        String(f.properties["transition.rect"]),
        segFrame,
        profile.width,
        profile.height,
        segLen,
      );
      if (resolved) {
        geometry = resolved.geometry;
        opacity *= resolved.opacity;
      }
    } else if (!EXACT_FILTER_SERVICES.has(f.service)) {
      // A blur / frei0r / unknown color op the browser can't match — §7 approximate.
      approximate = true;
    }
  }
  return { opacity, approximate, geometry };
}

/** Build the base sub-layer (solid or footage) for a clip covering source-frame
 *  `sourceFrame`, at z `trackIndex`, with resolved `opacity`/`approximate`. Used
 *  for a solo segment AND for each side of a dissolve. */
function clipLayer(
  clip: ClipItem,
  sourceFrame: number,
  trackIndex: number,
  opacity: number,
  approximate: boolean,
  geometry: LayerGeometry = FULL_GEOMETRY,
): SolidLayer | FootageLayer {
  if (isColorClip(clip)) {
    return {
      kind: "solid",
      trackIndex,
      opacity,
      approximate,
      geometry,
      uuid: clip.id,
      color: clip.resource,
    };
  }
  return {
    kind: "footage",
    trackIndex,
    opacity,
    approximate,
    geometry,
    uuid: clip.id,
    resource: clip.resource,
    sourceFrame,
    in: clip.in,
    out: clip.out,
  };
}

/**
 * Resolve the layer (or dissolve crossfade) covering integer timeline `frame` on
 * video `trackIndex`, mirroring `walkTrack`'s dissolve-trimming placement EXACTLY.
 * Returns `null` for a blank, a graphic-only span, or past the track's end.
 *
 * Placement walk (the load-bearing mirror): a cursor advances by each item's
 * PLACED length — a clip placed AT a dissolve edge is trimmed by the dissolve
 * frames (so solo segments don't double-count the overlap), and a `dissolve(d)`
 * occupies `d` frames between its trimmed neighbours.
 */
export function resolveLayerOnTrack(
  track: Track,
  trackIndex: number,
  frame: number,
  profile?: Timeline["profile"],
): Layer | null {
  if (track.hidden) return null;
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
      const d = it.frames;
      const prev = items[i - 1];
      const next = items[i + 1];
      const start = cursor;
      cursor += d;
      if (frame < start || frame >= start + d) continue;
      // Inside the crossfade. prev's tail (its last d source frames) dissolves into
      // next's head (its first d source frames). Mirrors `walkTrack`'s dissolve
      // producers: a = prev[out-d+1 .. out], b = next[in .. in+d-1].
      if (prev?.kind !== "clip" || next?.kind !== "clip") return null;
      const into = frame - start; // 0 .. d-1
      const fromSrc = Math.min(prev.out, prev.out - d + 1 + into);
      const toSrc = Math.min(next.out, next.in + into);
      // Dissolve edges drop their own fades (a cross-fade governs the edge —
      // `walkTrack` calls `dropFades`); opacity here is the crossfade, not a fade.
      const fromApprox = clipApproximate(prev);
      const toApprox = clipApproximate(next);
      const from = clipLayer(prev, fromSrc, trackIndex, 1, fromApprox);
      const to = clipLayer(next, toSrc, trackIndex, 1, toApprox);
      const progress = d <= 1 ? 1 : into / (d - 1);
      return {
        kind: "dissolve",
        trackIndex,
        opacity: 1,
        approximate: fromApprox || toApprox,
        geometry: FULL_GEOMETRY,
        from,
        to,
        progress,
        service: it.luma ?? "luma",
      };
    }

    // A clip — trim head/tail for adjacent dissolves (those frames are owned by the
    // dissolve tractor), exactly like `walkTrack`.
    const before = items[i - 1];
    const after = items[i + 1];
    const trimHead = before?.kind === "dissolve" ? before.frames : 0;
    const trimTail = after?.kind === "dissolve" ? after.frames : 0;
    const inn = it.in + trimHead;
    const out = it.out - trimTail;
    if (out < inn) continue; // wholly consumed by its dissolve(s) — no solo segment
    const segLen = out - inn + 1;
    const start = cursor;
    cursor += segLen;
    if (frame < start || frame >= start + segLen) continue;
    if (isGraphic(it)) return null; // graphic → drawn by the Remotion overlay, not here
    const segFrame = frame - start; // 0-based within the played segment
    const sourceFrame = Math.min(out, Math.max(inn, inn + segFrame));
    const { opacity, approximate, geometry } = resolveClipVisual(
      it,
      segFrame,
      segLen,
      profile ?? {
        description: "fallback",
        width: 1,
        height: 1,
        fps: [1, 1],
        displayAspectNum: 1,
        displayAspectDen: 1,
      },
    );
    return clipLayer(it, sourceFrame, trackIndex, opacity, approximate, geometry);
  }
  return null;
}

/** Does this clip carry any non-exact (`approximate`) filter service (§7)? Cheap
 *  pre-check for dissolve edges (which drop fades but may still carry a blur). */
function clipApproximate(clip: ClipItem): boolean {
  for (const f of clip.filters ?? []) {
    if (
      !EXACT_FILTER_SERVICES.has(f.service) &&
      f.service !== "opacity" &&
      f.service !== "qtblend"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the FULL z-stack at integer timeline `frame` across every video track,
 * ordered BOTTOM-UP (lowest track index first = lowest z). This is what the
 * WebGL2 compositor draws onto a black canvas, in order, each layer composited
 * OVER the accumulation below it (the live equivalent of MLT's track stack +
 * `qtblend` over-composite, §4 step 4, §7).
 *
 * Graphic (Remotion) clips are excluded — they are the `@remotion/player` overlay
 * drawn ON TOP of this canvas (DESIGN §4). A track with no covering footage/solid
 * at the frame contributes nothing (the layer below — or black — shows through).
 */
export function resolveLayers(timeline: Timeline, frame: number): ResolvedFrame {
  const layers: Layer[] = [];
  let hasApproximate = false;
  // Tracks owned by the Remotion overlay (the bTrack of a qtblend over-composite)
  // are drawn by the `@remotion/player`, NOT here — skip them so the footage base
  // shows as the compositor's footage and the overlay reveals it (§4, §7).
  const overlayTracks = overlayTrackIndices(timeline, frame);
  for (let i = 0; i < timeline.tracks.video.length; i++) {
    if (overlayTracks.has(i)) continue;
    const track = timeline.tracks.video[i];
    if (!track) continue;
    const layer = resolveLayerOnTrack(track, i, frame, timeline.profile);
    if (layer) {
      // A field qtblend is the authoritative transform for its B track. Prefer
      // the last active transition, matching MLT document order when actions
      // replace/append topology. Its keyframes live in absolute timeline space.
      const bTrack = i + 1;
      const blend = [...timeline.transitions]
        .reverse()
        .find(
          (transition) =>
            OVERLAY_BLEND_SERVICES.has(transition.service) &&
            transition.bTrack === bTrack &&
            frame >= transition.in &&
            frame <= transition.out &&
            transition.properties.rect != null,
        );
      if (blend) {
        const resolved = resolveGeometry(
          String(blend.properties.rect),
          frame,
          timeline.profile.width,
          timeline.profile.height,
          Math.max(1, blend.out + 1),
        );
        if (resolved) {
          layer.geometry = resolved.geometry;
          layer.opacity *= resolved.opacity;
        }
      }
      layers.push(layer);
      if (layer.approximate) hasApproximate = true;
    }
  }
  return { layers, hasApproximate };
}
