// Source-media PROBE — the driver-layer ffprobe that reads facts the IR does NOT
// carry: a source file's TRUE frame rate (and whether it is variable). The
// diagnostics ENGINE is pure (no I/O) and can only judge what the IR records (the
// profile fps); the source's real fps is a property of the file on disk, so per
// AGENTS.md ("a fact the IR doesn't carry … is left to the DRIVER layer, surfaced
// through this same Diagnostic type") it is probed HERE and fed to the pure rule in
// `src/diagnostics/probe.ts`.
//
// Arm's-length, like the rest of the driver: shells out to the `ffprobe` BINARY as
// a separate process (never linking libav — Hard boundary #1). Files in, facts out.
//
// VFR detection rests on the two rates ffprobe reports per stream:
//   • r_frame_rate   — the "base"/nominal rate (the max tick; a CFR file's real
//     rate, a VFR file's CEILING). This is the value a naive importer reads as "the
//     fps" — phone footage advertises 30/1 here even when it never sustains 30.
//   • avg_frame_rate — frames ÷ duration, the TRUE average. For a clean CFR file it
//     EQUALS r_frame_rate; for VFR (Pixel/iPhone) it is lower and the gap is the
//     VFR signal.
//
// This probe is ALSO the media-catalog grade probe: alongside the rate facts it
// reads the source's pixel dimensions (so the diagnostics can tell upscaling from a
// SMALLER source), its COLORSPACE tags (`color_space`/`color_transfer`/
// `color_primaries` — the truth the in-IR colorspace rule can only guess from
// `extraProps`), and the count of audio streams. `src/state/media.ts` calls the
// same probe to persist typed catalog rows — one ffprobe, two consumers (diagnostics
// + catalog). A content hash is a separate, OPT-IN helper (`contentHash`) because it
// reads the whole file; the probe itself stays a cheap header read.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { type DiagnosticInput, diag } from "../diagnostics/types";
import type { Profile } from "../ir/types";

/** A parsed rational `num/den` (ffprobe reports rates as fractions like `30/1` or
 *  `30000/1001`). `den` is never 0 (we reject `0/0`, ffprobe's "unknown"). */
export type Rational = { num: number; den: number };

/** The colorspace tags ffprobe reports per video stream — the SOURCE truth (vs the
 *  in-IR `extraProps` hints the pure `media` checker reads). Each is `null` when the
 *  stream doesn't declare it (`unknown`/`N/A` → null) so the rule judges nothing. */
export type ColorTags = {
  /** `color_space` (e.g. `bt709`, `bt2020nc`), or null. */
  space: string | null;
  /** `color_transfer` (e.g. `bt709`, `arib-std-b67`, `smpte2084`), or null. */
  transfer: string | null;
  /** `color_primaries` (e.g. `bt709`, `bt2020`), or null. */
  primaries: string | null;
};

/** The facts a source probe yields. Any field is `null` when ffprobe could not
 *  determine it (a still image has no avg rate; an audio-only file has no video
 *  stream) — the pure rule treats `null` as "unknown, judge nothing". */
export type SourceProbe = {
  /** Absolute path probed. */
  path: string;
  /** Nominal/base rate (`r_frame_rate`), or null. */
  rFrameRate: Rational | null;
  /** True average rate (`avg_frame_rate`), or null. */
  avgFrameRate: Rational | null;
  /** Decoded frame count, or null. */
  nbFrames: number | null;
  /** Container/stream duration in seconds, or null. */
  durationSec: number | null;
  /** Pixel width, or null. */
  width: number | null;
  /** Pixel height, or null. */
  height: number | null;
  /** Source video-stream colorspace tags (catalog + colorspace diagnostic), or all
   *  `null` when the stream declares none. */
  color: ColorTags;
  /** Count of AUDIO streams in the container (a clip with ≥1 carries audio), or null
   *  when the count couldn't be read. */
  audioStreams: number | null;
};

/** Parse an ffprobe rate token `"30/1"` / `"30000/1001"` → Rational, or null for
 *  `"0/0"` (ffprobe's unknown), a zero denominator, or any unparseable text. */
export function parseRational(token: string | undefined): Rational | null {
  if (!token) return null;
  const m = /^(\d+)\/(\d+)$/.exec(token.trim());
  if (!m) {
    // Some streams report a bare decimal; accept it as num/1-ish.
    const n = Number(token);
    return Number.isFinite(n) && n > 0 ? { num: n, den: 1 } : null;
  }
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return null;
  return { num, den };
}

