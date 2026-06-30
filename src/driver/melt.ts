// The render/inspect driver — vean's arm's-length bridge to `melt` (MLT/FFmpeg).
// It shells out to the `melt` and `ffmpeg`/`ffprobe` BINARIES as separate
// processes (never linking libmlt/libavcodec — Hard boundary #1: that keeps vean
// AGPL-by-choice, not GPL-by-force). Files in, files out; no state, no network.
//
// Every body spawns the right subprocess with `Bun.spawn`, streams its stderr
// (melt/ffmpeg are chatty — they write progress to stderr), waits for exit, and
// maps a nonzero exit code to a thrown `MeltError` carrying the captured stderr.
// No library is linked; the boundary is a process boundary, by construction:
//   • render      → `melt <mlt> -consumer avformat:<out> vcodec=libx264 pix_fmt=yuv420p real_time=-N`
//   • still       → `melt <mlt> in=<f> out=<f> -consumer avformat:<png>` (one exact frame)
//   • contactSheet→ `ffprobe` frame-count probe + `ffmpeg` tile filter over
//     evenly-spaced frames of <video> into one PNG, with the cell→frame map.

/** Result of a subprocess render: where the artifact landed + the exit signal. */
export type RenderResult = {
  /** Absolute path to the produced file. */
  outPath: string;
  /** Subprocess exit code (0 = success). */
  code: number;
  /** Captured stderr (melt/ffmpeg are chatty; surfaced for diagnostics). */
  stderr: string;
};

/** A downscaled render canvas. melt renders the timeline onto THIS profile, so
 *  the output is `width×height` at the SAME rational fps + sample aspect as the
 *  source. We scale via a profile, NOT a consumer `s=`/`width=`/`height=` arg:
 *  on melt 7.38 the avformat consumer's own rescale stalls at 99% and emits a
 *  truncated, moov-less file (bisected against the corpus — see the proxy
 *  builder). Profile-based scaling is the supported, terminating path. */
export type ScaleProfile = {
  /** Target output width in pixels. */
  width: number;
  /** Target output height in pixels. */
  height: number;
  /** Rational fps `[num, den]` of the SOURCE — kept exact so the proxy stays
   *  frame-aligned with the canonical timeline (never a float fps). */
  fps: [number, number];
  /** Source sample-aspect numerator (default 1 — square pixels). */
  sampleAspectNum?: number;
  /** Source sample-aspect denominator (default 1). */
  sampleAspectDen?: number;
};

export type RenderOpts = {
  /** Override the video codec (default libx264). */
  vcodec?: string;
  /** Override the pixel format (default yuv420p). */
  pixFmt?: string;
  /** Hard frame bound: append `frames=<n>` so the render TERMINATES after `n`
   *  frames regardless of producer length. Without it a render relies entirely
   *  on every producer being finite — a `length=0`/unbounded color producer (a
   *  synthetic timeline) would never reach EOF and the render would hang. Pass
   *  the timeline's total frame count to bound it exactly. */
  frames?: number;
  /** Render onto a downscaled profile (the proxy path). Mutually compatible with
   *  `frames`. See {@link ScaleProfile} for why this is a profile, not `s=`. */
  scaleProfile?: ScaleProfile;
  /** Extra raw `melt` consumer args, appended verbatim. */
  extraArgs?: string[];
};

// ─── Subprocess plumbing ───────────────────────────────────────────────────

/** Thrown when a spawned binary exits nonzero. Carries the full command line
 *  and the captured stderr so a failed render is debuggable from the message
 *  alone (the agent reads this, not a scrollback). */
