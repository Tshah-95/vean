#!/usr/bin/env bun
// verify:proxy — the END-TO-END render gate for the live-preview proxy path
// (Move 5, Phase B). This is the gate the proxy-render HANG slipped past: the
// unit tests (tests/preview-proxy.test.ts) only exercise the pure `stripGraphics`
// transform, and tests/preview-serve.test.ts probes the READ endpoints only,
// explicitly deferring the melt path to "the real Phase-C gate" — so a
// `POST /api/proxy-render` that stalled melt forever (the `s=<w>x<h>` consumer
// rescale on melt 7.38) was never exercised before shipping. This gate drives the
// REAL HTTP endpoint through melt and proves the produced mp4 is playable.
//
//   bun run verify:proxy
//
// What it does (no committed binary fixtures):
//   1. Boots the real preview server (the `preview.serve` action surface) on
//      127.0.0.1 against a self-contained corpus timeline, under a WALL-CLOCK
//      WATCHDOG. If the render hangs (the regression), the watchdog fires and the
//      gate FAILS loudly instead of hanging CI forever.
//   2. POSTs /api/proxy-render and fetches the streamed proxy mp4 over /api/proxy/…
//      — the exact path the viewer takes.
//   3. ffprobe-verifies the mp4 is a real, playable, DOWNSCALED file: a moov atom
//      (size sanity), the requested even dimensions, an AAC audio stream, and a
//      decoded frame count EQUAL to the timeline's canonical totalFrames (proving
//      the frame bound terminated the render at the exact EOF, not early/late).
//   4. Renders a SYNTHETIC color-producer timeline (no media files, the
//      no-natural-EOF case) to prove the `frames=<n>` bound makes an otherwise
//      unbounded producer terminate.
//
// A failure to render, a watchdog trip, or a malformed mp4 is a hard FAIL (never a
// silent pass), exactly like verify:corpus / verify:graphic. Requires `melt` +
// `ffprobe` on PATH.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { colorClip, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { fromMlt } from "../src/ir/parse";
import { VERTICAL } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import { buildFootageProxy, totalFrames } from "../src/preview/proxy";
import { startPreviewServer } from "../src/preview/server";

const ROOT = resolve(import.meta.dirname, "..");
// A self-contained corpus timeline: color footage + a tone.wav referenced by an
// absolute path that resolves from any cwd. Renders with no external media root.
const CORPUS_MLT = join(ROOT, "corpus", "vean-multitrack.mlt");
// The watchdog: a correct proxy render of these tiny timelines finishes in ~1s; a
// rescale-hang regression would otherwise run forever. 60s is generous headroom.
const WATCHDOG_MS = 60_000;

type Probe = { width: number; height: number; frames: number; acodec: string; size: number };

/** ffprobe the produced mp4: dims + decoded frame count + audio codec + size. A
 *  truncated, moov-less file (the hang's 48-byte artifact) fails the size + dims
 *  probes; a render that didn't terminate at the bound fails the frame check. */
function probeMp4(path: string): Probe {
  const ff = (args: string[]): string =>
    spawnSync("ffprobe", ["-v", "error", ...args, path], { encoding: "utf8" }).stdout.trim();
  const [width, height] = ff([
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0",
  ])
    .split(",")
    .map((n) => Number(n));
  const frames = Number(
    ff([
      "-count_frames",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "default=nw=1:nk=1",
    ]),
  );
  const acodec = ff([
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name",
    "-of",
    "default=nw=1:nk=1",
  ]);
  const size = Bun.file(path).size;
  return { width: width ?? 0, height: height ?? 0, frames, acodec, size };
}

/** Race a promise against the wall-clock watchdog so a render HANG fails the gate
 *  instead of stalling it forever (the whole point — the bug was a non-returning
 *  POST under `idleTimeout:0`). */
