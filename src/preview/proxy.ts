// The footage PROXY builder for the live viewer (Move 5, Phase B).
//
// The composited preview pane needs the FOOTAGE layer as a normal `<video>`
// element so the editor can scrub/play it with audio, while an `@remotion/player`
// renders the Remotion graphic OVER it. To avoid double-compositing (the proxy
// already baking in the qtblend overlay AND the live Player drawing it again), we
// render a low-res mp4 of the timeline with the Remotion graphic clips and their
// qtblend field transitions STRIPPED. The proxy therefore carries footage + audio
// only; the overlay comes from the live Player.
//
// This is a READ-SIDE derivation for preview only — it is NEVER written back to
// the canonical .mlt. The strip transform (`stripGraphics`) is a pure function on
// a cloned IR (no op, no mutation of `state`), so it is unit-testable without any
// subprocess. The actual low-res render shells out to `melt` via the existing
// arm's-length driver (a separate process — never linking libmlt). The proxy and
// its temp stripped .mlt are cached under `.vean/cache/proxy/` (gitignored).
//
// Decided per the Move 5 gate "Decide audio ownership: MLT mixes; Remotion clips
// rendered video-only": the proxy is the ONLY audio source in the live preview;
// Remotion overlays are silent.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { timelineLength } from "../ir/length";
import { fromMlt } from "../ir/parse";
import { toMlt } from "../ir/serialize";
import type { Clip, Timeline, Track } from "../ir/types";

// The cache dir is `<repo>/.vean/cache/proxy`. We compute the `.vean` path
// LOCALLY here (a pure `resolve`) rather than importing `stateDir` from
// `../state/db`, because that module pulls in `bun:sqlite` — which a Node/Vitest
// process can't resolve. Keeping this module free of the SQLite import is what
// lets the pure strip transform (`stripGraphics`) be unit-tested in vitest.
const STATE_DIR_NAME = ".vean";

/** The directory holding cached proxies + their stripped .mlt sources. */
export function proxyCacheDir(repo = process.cwd()): string {
  return resolve(repo, STATE_DIR_NAME, "cache", "proxy");
}

/** True iff a clip is a Remotion GRAPHIC overlay (to be stripped from the proxy).
 *
 *  Two signals, either sufficient:
 *   1. its `label` starts with `graphic` (the `timeline.addGraphic` convention —
 *      the label is `"<label>:<clipPath>"`, default label `"graphic"`), or
 *   2. its `resource` points inside the Remotion render cache
 *      (`.vean/cache/remotion`), which is where rendered overlays live.
 *
 *  Robust to either path: a hand-authored overlay labelled `graphic:` is caught,
 *  AND a clip whose resource is a cached `.mov` is caught even if unlabelled. */
export function isGraphicClip(clip: Clip): boolean {
  if (clip.label && /^graphic\b/i.test(clip.label)) return true;
  const resource = clip.resource.replace(/\\/g, "/");
  return resource.includes("/.vean/cache/remotion/") || /cache\/remotion\//.test(resource);
}

/** True iff `track` carries any graphic overlay clip. */
function trackHasGraphic(track: Track): boolean {
  return track.items.some((item) => item.kind === "clip" && isGraphicClip(item));
}

/** Result of the pure strip transform. */
export type StripResult = {
  /** The derived IR with graphic clips + their qtblend transitions removed. */
  timeline: Timeline;
  /** 0-based `tracks.video` indices that were entirely graphics (now dropped). */
  removedVideoTrackIndices: number[];
  /** Count of graphic clips removed across all kept tracks. */
  removedClipCount: number;
  /** Count of field transitions (qtblend etc.) removed. */
  removedTransitionCount: number;
};

