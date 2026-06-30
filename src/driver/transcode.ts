// TRANSCODE — the arm's-length ffmpeg driver that converts a variable-frame-rate
// source into a constant-frame-rate EDIT INTERMEDIATE (ProRes 422 + PCM, the
// Shotcut "Convert to Edit-friendly" shape). This is the file-producing fix for the
// `variable-frame-rate-source` diagnostic: a VFR source has no single CFR the
// timeline can match, so the repair is a new CFR copy the clip relinks to.
//
// ADDITIVE, never destructive: it writes a NEW file (default `<name>.cfr.mov` beside
// the source) and the caller relinks the clip to it — the original is untouched. Per
// the action policy, an additive file-producing fix applies without a confirm gate;
// only a DELETE-tier action would prompt.
//
// Shells out to the `ffmpeg` BINARY as a separate process (Hard boundary #1 — never
// linking libav). `-fps_mode cfr -r <rate>` re-times the VFR stream to a constant
// rate by evenly duplicating/dropping at the nominal rate; ProRes keeps it visually
// lossless for editing.
import { dirname, extname, join } from "node:path";
import type { Fps } from "../ir/types";

export class TranscodeError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`ffmpeg exited ${code}\n  command: ffmpeg ${args.join(" ")}\n  stderr:\n${stderr.trim()}`);
    this.name = "TranscodeError";
  }
}

export type TranscodeCfrOpts = {
  /** Output path (default `<src-dir>/<basename>.cfr.mov`). */
  outPath?: string;
  /** Overwrite an existing output (default false — skip if present). */
  force?: boolean;
};

export type TranscodeCfrResult = {
  /** Absolute path to the produced CFR intermediate. */
  outPath: string;
  /** The constant rate it was conformed to. */
  fps: Fps;
  /** True iff an existing output was reused (no re-encode). */
  cached: boolean;
};

/** Default intermediate path: the source with a `.cfr.mov` extension beside it. */
export function defaultCfrPath(srcPath: string): string {
  const ext = extname(srcPath);
  const base = srcPath.slice(0, srcPath.length - ext.length);
  return join(dirname(base), `${base.split("/").pop()}.cfr.mov`);
}

/**
 * Transcode `srcPath` to a constant-frame-rate ProRes 422 intermediate at `fps`.
 * Returns the output path; reuses an existing file unless `force`. Throws
 * `TranscodeError` on a non-zero ffmpeg exit (the caller surfaces it — a failed fix
 * must not silently relink to a missing/partial file).
 */
export async function transcodeToCfr(
  srcPath: string,
  fps: Fps,
  opts: TranscodeCfrOpts = {},
): Promise<TranscodeCfrResult> {
  const outPath = opts.outPath ?? defaultCfrPath(srcPath);
  if (!opts.force && (await Bun.file(outPath).exists())) {
    return { outPath, fps, cached: true };
  }
  const rate = `${fps[0]}/${fps[1]}`;
  const args = [
    "-y",
    "-i",
    srcPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?", // include audio if the source has it
    "-c:v",
    "prores_ks",
    "-profile:v",
    "3", // ProRes 422 HQ
    "-pix_fmt",
    "yuv422p10le",
    "-r",
    rate,
    "-fps_mode",
    "cfr", // re-time VFR → constant rate
    "-c:a",
    "pcm_s16le",
    outPath,
  ];
  const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new TranscodeError(args, code, stderr);
  return { outPath, fps, cached: false };
}