export class MeltError extends Error {
  constructor(
    readonly bin: string,
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(
      `${bin} exited ${code}\n  command: ${bin} ${args.join(" ")}\n${
        stderr.trim() ? `  stderr:\n${indent(stderr.trim())}` : "  stderr: <empty>"
      }`,
    );
    this.name = "MeltError";
  }
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/** Resolve a renderer binary name to its executable path. The signed Mac app sets
 *  these to its bundled subprocess sidecars (`Contents/MacOS/…`); unset, they fall
 *  back to the bare name resolved on `PATH` — the source / CLI / Homebrew path,
 *  which treats `melt`/`ffmpeg`/`ffprobe` as system deps. Documented overrides:
 *  `VEAN_MELT`, `VEAN_FFMPEG`, `VEAN_FFPROBE` (the `*_BIN` spelling is also
 *  accepted). The MLT module / profile / data directories are handed to the
 *  subprocess through inherited `MLT_*` env (`Bun.spawn` inherits the parent env),
 *  so the driver needs no extra wiring for them — only the binary path. */
export function resolveBin(name: string): string {
  const env = process.env;
  switch (name) {
    case "melt":
      return env.VEAN_MELT ?? env.VEAN_MELT_BIN ?? name;
    case "ffmpeg":
      return env.VEAN_FFMPEG ?? env.VEAN_FFMPEG_BIN ?? name;
    case "ffprobe":
      return env.VEAN_FFPROBE ?? env.VEAN_FFPROBE_BIN ?? name;
    default:
      return name;
  }
}

/** Spawn `bin args`, drain stdout/stderr to strings, await exit. Returns the
 *  exit code + captured stderr — the caller decides whether nonzero throws. */
async function spawnCapture(
  bin: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([resolveBin(bin), ...args], { stdout: "pipe", stderr: "pipe" });
  // Read both pipes concurrently so a large stream can't deadlock the buffer.
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Spawn, and throw `MeltError` on a nonzero exit. The common case for renders. */
async function run(bin: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const { code, stdout, stderr } = await spawnCapture(bin, args);
  if (code !== 0) throw new MeltError(bin, args, code, stderr);
  return { stdout, stderr };
}

// ─── render ─────────────────────────────────────────────────────────────────

/** Build the body of a temp MLT `.profile` file for a downscaled render canvas.
 *  Square-pixel by default (sample aspect 1:1 → display aspect == width:height),
 *  carrying the SOURCE's exact rational fps so the proxy stays frame-aligned. */
function scaleProfileText(p: ScaleProfile): string {
  const san = p.sampleAspectNum ?? 1;
  const sad = p.sampleAspectDen ?? 1;
  return [
    "description=vean-render-scale",
    `width=${p.width}`,
    `height=${p.height}`,
    "progressive=1",
    `sample_aspect_num=${san}`,
    `sample_aspect_den=${sad}`,
    `display_aspect_num=${p.width * san}`,
    `display_aspect_den=${p.height * sad}`,
    `frame_rate_num=${p.fps[0]}`,
    `frame_rate_den=${p.fps[1]}`,
    "colorspace=709",
    "",
  ].join("\n");
}

/** Render a `.mlt` document headless to a video file via `melt`.
 *
 *  `real_time=-N` lets melt use as many worker threads as it wants for a
 *  headless (non-realtime) render — the negative form is "use N threads but
 *  drop frames is OFF", the standard headless throughput flag.
 *
 *  Two bounding/scaling controls keep a render TERMINATING and correctly sized:
 *   • `opts.frames` appends `frames=<n>` so melt stops after exactly `n` frames
 *     even if a producer is unbounded (a synthetic `length=0` color timeline has
 *     no natural EOF — without a bound the render never returns).
 *   • `opts.scaleProfile` renders onto a temp downscaled `.profile` (passed with
 *     `-profile`) instead of a consumer `s=`/`width=`/`height=` rescale, which
 *     stalls melt 7.38 at 99% and writes a truncated, unplayable file. */
export async function render(
  mltPath: string,
  outPath: string,
  opts: RenderOpts = {},
): Promise<RenderResult> {
  const vcodec = opts.vcodec ?? "libx264";
  const pixFmt = opts.pixFmt ?? "yuv420p";

  // A downscaled render uses a temp profile written beside the output (cleaned
  // up after melt exits, success or failure).
  let profilePath: string | undefined;
  if (opts.scaleProfile) {
    profilePath = `${outPath}.${process.pid}.${Date.now()}.profile`;
    await Bun.write(profilePath, scaleProfileText(opts.scaleProfile));
  }

  const args = [
    ...(profilePath ? ["-profile", profilePath] : []),
    mltPath,
    "-consumer",
    `avformat:${outPath}`,
    `vcodec=${vcodec}`,
    `pix_fmt=${pixFmt}`,
    "real_time=-1",
    ...(opts.frames != null ? [`frames=${Math.max(1, Math.trunc(opts.frames))}`] : []),
    ...(opts.extraArgs ?? []),
  ];

  try {
    const { stderr } = await run("melt", args);
    return { outPath, code: 0, stderr };
  } finally {
    if (profilePath) {
      try {
        await Bun.file(profilePath).delete();
      } catch {
        // best-effort temp cleanup; a stray .profile is harmless and gitignored
      }
    }
  }
}

// ─── still ────────────────────────────────────────────────────────────────────

/** Grab ONE exact frame (`frame`, 0-based) of a `.mlt` to a PNG at full fidelity.
 *
 *  `in=`/`out=` on the .mlt argument window the producer to a single inclusive
 *  frame (playtime = out - in + 1 = 1); `frames=1` stops melt after that one
 *  frame. `vcodec=png` is REQUIRED, not optional: melt's avformat consumer
 *  ignores the `.png` extension and defaults to the mjpeg encoder, silently
 *  writing a (lossy) JPEG into a `.png` file — pinning the codec makes the
 *  artifact a true, lossless PNG for agent inspection.
 *
 *  `update=1` is forwarded to ffmpeg's image2 muxer (which melt's avformat
 *  consumer uses): writing a single PNG to a fixed (non-`%d`-patterned) filename
 *  otherwise prints "does not contain an image sequence pattern … use the -update
 *  option" on every grab. That warning is not benign noise: a frame-grab that
 *  trips it can leave a STALE PNG on disk (the muxer declines the overwrite),
 *  which a downstream SSIM compare would silently read as if it were fresh.
 *  `update=1` makes the single-frame write explicit, warning-free, and
 *  overwrite-correct. */
export async function still(
  mltPath: string,
  frame: number,
  outPath: string,
): Promise<RenderResult> {
  if (!Number.isInteger(frame) || frame < 0) {
    throw new Error(`still: frame must be a non-negative integer, got ${frame}`);
  }
  const args = [
    `${mltPath}`,
    `in=${frame}`,
    `out=${frame}`,
    "-consumer",
    `avformat:${outPath}`,
    "vcodec=png",
    "frames=1",
    "update=1",
  ];
  const { stderr } = await run("melt", args);
  return { outPath, code: 0, stderr };
}

// ─── contactSheet ───────────────────────────────────────────────────────────

/** Metadata for a contact sheet: the grid + the cell→source-frame mapping, so a
 *  flaw spotted in a cell maps back to a real frame to fix. */
export type ContactSheet = {
  outPath: string;
  cols: number;
  rows: number;
  /** cell index (row-major) → the source frame sampled into that cell. */
  cellFrames: number[];
};

/** Background/pad colour for the tile grid (ffmpeg wants `0xRRGGBB`). No brand
 *  coupling here — the driver is brand-agnostic; a neutral dark pad keeps the
 *  contact sheet readable for any content. */
const SHEET_BG = "0x101010";
/** Each cell is scaled to ~this width before tiling; keeps a sheet legible
 *  without exploding the PNG. `-2` on the height keeps it even for the encoder. */
const SHEET_CELL_TARGET_W = 1280;

/** Probe the exact decoded frame count of a video stream via `ffprobe`. Counts
 *  real frames (`-count_frames`) so sampling spans the WHOLE clip, not a
 *  container-duration estimate. */
async function probeFrameCount(video: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-count_frames",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "default=nokey=1:noprint_wrappers=1",
    video,
  ]);
  const total = Number(stdout.trim());
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(
      `contactSheet: could not read frame count from ${video} (got "${stdout.trim()}")`,
    );
  }
  return Math.trunc(total);
}