/** The decimal value of a Rational (only for comparison/printing — placement math
 *  always stays rational; this is a probe fact, not a timeline position). */
export function rationalToFps(r: Rational): number {
  return r.num / r.den;
}

/** Run `ffprobe` and capture stdout/stderr + exit code. Module-local (the melt /
 *  remotion drivers keep their own copies private); kept here so this module has no
 *  cross-driver import just for a spawn helper. */
async function spawnCapture(
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

// In-process cache keyed by path + mtime + size, so the viewer hitting
// /api/diagnostics on every load doesn't re-spawn ffprobe for unchanged files.
// (A persistent `.vean/vean.db` probe cache is the sanctioned next step; this
// in-memory layer keeps the feature self-contained for now.)
const cache = new Map<string, SourceProbe | null>();

function cacheKey(path: string): string | null {
  try {
    const st = statSync(path);
    return `${path}:${st.mtimeMs}:${st.size}`;
  } catch {
    return null; // missing file → not cacheable; caller treats as unprobeable
  }
}

/** Normalize an ffprobe tag string to a real value or `null` — `undefined`, `""`,
 *  ffprobe's `"unknown"`, and `"N/A"` all collapse to "the stream didn't declare
 *  it" so a rule judges nothing rather than treating the sentinel as data. */
function tag(v: string | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (s === "" || s === "unknown" || s === "N/A") return null;
  return s;
}

/** Coerce an ffprobe numeric field to a finite number, or `null` for the same
 *  unknown sentinels `tag` rejects (plus non-numeric text). */
function numField(v: string | number | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = v.trim();
  if (s === "" || s === "unknown" || s === "N/A") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** The raw shape of the `-of json` ffprobe output we parse (only the fields we
 *  read; ffprobe emits more). */
type FfprobeJson = {
  format?: { duration?: string };
  streams?: Array<{
    codec_type?: string;
    r_frame_rate?: string;
    avg_frame_rate?: string;
    nb_frames?: string;
    width?: number;
    height?: number;
    color_space?: string;
    color_transfer?: string;
    color_primaries?: string;
  }>;
};

/**
 * ffprobe a source file for its catalog + diagnostics facts (frame rates, pixel
 * dimensions, colorspace tags, audio-stream count). Returns `null` when the file is
 * missing or has no video stream (caller skips it — a missing FILE is a separate
 * dangling-ref concern, not an fps judgement). Never throws on a probe failure: a
 * non-zero ffprobe exit yields `null` (the diagnostics path must not crash because
 * one source is unreadable).
 */
export async function probeSource(path: string): Promise<SourceProbe | null> {
  const key = cacheKey(path);
  if (key == null) return null; // file gone
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  // One JSON probe of the container: the first VIDEO stream gives the rate /
  // dimension / colorspace facts; counting AUDIO streams tells the av-symmetry and
  // catalog layers whether a source carries sound. (JSON, not `default=`, so a
  // multi-stream container parses unambiguously.)
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,r_frame_rate,avg_frame_rate,nb_frames,width,height,color_space,color_transfer,color_primaries",
    "-of",
    "json",
    path,
  ];
  let result: SourceProbe | null;
  try {
    const { code, stdout } = await spawnCapture("ffprobe", args);
    if (code !== 0) {
      result = null;
    } else {
      const parsed = JSON.parse(stdout) as FfprobeJson;
      const streams = parsed.streams ?? [];
      const video = streams.find((s) => s.codec_type === "video");
      const audioStreams = streams.filter((s) => s.codec_type === "audio").length;
      // No video stream at all → nothing to judge (an audio-only file is not an fps
      // hazard; its catalog row is populated by the audio-stream count alone).
      if (!video && audioStreams === 0 && streams.length === 0) {
        result = null;
      } else {
        result = {
          path,
          rFrameRate: parseRational(video?.r_frame_rate),
          avgFrameRate: parseRational(video?.avg_frame_rate),
          nbFrames: numField(video?.nb_frames),
          durationSec: numField(parsed.format?.duration),
          width: video?.width ?? null,
          height: video?.height ?? null,
          color: {
            space: tag(video?.color_space),
            transfer: tag(video?.color_transfer),
            primaries: tag(video?.color_primaries),
          },
          audioStreams,
        };
      }
    }
  } catch {
    result = null; // ffprobe missing or spawn failure — degrade to "unprobeable"
  }
  cache.set(key, result);
  return result;
}

/** A content hash of a source file (sha256, first 16 hex chars — enough to detect a
 *  re-encode / replacement while staying compact for a catalog row). Returns `null`
 *  if the file is gone or unreadable. Separate from `probeSource` because it reads
 *  the WHOLE file (the probe is a cheap header read); the catalog calls it once per
 *  scan, not on every diagnostics pass. */
export function contentHash(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
  } catch {
    return null; // missing / unreadable → no hash (caller leaves the column null)
  }
}

