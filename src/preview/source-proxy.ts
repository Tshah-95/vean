// The PER-SOURCE short-GOP H.264 proxy builder for the live in-browser decode path
// (DESIGN-LIVE-PREVIEW §5, §8.2, §9 step 3).
//
// WHY this exists (the codec decision, settled by the spike, §8.2): the live
// decode source for the WebGL `renderFrame` compositor is mediabunny → WebCodecs,
// and WebCodecs cannot reliably decode the user's footage:
//   • HEVC (`hvc1`) is HARDWARE-ONLY in Chrome — ~8.5% of sessions can't decode it
//     at all (no software fallback), and a headless Chromium often lacks the HW
//     path entirely, so feeding raw HEVC to the worker is a black frame.
//   • ProRes 4444 (the Remotion alpha-export format) is not WebCodecs-decodable.
// The decision: build a lightweight **H.264** proxy for the live decode path —
// `avc1` decodes everywhere (HW or SW). This is the SAME H.264 encode the whole-
// timeline preview proxy (`proxy.ts`) already does; the difference is (1) it is
// PER SOURCE FILE (not the whole timeline), so the worker demuxes one stable
// artifact per producer UUID and seeks within it, and (2) it uses a SHORT GOP
// (`-g 15`) so worst-case random-access seek collapses toward a single keyframe
// (~6ms; the spike measured the proxy at median 13.6ms / max 21.3ms vs HEVC max
// 35.9ms). Short GOP is the scrub-latency lever named in §8.2.
//
// This is a READ-SIDE derivation for preview only — never written back to the
// canonical `.mlt`. It shells out to `melt` via the existing arm's-length driver
// (a separate process — never linking libmlt; Hard boundary #1/#2). The artifact
// is content-addressed by (source path · mtime · size · scale · gop) and cached
// under `.vean/cache/source-proxy/` (gitignored), so re-decoding the same source
// across edits never re-encodes, while replacing the file on disk invalidates it.
//
// IMPORTANT — this builds the artifact; it does NOT decode it. Decode happens in
// the browser (`viewer/src/decode/`), off the `melt` boundary entirely. `melt`
// here is a transcode-once step, NOT in the scrub loop.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const STATE_DIR_NAME = ".vean";

/** The directory holding cached per-source H.264 decode proxies. Distinct from the
 *  whole-timeline proxy dir (`proxyCacheDir`) — these are per-source-file artifacts
 *  the in-browser decoder demuxes, not a composited timeline render. */
export function sourceProxyCacheDir(repo = process.cwd()): string {
  return resolve(repo, STATE_DIR_NAME, "cache", "source-proxy");
}

