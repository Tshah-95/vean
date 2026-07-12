#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const root = join(repo, "corpus/harness/media");
const assets = join(root, "assets");
const manifestPath = join(root, "manifest.json");
const parityPath = join(root, "lower-third-parity.mlt");
const write = process.argv.includes("--write");
if (!write) throw new Error("fixture generation is a write-only command; pass --write explicitly");

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function toolVersion(tool: string): string {
  const result = Bun.spawnSync([tool, "-version"], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`${tool} is required`);
  return result.stdout.toString().split("\n")[0]?.trim() ?? "unknown";
}

function run(argv: string[]): void {
  const result = Bun.spawnSync(argv, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")}\n${result.stderr.toString()}`);
  }
}

const common = ["-hide_banner", "-loglevel", "error", "-y"];
type Recipe = { id: string; file: string; argv: string[]; license: string; derivedFrom?: string };
const recipes: Recipe[] = [
  {
    id: "h264-high-yuv420p-cfr-30000-1001-aac-mp4",
    file: "source-h264-aac.mp4",
    argv: [
      "ffmpeg",
      ...common,
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30000/1001:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=2",
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "30",
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      "-shortest",
    ],
    license: "repo-authored synthetic CC0-1.0",
  },
  {
    id: "hevc-main10-vfr-aac-mov",
    file: "source-hevc-main10.mov",
    argv: [
      "ffmpeg",
      ...common,
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=24:duration=2",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=550:sample_rate=48000:duration=2",
      "-c:v",
      "libx265",
      "-profile:v",
      "main10",
      "-pix_fmt",
      "yuv420p10le",
      "-x265-params",
      "log-level=error",
      "-c:a",
      "aac",
      "-shortest",
    ],
    license: "repo-authored synthetic CC0-1.0",
  },
  {
    id: "prores422hq-pcm-mov",
    file: "source-prores422.mov",
    argv: [
      "ffmpeg",
      ...common,
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=1",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=48000:duration=1",
      "-c:v",
      "prores_ks",
      "-profile:v",
      "3",
      "-pix_fmt",
      "yuv422p10le",
      "-c:a",
      "pcm_s16le",
      "-shortest",
    ],
    license: "repo-authored synthetic CC0-1.0",
  },
  {
    id: "prores4444-yuva444p12le-mov",
    file: "source-prores4444-alpha.mov",
    argv: [
      "ffmpeg",
      ...common,
      "-f",
      "lavfi",
      "-i",
      "color=c=red@0.55:size=320x180:rate=30:duration=1,format=yuva444p10le",
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4",
      "-pix_fmt",
      "yuva444p10le",
      "-an",
    ],
    license: "repo-authored synthetic CC0-1.0",
  },
  {
    id: "avc-all-intra-yuv420p-mp4",
    file: "proxy-avc.mp4",
    argv: [
      "ffmpeg",
      ...common,
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=2",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "1",
      "-an",
      "-movflags",
      "+faststart",
    ],
    license: "repo-authored synthetic CC0-1.0",
  },
  {
    id: "vp9-yuva420p-webm",
    file: "proxy-vp9-alpha.webm",
    argv: [
      "ffmpeg",
      ...common,
      "-f",
      "lavfi",
      "-i",
      "color=c=lime@0.5:size=320x180:rate=30:duration=2,format=yuva420p",
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      "yuva420p",
      "-lossless",
      "1",
      "-an",
    ],
    license: "repo-authored synthetic CC0-1.0",
  },
  {
    id: "pcm-s16le-48khz-stereo-wav",
    file: "audio-pcm.wav",
    argv: [
      "ffmpeg",
      ...common,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000:duration=1",
      "-filter_complex",
      "[0:a]pan=stereo|c0=c0|c1=0.5*c0[a]",
      "-map",
      "[a]",
      "-c:a",
      "pcm_s16le",
    ],
    license: "repo-authored synthetic CC0-1.0",
  },
  {
    id: "aac-lc-48khz-stereo-m4a",
    file: "audio-aac.m4a",
    argv: [
      "ffmpeg",
      ...common,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=550:sample_rate=48000:duration=1",
      "-ac",
      "2",
      "-c:a",
      "aac",
      "-profile:a",
      "aac_low",
    ],
    license: "repo-authored synthetic CC0-1.0",
  },
  {
    id: "mp3-48khz-stereo",
    file: "audio.mp3",
    argv: [
      "ffmpeg",
      ...common,
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=660:sample_rate=48000:duration=1",
      "-ac",
      "2",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
    ],
    license: "repo-authored synthetic CC0-1.0",
  },
];