/**
 * Derive a footage+audio-only copy of `timeline` for the preview proxy: remove
 * every Remotion graphic overlay clip and the field transitions that reference
 * the graphics track. PURE — `timeline` is never mutated; a deep clone is
 * returned. Footage video tracks and ALL audio tracks are kept intact.
 *
 * Strip strategy:
 *   • A video track that is ENTIRELY graphic clips is dropped (it only existed to
 *     host the overlay — e.g. the GFX track `timeline.addGraphic` appends). Its
 *     main-tractor index disappears, so any field transition that referenced it is
 *     also dropped.
 *   • A video track that MIXES footage and graphics keeps the footage, with the
 *     graphic clips replaced by equal-length blanks (so footage timing/positions
 *     downstream of the overlay are preserved exactly).
 *   • Field transitions whose B (or A) track was a dropped graphics track are
 *     removed; remaining transitions are re-indexed against the kept track order.
 */
export function stripGraphics(timeline: Timeline): StripResult {
  // Deep clone — never touch the caller's IR (JSON clone is safe: the IR is plain
  // data, no functions/dates/undefined-bearing fields beyond optionals).
  const clone: Timeline = JSON.parse(JSON.stringify(timeline));

  const removedVideoTrackIndices: number[] = [];
  let removedClipCount = 0;

  // The original main-tractor index of each video track is `1 + videoIndex`
  // (background at 0). Build a map from the ORIGINAL index → the kept track (or
  // null if dropped) so we can re-index transitions afterwards.
  const keptVideo: Track[] = [];
  // originalMainIndex → newMainIndex (or null if the track was dropped).
  const remap = new Map<number, number | null>();
  // Background producer is index 0 in both old and new.
  remap.set(0, 0);

  clone.tracks.video.forEach((track, videoIndex) => {
    const originalMainIndex = 1 + videoIndex;
    if (trackHasGraphic(track) && track.items.every((i) => i.kind !== "clip" || isGraphicClip(i))) {
      // Entirely-graphic track → drop it.
      removedClipCount += track.items.filter((i) => i.kind === "clip").length;
      removedVideoTrackIndices.push(videoIndex);
      remap.set(originalMainIndex, null);
      return;
    }
    if (trackHasGraphic(track)) {
      // Mixed track → replace each graphic clip with an equal-length blank so the
      // footage clips keep their exact positions.
      track.items = track.items.map((item) => {
        if (item.kind === "clip" && isGraphicClip(item)) {
          removedClipCount += 1;
          const length = item.out - item.in + 1;
          return { kind: "blank" as const, length: Math.max(1, length) };
        }
        return item;
      });
    }
    const newMainIndex = 1 + keptVideo.length;
    remap.set(originalMainIndex, newMainIndex);
    keptVideo.push(track);
  });

  // Audio tracks: kept verbatim. Their original main index is
  // `1 + video.length + audioIndex`; the new one shifts down by the number of
  // dropped video tracks.
  const droppedVideoCount = removedVideoTrackIndices.length;
  clone.tracks.audio.forEach((_track, audioIndex) => {
    const originalMainIndex = 1 + clone.tracks.video.length + audioIndex;
    const newMainIndex = 1 + keptVideo.length + audioIndex;
    remap.set(originalMainIndex, newMainIndex);
  });
  void droppedVideoCount;

  // Re-index (or drop) field transitions: a transition is removed if EITHER of
  // its tracks was dropped (a graphics track); otherwise re-map both indices.
  const keptTransitions = [];
  let removedTransitionCount = 0;
  for (const t of clone.transitions) {
    const a = remap.get(t.aTrack);
    const b = remap.get(t.bTrack);
    if (a == null || b == null) {
      removedTransitionCount += 1;
      continue;
    }
    keptTransitions.push({ ...t, aTrack: a, bTrack: b });
  }

  clone.tracks.video = keptVideo;
  clone.transitions = keptTransitions;

  return {
    timeline: clone,
    removedVideoTrackIndices,
    removedClipCount,
    removedTransitionCount,
  };
}

