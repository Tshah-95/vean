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

/** The edit-friendly intermediate codecs `media.transcodeCodec` selects. ProRes 422
 *  HQ is visually-lossless (largest); 422/LT trade quality for size; DNxHR HQ/SQ are
 *  the Avid-native, FFmpeg-portable equivalents (no Apple dependency — the safest
 *  cross-platform default for an ffmpeg-driven tool); h264 is the smallest. All are
 *  all-intra (every frame self-contained → snappy scrubbing); the `-fps_mode cfr`
 *  re-time fixes VFR regardless of codec. */
export type TranscodeCodec =
  | "prores422hq"
  | "prores422"
  | "prores422lt"
  | "dnxhr_hq"
  | "dnxhr_sq"
  | "h264";

type CodecSpec = { video: string[]; audio: string[]; ext: string };

/** Map a codec choice to its ffmpeg video/audio flags + container extension. Pure +
 *  exported so the mapping is unit-tested without spawning ffmpeg. Rates/profiles
 *  per Apple's ProRes white paper + Avid's DNxHR specs. */
export function codecSpec(codec: TranscodeCodec): CodecSpec {
  const prores = (profile: string): CodecSpec => ({
    video: ["-c:v", "prores_ks", "-profile:v", profile, "-pix_fmt", "yuv422p10le"],
    audio: ["-c:a", "pcm_s16le"],
    ext: ".mov",
  });
  const dnxhr = (profile: string): CodecSpec => ({
    video: ["-c:v", "dnxhd", "-profile:v", profile, "-pix_fmt", "yuv422p"],
    audio: ["-c:a", "pcm_s16le"],
    ext: ".mov",
  });
  switch (codec) {
    case "prores422hq":
      return prores("3"); // ProRes 422 HQ — visually lossless
    case "prores422":
      return prores("2"); // ProRes 422 — general intermediate
    case "prores422lt":
      return prores("1"); // ProRes 422 LT — smaller
    case "dnxhr_hq":
      return dnxhr("dnxhr_hq"); // DNxHR HQ — ProRes 422 HQ peer, FFmpeg-portable
    case "dnxhr_sq":
      return dnxhr("dnxhr_sq"); // DNxHR SQ — Resolve's Windows optimized-media default
    case "h264":
      return {
        video: ["-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p"],
        audio: ["-c:a", "aac", "-b:a", "192k"],
        ext: ".mp4",
      };
  }
}

export type TranscodeCfrOpts = {
  /** Intermediate codec (default ProRes 422 HQ). */
  codec?: TranscodeCodec;
  /** Output path (default `<src-dir>/<basename>.cfr<ext>` for the codec). */
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

/** Default intermediate path: the source with a `.cfr<ext>` extension beside it
 *  (ext follows the codec — `.mov` for ProRes/DNxHR, `.mp4` for h264). */
export function defaultCfrPath(srcPath: string, outExt = ".mov"): string {
  const ext = extname(srcPath);
  const base = srcPath.slice(0, srcPath.length - ext.length);
  return join(dirname(base), `${base.split("/").pop()}.cfr${outExt}`);
}

/**
 * Transcode `srcPath` to a constant-frame-rate edit intermediate at `fps`, in the
 * chosen `codec` (default ProRes 422 HQ). Returns the output path; reuses an existing
 * file unless `force`. Throws `TranscodeError` on a non-zero ffmpeg exit (the caller
 * surfaces it — a failed fix must not silently relink to a missing/partial file).
 */
export async function transcodeToCfr(
  srcPath: string,
  fps: Fps,
  opts: TranscodeCfrOpts = {},
): Promise<TranscodeCfrResult> {
  const spec = codecSpec(opts.codec ?? "prores422hq");
  const outPath = opts.outPath ?? defaultCfrPath(srcPath, spec.ext);
  if (!opts.force && (await Bun.file(outPath).exists())) {
    return { outPath, fps, cached: true };
  }
  const args = [
    "-y",
    "-i",
    srcPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?", // include audio if the source has it
    ...spec.video,
    "-r",
    `${fps[0]}/${fps[1]}`,
    "-fps_mode",
    "cfr", // re-time VFR → constant rate
    ...spec.audio,
    outPath,
  ];
  const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new TranscodeError(args, code, stderr);
  return { outPath, fps, cached: false };
}