rmSync(assets, { recursive: true, force: true });
mkdirSync(assets, { recursive: true });
for (const recipe of recipes) run([...recipe.argv, join(assets, recipe.file)]);
const avc = readFileSync(join(assets, "proxy-avc.mp4"));
writeFileSync(join(assets, "corrupt-truncated.mp4"), avc.subarray(0, 64));
writeFileSync(join(assets, "unsupported-audio.bin"), "VEAN_SYNTHETIC_UNSUPPORTED_AUDIO\n");
writeFileSync(join(assets, "alpha-probe-failure.bin"), "VEAN_SYNTHETIC_ALPHA_PROBE_FAILURE\n");

const all = [
  ...recipes.map((recipe) => ({ ...recipe, path: join(assets, recipe.file) })),
  {
    id: "deterministically-truncated-video",
    file: "corrupt-truncated.mp4",
    argv: ["truncate", "proxy-avc.mp4", "64-bytes"],
    license: "repo-authored synthetic CC0-1.0",
    derivedFrom: "avc-all-intra-yuv420p-mp4",
    path: join(assets, "corrupt-truncated.mp4"),
  },
  {
    id: "deliberately-unsupported-audio",
    file: "unsupported-audio.bin",
    argv: ["literal-bytes", "VEAN_SYNTHETIC_UNSUPPORTED_AUDIO"],
    license: "repo-authored synthetic CC0-1.0",
    path: join(assets, "unsupported-audio.bin"),
  },
  {
    id: "forced-alpha-probe-failure",
    file: "alpha-probe-failure.bin",
    argv: ["literal-bytes", "VEAN_SYNTHETIC_ALPHA_PROBE_FAILURE"],
    license: "repo-authored synthetic CC0-1.0",
    path: join(assets, "alpha-probe-failure.bin"),
  },
];
const ffprobeVersion = toolVersion("ffprobe");
const entries = all.map(({ path, ...entry }) => {
  const probe = Bun.spawnSync(
    ["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path],
    { stdout: "pipe", stderr: "pipe" },
  );
  const portablePath = `assets/${basename(path)}`;
  const metadata =
    probe.exitCode === 0
      ? JSON.parse(
          JSON.stringify(JSON.parse(probe.stdout.toString())).replaceAll(path, portablePath),
        )
      : { attributed_probe_failure: probe.stderr.toString().trim().replaceAll(path, portablePath) };
  return {
    ...entry,
    relative_path: portablePath,
    source_sha256: hash(path),
    byte_length: statSync(path).size,
    container_and_stream_metadata: metadata,
  };
});
const generatorHash = hash(import.meta.filename);
mkdirSync(root, { recursive: true });
writeFileSync(
  parityPath,
  `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" root="" title="H07 lower-third parity">
  <profile description="H07 vertical 1080x1920 30fps" width="1080" height="1920" progressive="1" frame_rate_num="30" frame_rate_den="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="9" display_aspect_den="16" colorspace="709"/>
  <producer id="base" in="0" out="120"><property name="mlt_service">color</property><property name="resource">#FF241A52</property><property name="length">121</property><property name="shotcut:uuid">h07-base</property></producer>
  <producer id="graphic" in="0" out="89"><property name="resource">.vean/cache/remotion/lower-third.mov</property><property name="length">90</property><property name="shotcut:uuid">h07-lower-third</property><property name="vean:composition">LowerThird</property><property name="vean:compositionProps">{&quot;title&quot;:&quot;vean&quot;,&quot;subtitle&quot;:&quot;video editor, agent native&quot;,&quot;accent&quot;:&quot;#c7ae7a&quot;,&quot;barColor&quot;:&quot;#11131aee&quot;}</property></producer>
  <playlist id="v1"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property><entry producer="base" in="0" out="120"/></playlist>
  <playlist id="v2"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property><blank length="30"/><entry producer="graphic" in="0" out="89"/><blank length="1"/></playlist>
  <tractor id="main" shotcut="1"><track producer="v1"/><track producer="v2"/><transition mlt_service="qtblend" in="0" out="120"><property name="a_track">0</property><property name="b_track">1</property></transition></tractor>
</mlt>
`,
);
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      schema_version: "1.0.0",
      generated_at: "deterministic-no-wall-clock",
      generator: {
        path: "scripts/media-fixtures.ts",
        sha256: generatorHash,
        ffmpeg: toolVersion("ffmpeg"),
        ffprobe: ffprobeVersion,
      },
      license: "repo-authored synthetic; redistributable with Vean",
      parity_document: {
        relative_path: "lower-third-parity.mlt",
        sha256: hash(parityPath),
        composition_id: "LowerThird",
        clip_start_frame: 30,
        duration_frames: 90,
      },
      entries,
    },
    null,
    2,
  )}\n`,
);
run(["bunx", "biome", "format", "--write", manifestPath]);
console.log(
  JSON.stringify({
    status: "generated",
    manifestPath,
    fixtureCount: entries.length,
    manifestSha256: hash(manifestPath),
  }),
);