/** The typed ffprobe facts the media catalog persists (the columns the 0002 migration
 *  added). Derived from a `SourceProbe` + a content hash; every field nullable (a
 *  never-probed source, an audio-only file, a still). fps stays RATIONAL `[num, den]`
 *  (never a float) per the frame-exact invariant. Lives in the DRIVER layer (with the
 *  probe it projects from) so the PURE projection unit-tests without `bun:sqlite`. */
export type MediaProbeFacts = {
  durationSec: number | null;
  fpsNum: number | null;
  fpsDen: number | null;
  width: number | null;
  height: number | null;
  audioStreams: number | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  contentHash: string | null;
  probedAt: string;
};

/** Project a `SourceProbe` (+ optional content hash) onto the typed catalog columns.
 *  PURE — no I/O, no DB — so it unit-tests without ffprobe. The nominal `rFrameRate`
 *  is the catalog's fps (a CFR file's real rate; a VFR file's nominal — the VFR
 *  signal lives in the diagnostics, not the catalog row). `probedAt` is stamped now,
 *  even for an unprobeable source (`probe === null`), so a re-scan can tell "probed,
 *  nothing there" from "never probed". */
export function probeFactsFromSource(
  probe: SourceProbe | null,
  hash: string | null,
): MediaProbeFacts {
  const fps = probe?.rFrameRate ?? null;
  return {
    durationSec: probe?.durationSec ?? null,
    fpsNum: fps?.num ?? null,
    fpsDen: fps?.den ?? null,
    width: probe?.width ?? null,
    height: probe?.height ?? null,
    audioStreams: probe?.audioStreams ?? null,
    colorSpace: probe?.color.space ?? null,
    colorTransfer: probe?.color.transfer ?? null,
    colorPrimaries: probe?.color.primaries ?? null,
    contentHash: hash,
    probedAt: new Date().toISOString(),
  };
}

// ─── I/O-fed diagnostic RULES — the driver half of the media checker's TODOs ──────
//
// These are the three diagnostics that the pure `media` checker (src/diagnostics/
// checks/media.ts) cannot raise on its own because each needs a fact NOT in the IR:
// whether the FILE exists, the SOURCE's real pixel dimensions, and the SOURCE's real
// colorspace. They live HERE (the driver layer that does the I/O) and stay PURE
// functions over already-gathered facts — so they unit-test without ffprobe, exactly
// like the fps rule in src/diagnostics/probe.ts. They emit the SAME diagnostic
// FAMILIES the in-IR slices use (`upscaling-past-canvas`, `colorspace-mismatch`), so
// the two halves compose under one code in the merged set; `dangling-file-ref` is
// driver-only (the IR has no "does this path exist" fact). The orchestrator
// (src/driver/probeDiagnostics.ts) calls these alongside the fps rule and stamps
// `source: "probe"`.

/** Where a probe-fed diagnostic anchors (the clip + track ids). Mirrors the fps
 *  rule's `ProbeDiagLocation` so the orchestrator passes one location shape. */
export type ProbeRuleLocation = { clip: string; track: string };

/** Does a resolved path exist as a readable file on disk? The single fs fact the
 *  dangling-ref rule rests on, isolated so the rule itself stays pure (fed a bool). */
export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false; // missing, a dir, or unreadable — all "not a usable source file"
  }
}

/**
 * `dangling-file-ref` — a clip points at a media path that is GONE from disk. The
 * render fails (or melt substitutes black), so this is an ERROR. The pure `media`
 * checker can only catch an EMPTY resource (`dangling-resource`); a present-but-
 * missing FILE needs the fs, so it is the driver's call. Fed the resolved absolute
 * path + whether it exists (the orchestrator does the stat); fires only when the
 * path is a real media reference that is absent.
 */
export function danglingFileRefDiagnostic(
  resolvedPath: string,
  exists: boolean,
  loc: ProbeRuleLocation,
): DiagnosticInput[] {
  if (exists) return [];
  return [
    diag({
      code: "dangling-file-ref",
      severity: "error",
      message: `clip "${loc.clip}" references a media file that does not exist on disk (${resolvedPath}) — the render will fail or substitute black`,
      location: { clip: loc.clip, track: loc.track },
      fix: "relink the clip to the moved/renamed file, or remove the clip",
      data: { path: resolvedPath },
    }),
  ];
}