async function withWatchdog<T>(label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`WATCHDOG: ${label} did not finish within ${WATCHDOG_MS}ms (hang?)`)),
      WATCHDOG_MS,
    );
  });
  try {
    return await Promise.race([work, watchdog]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "vean-verify-proxy-"));

  // ── GATE 1: the REAL HTTP /api/proxy-render endpoint end-to-end ──────────────
  const projectRoot = mkdtempSync(join(tmpdir(), "vean-verify-proxy-proj-"));
  const mlt = join(projectRoot, "main.mlt");
  copyFileSync(CORPUS_MLT, mlt);
  const expectedFrames = totalFrames(fromMlt(await Bun.file(mlt).text()));

  const server = await startPreviewServer({
    repo: projectRoot,
    timeline: mlt,
    port: 0,
    dev: false,
  });
  try {
    const renderRes = await withWatchdog(
      "POST /api/proxy-render",
      fetch(`${server.url}/api/proxy-render`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ route: mlt, scale: 0.5, force: true }),
      }).then((r) => r.json() as Promise<Record<string, unknown>>),
    );

    if (renderRes.ok !== true) {
      failures.push(`/api/proxy-render returned not-ok: ${JSON.stringify(renderRes)}`);
    } else {
      // Fetch the streamed proxy mp4 to a local file and probe it.
      const proxyUrl = String(renderRes.proxyUrl);
      const bytes = await withWatchdog(
        "GET proxy mp4",
        fetch(`${server.url}${proxyUrl}`).then((r) => r.arrayBuffer()),
      );
      const localMp4 = join(tmp, "endpoint-proxy.mp4");
      await Bun.write(localMp4, bytes);
      const p = probeMp4(localMp4);
      const w = Number(renderRes.width);
      const h = Number(renderRes.height);

      console.log(
        `endpoint  dims=${p.width}x${p.height} frames=${p.frames} acodec=${p.acodec || "(none)"} size=${p.size}`,
      );
      if (p.size < 1000)
        failures.push(`endpoint mp4 is ${p.size}B — truncated / no moov atom (the hang artifact)`);
      if (p.width !== w || p.height !== h)
        failures.push(`endpoint dims ${p.width}x${p.height} != requested ${w}x${h}`);
      if (p.width >= VERTICAL.width)
        failures.push(`endpoint not downscaled: width ${p.width} >= source ${VERTICAL.width}`);
      if (p.frames !== expectedFrames)
        failures.push(`endpoint frames ${p.frames} != canonical totalFrames ${expectedFrames}`);
      if (p.acodec !== "aac")
        failures.push(`endpoint audio codec is "${p.acodec}", expected aac (proxy carries sound)`);
    }
  } finally {
    server.stop();
  }

  // ── GATE 2: a SYNTHETIC color-producer timeline terminates (the EOF bound) ───
  // A pure color timeline has no media-driven EOF; without the `frames=<n>` bound
  // the consumer could run forever. Prove buildFootageProxy bounds and finishes.
  resetIds();
  const synthMlt = join(tmp, "synthetic.mlt");
  const synth = timeline(VERTICAL, {
    video: [videoTrack(colorClip(120, "#FF112233", { id: "bg" }))],
  });
  await Bun.write(synthMlt, toMlt(synth));

  const synthRes = await withWatchdog(
    "synthetic buildFootageProxy",
    buildFootageProxy(tmp, synthMlt, { scale: 0.5, force: true }),
  );
  const sp = probeMp4(synthRes.proxyPath);
  console.log(`synthetic dims=${sp.width}x${sp.height} frames=${sp.frames} size=${sp.size}`);
  if (sp.size < 500) failures.push(`synthetic mp4 is ${sp.size}B — truncated`);
  if (sp.frames !== 120)
    failures.push(`synthetic frames ${sp.frames} != 120 (the frame bound must terminate at EOF)`);
  if (sp.width !== synthRes.width || sp.height !== synthRes.height)
    failures.push(
      `synthetic dims ${sp.width}x${sp.height} != ${synthRes.width}x${synthRes.height}`,
    );

  // ── cleanup + verdict ───────────────────────────────────────────────────────
  rmSync(tmp, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });

  console.log("");
  if (failures.length === 0) {
    console.log(
      "OVERALL: PASS — proxy-render produces a playable, downscaled, frame-exact mp4 over the real endpoint; renders terminate (no hang).",
    );
    process.exit(0);
  }
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(`\nOVERALL: FAIL — ${failures.length} proxy defect(s).`);
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
