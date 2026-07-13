#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startPreviewServer } from "../../src/preview/server";
import { buildSourceProxy } from "../../src/preview/source-proxy";
import { chromium } from "../../viewer/node_modules/playwright/index.js";

const repo = resolve(import.meta.dirname, "../..");
const compositeCount = Number(process.argv[2] ?? "300");
if (!Number.isInteger(compositeCount) || compositeCount < 1)
  throw new Error("positive sample count required");
const control = process.env.VEAN_MEDIA_PERF_CONTROL ?? "none";
const project = mkdtempSync(join(tmpdir(), "vean-performance-project-"));
const source = join(project, "source.mp4");
const audio = join(project, "audio.wav");
const timeline = join(project, "performance.mlt");
cpSync(join(repo, "corpus/harness/media/assets/proxy-avc.mp4"), source);
cpSync(join(repo, "corpus/harness/media/assets/audio-pcm.wav"), audio);

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
writeFileSync(
  timeline,
  `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" root="${xml(project)}" title="H07 performance">
  <profile description="H07 performance 320x180 30fps" width="320" height="180" progressive="1" frame_rate_num="30" frame_rate_den="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" colorspace="709"/>
  <producer id="video" in="0" out="119"><property name="resource">${xml(source)}</property><property name="length">120</property><property name="shotcut:uuid">perf-video</property></producer>
  <producer id="audio" in="0" out="119"><property name="resource">${xml(audio)}</property><property name="length">120</property><property name="shotcut:uuid">perf-audio</property></producer>
  <producer id="graphic" in="0" out="119"><property name="resource">.vean/cache/remotion/perf.mov</property><property name="length">120</property><property name="shotcut:uuid">perf-graphic</property><property name="vean:composition">LowerThird</property><property name="vean:compositionProps">{&quot;title&quot;:&quot;performance&quot;,&quot;subtitle&quot;:&quot;raw product path&quot;}</property></producer>
  <playlist id="v1"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property><entry producer="video" in="0" out="119"/></playlist>
  <playlist id="v2"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property><entry producer="graphic" in="0" out="119"/></playlist>
  <playlist id="a1"><property name="shotcut:video">0</property><property name="shotcut:audio">1</property><entry producer="audio" in="0" out="119"/></playlist>
  <tractor id="main" shotcut="1"><track producer="v1"/><track producer="v2"/><track producer="a1" hide="video"/><transition mlt_service="qtblend" in="0" out="119"><property name="a_track">0</property><property name="b_track">1</property></transition></tractor>
</mlt>
`,
);

const failures = {
  crashes: [] as string[],
  page_errors: [] as string[],
  black_frames: [] as string[],
  stalls: [] as string[],
};
const now = () => performance.now();
const coldStart = now();
const cold = await buildSourceProxy(project, source, { intra: true, force: true });
const coldDuration = now() - coldStart;
const warmStart = now();
const warm = await buildSourceProxy(project, source, { intra: true });
const warmDuration = now() - warmStart;
const proxyValid = (path: string) => readFileSync(path).length > 0;

const preview = await startPreviewServer({
  repo: project,
  timeline,
  port: 0,
  dev: false,
  veanRoot: repo,
  policyProfile: "test",
});
const browser = await chromium.launch({ headless: true });

function rssBytes(): number {
  const result = Bun.spawnSync(["ps", "-axo", "pid=,ppid=,rss=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("unable to sample process RSS");
  const rows = result.stdout
    .toString()
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              ppid: Number(match[2]),
              rss: Number(match[3]),
              command: match[4],
            },
          ]
        : [];
    });
  const descendants = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows)
      if (descendants.has(row.ppid) && !descendants.has(row.pid)) {
        descendants.add(row.pid);
        changed = true;
      }
  }
  return rows
    .filter(
      (row) =>
        descendants.has(row.pid) && /Chromium|chrome|playwright|headless_shell/i.test(row.command),
    )
    .reduce((sum, row) => sum + row.rss * 1024, 0);
}