/** Fast frame-count estimate for placing a whole clip on the timeline. Unlike
 *  `probeFrameCount` (which `-count_frames`-decodes the WHOLE stream, exact but
 *  slow), this reads only container metadata: the stream's `nb_frames`, falling
 *  back to `duration × fps`. Good enough to size a footage clip; the user can
 *  trim afterwards. Throws if neither field is readable. */
export async function probeMediaFrames(resource: string, fps: [number, number]): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_frames,duration:format=duration",
    "-of",
    "json",
    resource,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{ nb_frames?: string; duration?: string }>;
    format?: { duration?: string };
  };
  const stream = parsed.streams?.[0];
  const nb = Number(stream?.nb_frames);
  if (Number.isFinite(nb) && nb > 0) return Math.trunc(nb);
  const dur = Number(stream?.duration ?? parsed.format?.duration);
  if (Number.isFinite(dur) && dur > 0) return Math.max(1, Math.round((dur * fps[0]) / fps[1]));
  throw new Error(
    `probeMediaFrames: could not determine frame count of ${resource} (no nb_frames/duration)`,
  );
}

/** A structured `ffprobe` of a media file: container + first video/audio stream.
 *  Cache/coordination metadata for the catalog — never canonical edit state. */
export type MediaProbe = {
  /** Container duration in seconds, or null if unknown. */
  durationSec: number | null;
  /** Container `format_name` (e.g. `mov,mp4,m4a,3gp,3g2,mj2`). */
  format: string | null;
  video: {
    codec: string | null;
    width: number | null;
    height: number | null;
    /** Rational frame rate `[num, den]` (kept rational — never a float). */
    fps: [number, number] | null;
    frames: number | null;
  } | null;
  audio: {
    codec: string | null;
    channels: number | null;
    sampleRate: number | null;
  } | null;
};