/**
 * `upscaling-past-canvas` (driver slice) — the SOURCE frame is SMALLER than the
 * project canvas, so melt scales it up and it renders soft. The in-IR slice catches
 * an explicit over-canvas scale FILTER; this catches the implicit upscale from a
 * sub-canvas source, which needs the source's real pixel dimensions (an ffprobe).
 * Fires only when BOTH source dimensions are known AND strictly below the canvas
 * (an equal or larger source is fine — melt down/non-scales it). A source with no
 * video stream (`width`/`height` null) judges nothing.
 */
export function sourceUpscaleDiagnostic(
  profile: Profile,
  probe: SourceProbe,
  loc: ProbeRuleLocation,
): DiagnosticInput[] {
  const { width, height } = probe;
  if (width == null || height == null) return []; // no dimensions → nothing to judge
  if (width <= 0 || height <= 0) return [];
  // Soft upscale iff BOTH source axes are below the canvas (a portrait source on a
  // landscape canvas is letterboxed, not upscaled — only a genuinely smaller frame
  // is scaled past 100%). Conservative: an equal-or-larger source never fires.
  if (width >= profile.width || height >= profile.height) return [];
  return [
    diag({
      code: "upscaling-past-canvas",
      severity: "warning",
      message: `clip "${loc.clip}" source is ${width}×${height}, smaller than the ${profile.width}×${profile.height} canvas — melt scales it up past 100% and it renders soft`,
      location: { clip: loc.clip, track: loc.track },
      fix: "use a higher-resolution source, or place the clip smaller than the canvas",
      data: {
        sourceWidth: width,
        sourceHeight: height,
        canvasWidth: profile.width,
        canvasHeight: profile.height,
      },
    }),
  ];
}

// Tokens (case-folded, in any of the three colorspace tags) that name a LOG transfer
// or a WIDE gamut needing conversion to a Rec.709 timeline. Mirrors the in-IR rule's
// LOG_WIDE_TOKENS so the source-fed slice and the extraProps slice agree on what
// counts as a hazard. A `bt709`/`smpte170m`/`bt601` source is NOT in this set, so a
// standard-gamut source (the clean corpus) is silent.
const SOURCE_LOG_WIDE_TOKENS = [
  "log",
  "slog",
  "vlog",
  "logc",
  "arib-std-b67", // HLG, as ffmpeg names the transfer
  "hlg",
  "smpte2084", // PQ / HDR10
  "pq",
  "bt2020", // Rec.2020 wide gamut (ffmpeg: bt2020nc / bt2020c / bt2020)
  "rec2020",
  "2020",
];

/**
 * `colorspace-mismatch` (driver slice) — the SOURCE declares a log / wide-gamut
 * colorspace (ffprobe's `color_space`/`color_transfer`/`color_primaries`) on a
 * Rec.709 timeline. The in-IR slice reads a colorspace HINT carried verbatim in
 * `extraProps`; this reads the SOURCE truth from the file, catching footage whose
 * .mlt producer carries no hint. Fires only on a 709 timeline, only when a
 * recognized log/wide token is present in a source tag. (Unlike the in-IR slice it
 * does not clear on a LUT filter — the driver rule has only the probe facts, not the
 * clip's filter list; the orchestrator merges by code so a clip the in-IR slice
 * already cleared via its LUT is deduped there if both fire.)
 */
export function sourceColorspaceDiagnostic(
  profile: Profile,
  probe: SourceProbe,
  loc: ProbeRuleLocation,
): DiagnosticInput[] {
  if (profile.colorspace !== 709) return []; // only judged against a 709 timeline
  const tags: [string, string | null][] = [
    ["color_transfer", probe.color.transfer],
    ["color_primaries", probe.color.primaries],
    ["color_space", probe.color.space],
  ];
  for (const [key, value] of tags) {
    if (value == null) continue;
    const text = value.toLowerCase();
    const hit = SOURCE_LOG_WIDE_TOKENS.find((t) => text.includes(t));
    if (!hit) continue;
    return [
      diag({
        code: "colorspace-mismatch",
        severity: "warning",
        message: `clip "${loc.clip}" source is log / wide-gamut (${key}=${value}) on a Rec.709 timeline — it will render flat/washed without a LUT or colorspace conversion`,
        location: { clip: loc.clip, track: loc.track },
        fix: "add a LUT / colorspace-conversion filter, or set the timeline colorspace to match the source",
        data: { hint: key, value },
      }),
    ];
  }
  return [];
}