try {
  const page = await browser.newPage();
  page.on("crash", () => failures.crashes.push("page-crash"));
  page.on("pageerror", (error) => failures.page_errors.push(error.stack ?? error.message));
  const url = new URL(preview.url);
  url.searchParams.set("route", timeline);
  url.searchParams.set("harness", "media");
  const openStart = now();
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.getByTestId("footage-stage").waitFor();
  await page.waitForFunction(() => (window.__veanPerf?.samples ?? 0) > 0, undefined, {
    timeout: 30_000,
  });

  const frameSignature = async () =>
    page.evaluate(async () => {
      const canvas = document.querySelector(
        '[data-testid="footage-stage"] canvas',
      ) as HTMLCanvasElement | null;
      if (!canvas || canvas.width === 0 || canvas.height === 0)
        return { valid: false, nonblack_ratio: 0, signature_sha256: "0".repeat(64) };
      const copy = new OffscreenCanvas(canvas.width, canvas.height);
      const context = copy.getContext("2d", { willReadFrequently: true });
      if (!context) return { valid: false, nonblack_ratio: 0, signature_sha256: "0".repeat(64) };
      context.drawImage(canvas, 0, 0);
      const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let nonblack = 0;
      for (let index = 0; index < bytes.length; index += 4)
        if ((bytes[index] ?? 0) + (bytes[index + 1] ?? 0) + (bytes[index + 2] ?? 0) > 24)
          nonblack++;
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      const signature = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const ratio = nonblack / (bytes.length / 4);
      return { valid: ratio > 0.01, nonblack_ratio: ratio, signature_sha256: signature };
    });
  const waitValidFrame = async (timeoutMs = 10_000) => {
    const start = now();
    for (;;) {
      const frame = await frameSignature();
      if (frame.valid) return frame;
      if (now() - start > timeoutMs) return frame;
      await page.waitForTimeout(20);
    }
  };
  const openFrame = await waitValidFrame();
  if (!openFrame.valid) failures.black_frames.push("project-open");
  const openDuration = now() - openStart;

  const seekSamples = [];
  for (const requested of [10, 60, 20, 90, 40]) {
    const current = await page.evaluate(() => window.__veanOverlay?.().masterFrame ?? 0);
    const start = now();
    await page.keyboard.press(requested > current ? "ArrowRight" : "ArrowLeft");
    const direction = requested > current ? "ArrowRight" : "ArrowLeft";
    for (let step = 1; step < Math.abs(requested - current); step++)
      await page.keyboard.press(direction);
    await page.waitForFunction(
      (frame) =>
        window.__veanOverlay?.().masterFrame === frame && (window.__veanPerf?.samples ?? 0) > 0,
      requested,
      { timeout: 10_000 },
    );
    seekSamples.push({
      requested_frame: requested,
      observed_frame: await page.evaluate(() => window.__veanOverlay?.().masterFrame),
      duration_ms: now() - start,
      frame: await frameSignature(),
    });
  }

  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.__veanAudio?.().playing === true && window.__veanAudio?.().contextState === "running",
    undefined,
    { timeout: 10_000 },
  );
  const avRaw = [];
  for (let index = 0; index < 12; index++) {
    avRaw.push(
      await page.evaluate(() => ({
        master_frame: window.__veanOverlay?.().masterFrame ?? 0,
        context_time: window.__veanAudio?.().contextTime ?? 0,
      })),
    );
    await page.waitForTimeout(75);
  }
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const firstAv = avRaw[0];
  if (!firstAv) throw new Error("playback produced no A/V samples");
  const avSamples = avRaw.map((sample) => ({
    ...sample,
    skew_frames: Math.abs(
      sample.master_frame -
        firstAv.master_frame -
        (sample.context_time - firstAv.context_time) * 30,
    ),
  }));
  if (control === "skew") for (const sample of avSamples) sample.skew_frames += 10;

  for (let index = 0; index < 30; index++)
    await page.keyboard.press(index % 2 === 0 ? "ArrowLeft" : "ArrowRight");
  const drainStart = now();
  const drainSamples = [];
  for (;;) {
    const stats = await page.evaluate(() => window.__veanPerf);
    drainSamples.push({
      at_ms: now() - drainStart,
      workers: stats?.decoder?.workerCount ?? 0,
      in_flight: stats?.decoder?.inFlight ?? 0,
      queued: stats?.decoder?.queued ?? 0,
      cache_bytes: stats?.cache.sizeBytes ?? 0,
    });
    if ((stats?.decoder?.inFlight ?? 0) === 0 && (stats?.decoder?.queued ?? 0) === 0) break;
    if (now() - drainStart > 5_000) {
      failures.stalls.push("queue-drain-timeout");
      break;
    }
    await page.waitForTimeout(20);
  }
  if (control === "never-drain")
    for (const sample of drainSamples) {
      sample.in_flight = Math.max(1, sample.in_flight);
      sample.queued = Math.max(1, sample.queued);
    }

  const recoveryStart = now();
  await page.evaluate(() => {
    const canvas = document.querySelector(
      '[data-testid="footage-stage"] canvas',
    ) as HTMLCanvasElement;
    const gl = canvas.getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_lose_context");
    (window as unknown as { __restorePerfContext?: () => void }).__restorePerfContext = () =>
      extension?.restoreContext();
    extension?.loseContext();
  });
  await page.waitForFunction(() => (window.__veanContextRecovery?.losses ?? 0) > 0);
  await page.evaluate(() =>
    (window as unknown as { __restorePerfContext?: () => void }).__restorePerfContext?.(),
  );
  await page.waitForFunction(
    () =>
      (window.__veanContextRecovery?.restores ?? 0) > 0 &&
      window.__veanContextRecovery?.contentValid === true,
    undefined,
    { timeout: 5_000 },
  );
  const recoveredFrame = await frameSignature();
  if (control === "context-blank") {
    recoveredFrame.valid = false;
    recoveredFrame.nonblack_ratio = 0;
  }
  const recoveryDuration = now() - recoveryStart;

  const memoryStart = now();
  const memorySamples = [];
  for (let index = 0; index < 6; index++) {
    const cacheBytes = await page.evaluate(() => window.__veanPerf?.cache.sizeBytes ?? 0);
    memorySamples.push({
      at_ms: now() - memoryStart,
      rss_bytes: rssBytes(),
      cache_bytes: cacheBytes,
    });
    await page.keyboard.press(index % 2 === 0 ? "ArrowRight" : "ArrowLeft");
    await page.waitForTimeout(200);
  }

  await page.evaluate(() => window.__veanPerfReset?.());
  for (let index = 0; index < compositeCount; index++) {
    await page.keyboard.press(index % 2 === 0 ? "ArrowRight" : "ArrowLeft");
    await page.waitForFunction((count) => (window.__veanPerf?.samples ?? 0) >= count, index + 1, {
      timeout: 5_000,
    });
  }
  let composite = await page.evaluate(() => window.__veanPerf?.rawCompositeMs ?? []);
  if (control === "delay") composite = composite.map((sample) => sample + 1_000);

  const teardownStart = now();
  await page.evaluate(() =>
    (window as unknown as { __veanHarnessUnmount?: () => void }).__veanHarnessUnmount?.(),
  );
  const ledger = await page.evaluate(() => window.__veanMediaResources?.());
  const teardownDuration = now() - teardownStart;
  let events = (ledger?.events ?? []).map((event) => ({
    op: event.operation,
    kind: event.kind,
    id: event.id,
  }));
  if (control === "leak")
    events = events.filter(
      (event, index) => !(event.op === "close" && index === events.length - 1),
    );

  console.log(
    JSON.stringify({
      run_id: createHash("sha256")
        .update(`${process.pid}:${Date.now()}:${project}`)
        .digest("hex")
        .slice(0, 16),
      workloads: {
        cold_proxy_build: {
          duration_ms: coldDuration,
          cached: cold.cached,
          valid_proxy: proxyValid(cold.proxyPath),
        },
        warm_proxy_cache: {
          duration_ms: warmDuration,
          cached: warm.cached,
          valid_proxy: proxyValid(warm.proxyPath),
        },
        project_open_valid_frame: { duration_ms: openDuration, frame: openFrame },
        seek_to_valid_frame: { samples: seekSamples },
        playback_av_skew: { samples: avSamples },
        queue_drain: { samples: drainSamples },
        context_recovery_valid_frame: { duration_ms: recoveryDuration, frame: recoveredFrame },
        memory: { samples: memorySamples },
        teardown: { duration_ms: teardownDuration, resource_events: events },
        failures,
        compositor_microbenchmark: {
          label: "FootageStage composite callback microbenchmark",
          raw_samples: composite,
        },
      },
    }),
  );
} finally {
  await browser.close();
  preview.stop();
  rmSync(project, { recursive: true, force: true });
}