/** Probe a media file's container + first video/audio stream via `ffprobe`. Read
 *  only; returns structured metadata for the media catalog (duration, fps,
 *  resolution, audio streams). Throws `MeltError` if ffprobe fails. */
export async function probeMedia(resource: string): Promise<MediaProbe> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration,format_name:stream=codec_type,codec_name,width,height,r_frame_rate,nb_frames,channels,sample_rate",
    "-of",
    "json",
    resource,
  ]);
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      nb_frames?: string;
      channels?: number;
      sample_rate?: string;
    }>;
  };
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  const audio = parsed.streams?.find((s) => s.codec_type === "audio");
  const fps = ((): [number, number] | null => {
    const parts = video?.r_frame_rate?.split("/").map(Number);
    if (parts && parts.length === 2 && Number.isFinite(parts[0]) && (parts[1] ?? 0) > 0) {
      return [parts[0] as number, parts[1] as number];
    }
    return null;
  })();
  const dur = Number(parsed.format?.duration);
  return {
    durationSec: Number.isFinite(dur) ? dur : null,
    format: parsed.format?.format_name ?? null,
    video: video
      ? {
          codec: video.codec_name ?? null,
          width: video.width ?? null,
          height: video.height ?? null,
          fps,
          frames: Number(video.nb_frames) || null,
        }
      : null,
    audio: audio
      ? {
          codec: audio.codec_name ?? null,
          channels: audio.channels ?? null,
          sampleRate: Number(audio.sample_rate) || null,
        }
      : null,
  };
}

/** Tile evenly-spaced frames of `video` into one PNG (the motion at a glance).
 *
 *  Probes the true frame count, samples every `floor(total / cells)` frames via
 *  ffmpeg's `select`, scales each cell, and tiles them `cols×rows`. Returns the
 *  cell→frame map so a flaw spotted in cell N maps back to an exact source
 *  frame to re-inspect with `still`. */
export async function contactSheet(
  video: string,
  outPath: string,
  cols = 5,
  rows = 5,
): Promise<ContactSheet> {
  if (!Number.isInteger(cols) || cols <= 0 || !Number.isInteger(rows) || rows <= 0) {
    throw new Error(`contactSheet: cols/rows must be positive integers, got ${cols}×${rows}`);
  }
  const cells = cols * rows;
  const total = await probeFrameCount(video);
  const interval = Math.max(1, Math.floor(total / cells));

  const cellW = Math.max(2, Math.round(SHEET_CELL_TARGET_W / cols / 2) * 2);
  // Backslash-escape the comma inside mod() so ffmpeg's filtergraph parser
  // doesn't read it as an argument separator.
  const filter =
    `select='not(mod(n\\,${interval}))',` +
    `scale=${cellW}:-2,` +
    `tile=${cols}x${rows}:margin=12:padding=12:color=${SHEET_BG}`;

  await run("ffmpeg", [
    "-y",
    "-i",
    video,
    "-frames:v",
    "1",
    "-vf",
    filter,
    "-fps_mode",
    "vfr",
    outPath,
  ]);

  // The cell→frame map mirrors ffmpeg's `select` stride exactly: cell i samples
  // source frame i*interval, until the stride runs off the end of the clip.
  const cellFrames: number[] = [];
  for (let i = 0; i < cells; i++) {
    const f = i * interval;
    if (f >= total) break;
    cellFrames.push(f);
  }

  return { outPath, cols, rows, cellFrames };
}
