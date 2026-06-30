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
import { statSync } from "node:fs";

/** A parsed rational `num/den` (ffprobe reports rates as fractions like `30/1` or
 *  `30000/1001`). `den` is never 0 (we reject `0/0`, ffprobe's "unknown"). */
export type Rational = { num: number; den: number };

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

/**
 * ffprobe a source file for its video-stream frame-rate facts. Returns `null` when
 * the file is missing or has no video stream (caller skips it — a missing FILE is a
 * separate dangling-ref concern, not an fps judgement). Never throws on a probe
 * failure: a non-zero ffprobe exit yields `null` (the diagnostics path must not
 * crash because one source is unreadable).
 */
export async function probeSource(path: string): Promise<SourceProbe | null> {
  const key = cacheKey(path);
  if (key == null) return null; // file gone
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const args = [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=r_frame_rate,avg_frame_rate,nb_frames,width,height:format=duration",
    "-of",
    "default=noprint_wrappers=1",
    path,
  ];
  let result: SourceProbe | null;
  try {
    const { code, stdout } = await spawnCapture("ffprobe", args);
    if (code !== 0) {
      result = null;
    } else {
      const fields = new Map<string, string>();
      for (const line of stdout.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
      }
      const num = (k: string): number | null => {
        const v = fields.get(k);
        if (v == null || v === "" || v === "N/A") return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
      };
      const rFrameRate = parseRational(fields.get("r_frame_rate"));
      const avgFrameRate = parseRational(fields.get("avg_frame_rate"));
      // No video stream at all → nothing to judge.
      result =
        rFrameRate == null && avgFrameRate == null && fields.size === 0
          ? null
          : {
              path,
              rFrameRate,
              avgFrameRate,
              nbFrames: num("nb_frames"),
              durationSec: num("duration"),
              width: num("width"),
              height: num("height"),
            };
    }
  } catch {
    result = null; // ffprobe missing or spawn failure — degrade to "unprobeable"
  }
  cache.set(key, result);
  return result;
}