/** The total frame length of a timeline = the longest track. Delegates to the
 *  canonical {@link timelineLength} so the proxy frame bound + the viewer clock's
 *  `totalFrames` match the serializer's `maxLength` EXACTLY — including the
 *  dissolve-overlap subtraction a naive sum-of-lengths would get wrong (which
 *  would run the playhead past the real EOF). Re-exported here for the server +
 *  tests that import it from this module. */
export function totalFrames(timeline: Timeline): number {
  return timelineLength(timeline);
}

export type ProxyResult = {
  /** Absolute path to the produced low-res mp4. */
  proxyPath: string;
  /** Rational fps `[num, den]` from the profile. */
  fps: [number, number];
  /** Total timeline frames (the proxy duration in frames). */
  totalFrames: number;
  /** Proxy pixel width. */
  width: number;
  /** Proxy pixel height. */
  height: number;
  /** True iff the proxy was served from cache (no re-render). */
  cached: boolean;
};

export type BuildProxyOpts = {
  /** Downscale factor for the proxy (default 0.5 → half-res). */
  scale?: number;
  /** Bypass the cache and force a fresh render. */
  force?: boolean;
};

/** Round to an even integer ≥ 2 (h264 needs even dimensions). */
function evenDim(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

/**
 * Build the footage+audio-only low-res proxy for `mltPath`. Parses the timeline,
 * strips the graphics layer, serializes a temp stripped `.mlt`, and drives `melt`
 * to a small mp4 carrying footage video + mixed audio. Content-addressed: the
 * cache key is a hash of the STRIPPED .mlt XML + scale, so editing footage
 * invalidates the proxy while ADDING a graphic does not (graphics are stripped).
 */
export async function buildFootageProxy(
  repo: string,
  mltPath: string,
  opts: BuildProxyOpts = {},
): Promise<ProxyResult> {
  const scale = opts.scale ?? 0.5;
  const xml = await Bun.file(mltPath).text();
  const timeline = fromMlt(xml);
  const { timeline: stripped } = stripGraphics(timeline);
  const strippedXml = toMlt(stripped);

  const width = evenDim(timeline.profile.width * scale);
  const height = evenDim(timeline.profile.height * scale);
  const fps: [number, number] = [timeline.profile.fps[0], timeline.profile.fps[1]];
  const frames = totalFrames(timeline);

  const key = createHash("sha256")
    .update(`${strippedXml}::${width}x${height}`)
    .digest("hex")
    .slice(0, 32);

  const dir = proxyCacheDir(repo);
  mkdirSync(dir, { recursive: true });
  const proxyPath = join(dir, `${key}.mp4`);
  const strippedMltPath = join(dir, `${key}.mlt`);

  if (!opts.force && existsSync(proxyPath)) {
    return { proxyPath, fps, totalFrames: frames, width, height, cached: true };
  }

  await Bun.write(strippedMltPath, strippedXml);

  // Drive melt at low res with footage + AAC audio (the proxy carries sound).
  //
  // Scaling is done by rendering onto a downscaled `scaleProfile`, NOT a consumer
  // `s=<w>x<h>` arg: on melt 7.38 the avformat consumer's own rescale stalls at
  // 99% and writes a 48-byte moov-less file (single-variable bisected against the
  // corpus; multitrack instead segfaults). `frames` hard-bounds the render to the
  // exact timeline length so a synthetic/unbounded-producer timeline still reaches
  // EOF. `acodec=aac`/`ab=128k` keep an audio stream the `<video>` can play.
  const { render } = await import("../driver/melt");
  await render(strippedMltPath, proxyPath, {
    vcodec: "libx264",
    pixFmt: "yuv420p",
    frames,
    scaleProfile: {
      width,
      height,
      fps,
      sampleAspectNum: timeline.profile.sampleAspectNum,
      sampleAspectDen: timeline.profile.sampleAspectDen,
    },
    extraArgs: ["acodec=aac", "ab=128k"],
  });

  return { proxyPath, fps, totalFrames: frames, width, height, cached: false };
}