/** Round to an even integer ≥ 2 (h264 needs even dimensions). */
function evenDim(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export type SourceProxyOpts = {
  /** Longest-edge cap in pixels for the proxy (default 960 — the spike's scrub
   *  sweet spot: 960×540 median seek 13.6ms). The source is downscaled to fit this
   *  box preserving aspect; never upscaled. */
  maxEdge?: number;
  /** GOP length in frames (default 15 — short GOP for instant random access; a
   *  seek lands within at most `gop−1` frames of a keyframe). */
  gop?: number;
  /** Bypass the cache and force a fresh encode. */
  force?: boolean;
};

export type SourceProxyResult = {
  /** Absolute path to the produced short-GOP H.264 mp4. */
  proxyPath: string;
  /** The content-address cache key (also the basename without extension). */
  key: string;
  /** Proxy pixel width (even). */
  width: number;
  /** Proxy pixel height (even). */
  height: number;
  /** True iff served from cache (no re-encode). */
  cached: boolean;
};

/** Content-address key for a source proxy: a hash of the resolved source path, its
 *  on-disk mtime + size (so replacing the file invalidates the proxy), and the
 *  encode params. 32 hex chars — collision-safe for a per-project cache. */
function proxyKey(
  resolvedSource: string,
  mtimeMs: number,
  size: number,
  maxEdge: number,
  gop: number,
): string {
  return createHash("sha256")
    .update(`${resolvedSource}::${mtimeMs}::${size}::${maxEdge}::g${gop}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Build (or hit the cache for) the per-source short-GOP H.264 decode proxy for one
 * source media file. PURE w.r.t. the timeline IR — it transcodes a single file, so
 * it has no knowledge of placement/edits; the artifact is keyed by the source, not
 * the timeline, which is exactly why it survives ripple/trim edits that only move
 * the clip (the decode cache identity is the producer UUID, the artifact identity
 * is the source file).
 *
 * `srcPath` MUST already be authorized by the caller (the server checks it against
 * the live timeline's referenced-resource allowlist before calling this — this fn
 * does not re-authorize; it transcodes whatever path it's handed).
 */
export async function buildSourceProxy(
  repo: string,
  srcPath: string,
  opts: SourceProxyOpts = {},
): Promise<SourceProxyResult> {
  const maxEdge = opts.maxEdge ?? 960;
  const gop = opts.gop ?? 15;
  const resolvedSource = resolve(srcPath);
  if (!existsSync(resolvedSource)) {
    throw new Error(`source-proxy: source not found: ${resolvedSource}`);
  }
  const stat = statSync(resolvedSource);
  const key = proxyKey(resolvedSource, stat.mtimeMs, stat.size, maxEdge, gop);

  const dir = sourceProxyCacheDir(repo);
  mkdirSync(dir, { recursive: true });
  const proxyPath = join(dir, `${key}.mp4`);

  // Probe the source dimensions to compute the downscaled (aspect-preserving) box.
  // A probe failure falls back to maxEdge×maxEdge — the proxy still decodes; only
  // the aspect could be off (the compositor letterboxes/fits anyway).
  const { width, height } = await proxyDimensions(resolvedSource, maxEdge);

  if (!opts.force && existsSync(proxyPath)) {
    return { proxyPath, key, width, height, cached: true };
  }

  // Drive melt to a small short-GOP H.264, NO audio (the decode path is video-only;
  // audio stays on the old proxy `<video>` / Web Audio per the tiered plan). The
  // `g`/`keyint`/`keyint_min` triple pins the GOP so EVERY ~15th frame is a
  // keyframe — the random-access seek lever (§8.2). `bf=0` disables B-frames so the
  // decoder never reorders (the spike's "push-N-then-collect" deadlock, §8.5, is
  // avoided wholesale — mediabunny handles ordering, but an all-reference stream is
  // strictly cheaper to seek). Scaling is done via a downscaled `scaleProfile`, NOT
  // a consumer `s=` rescale, which stalls melt 7.38 at 99% (the proxy.ts lesson).
  const { render } = await import("../driver/melt");
  await render(resolvedSource, proxyPath, {
    vcodec: "libx264",
    pixFmt: "yuv420p",
    scaleProfile: { width, height, fps: [30, 1] },
    extraArgs: [
      "an=1", // no audio stream in the decode proxy
      `g=${gop}`,
      `keyint_min=${gop}`,
      "bf=0",
      // melt's avformat consumer forwards `x264opts` to libx264; pin the GOP there
      // too so a libx264 default scenecut/keyint can't override the short GOP.
      `x264opts=keyint=${gop}:min-keyint=${gop}:scenecut=0:bframes=0`,
    ],
  });

  return { proxyPath, key, width, height, cached: false };
}

/** Probe a source file's video dimensions via ffprobe and compute an aspect-
 *  preserving downscale that fits within `maxEdge` (never upscaling). Falls back to
 *  a square `maxEdge` box if the probe fails or reports nothing usable. */
async function proxyDimensions(
  resolvedSource: string,
  maxEdge: number,
): Promise<{ width: number; height: number }> {
  let srcW = 0;
  let srcH = 0;
  try {
    const { probeSource } = await import("../driver/probe");
    const info = await probeSource(resolvedSource);
    srcW = info?.width ?? 0;
    srcH = info?.height ?? 0;
  } catch {
    // ffprobe missing / source unprobeable — fall through to the square fallback.
  }
  if (srcW <= 0 || srcH <= 0) {
    return { width: evenDim(maxEdge), height: evenDim(maxEdge) };
  }
  const longest = Math.max(srcW, srcH);
  const scale = longest > maxEdge ? maxEdge / longest : 1; // never upscale
  return { width: evenDim(srcW * scale), height: evenDim(srcH * scale) };
}
