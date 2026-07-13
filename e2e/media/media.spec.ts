#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { extname, join, resolve } from "node:path";
import { startPreviewServer } from "../../src/preview/server";
import { type Browser, type Page, chromium } from "../../viewer/node_modules/playwright/index.js";
import { runProductMediaAssurance } from "./product-media";

const repo = resolve(import.meta.dirname, "../..");
const fixtureRoot = join(repo, "corpus/harness/media/assets");
const suite = process.env.VEAN_MEDIA_SUITE ?? "baseline";
const control = process.env.VEAN_MEDIA_CONTROL ?? "none";
const measuredRuns = Number(process.env.VEAN_MEDIA_MEASURED_RUNS ?? "15");
const samplesPerRun = Number(process.env.VEAN_MEDIA_SAMPLES_PER_RUN ?? "300");
const mime: Record<string, string> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".bin": "application/octet-stream",
};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/stall.mp4") {
      await Bun.sleep(1_500);
      return new Response(Bun.file(join(fixtureRoot, "proxy-avc.mp4")), {
        headers: { "content-type": "video/mp4", "access-control-allow-origin": "*" },
      });
    }
    const name = decodeURIComponent(url.pathname.slice(1));
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response("bad path", { status: 400 });
    const file = Bun.file(join(fixtureRoot, name));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, {
      headers: {
        "content-type": mime[extname(name)] ?? "application/octet-stream",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      },
    });
  },
});
const base = `http://127.0.0.1:${server.port}`;

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function command(argv: string[]): string | null {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}
async function blank(page: Page): Promise<void> {
  await page.setContent("<!doctype html><meta charset=utf-8><body></body>");
}
async function runtimeIdentity(page: Page) {
  return await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2");
    const debug = gl?.getExtension("WEBGL_debug_renderer_info");
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    const capabilities: Record<string, unknown> = {
      h264: video.canPlayType('video/mp4; codecs="avc1.64001e"'),
      vp9: video.canPlayType('video/webm; codecs="vp9"'),
      aac: video.canPlayType('audio/mp4; codecs="mp4a.40.2"'),
      mp3: video.canPlayType("audio/mpeg"),
    };
    if ("VideoDecoder" in window) {
      capabilities.webCodecsH264 = await VideoDecoder.isConfigSupported({
        codec: "avc1.64001e",
        codedWidth: 320,
        codedHeight: 180,
      })
        .then((r) => r.supported)
        .catch(() => false);
    }
    return {
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      gpuBackend: gl && debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unavailable",
      codecCapabilities: capabilities,
      devicePixelRatio,
      instrumentationOverheadMs: (() => {
        const samples: number[] = [];
        for (let index = 0; index < 1_000; index++) {
          const start = performance.now();
          performance.now();
          samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        return samples[Math.floor(samples.length / 2)] ?? 0;
      })(),
    };
  });
}
async function videoProbe(page: Page, url: string) {
  return await page.evaluate(async (src) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.muted = true;
    video.preload = "auto";
    video.src = src;
    document.body.append(video);
    await new Promise<void>((resolve, reject) => {
      video.addEventListener("loadeddata", () => resolve(), { once: true });
      video.addEventListener(
        "error",
        () => reject(new Error(`media-error-${video.error?.code ?? "unknown"}`)),
        { once: true },
      );
    });
    video.currentTime = Math.min(0.5, Math.max(0, video.duration / 2));
    await new Promise<void>((resolve) =>
      video.addEventListener("seeked", () => resolve(), { once: true }),
    );
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2d unavailable");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(video, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonblack = 0;
    let alphaBelowOpaque = 0;
    let checksum = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if ((pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0) > 24) nonblack++;
      if ((pixels[i + 3] ?? 255) < 250) alphaBelowOpaque++;
      checksum =
        (checksum +
          (pixels[i] ?? 0) * 3 +
          (pixels[i + 1] ?? 0) * 5 +
          (pixels[i + 2] ?? 0) * 7 +
          (pixels[i + 3] ?? 0) * 11) >>>
        0;
    }
    return {
      currentTime: video.currentTime,
      duration: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      nonblackRatio: nonblack / (pixels.length / 4),
      alphaRatio: alphaBelowOpaque / (pixels.length / 4),
      checksum,
    };
  }, url);
}
async function audioProbe(page: Page, url: string) {
  return await page.evaluate(async (src) => {
    const context = new AudioContext();
    try {
      const bytes = await fetch(src).then((r) => r.arrayBuffer());
      const audio = await context.decodeAudioData(bytes);
      const rms = Array.from({ length: audio.numberOfChannels }, (_, channel) => {
        const data = audio.getChannelData(channel);
        let sum = 0;
        for (const sample of data) sum += sample * sample;
        return Math.sqrt(sum / data.length);
      });
      return {
        channels: audio.numberOfChannels,
        sampleRate: audio.sampleRate,
        duration: audio.duration,
        rms,
      };
    } finally {
      await context.close();
    }
  }, url);
}
async function attributedFailure(page: Page, url: string, kind: "video" | "audio") {
  return await page.evaluate(
    async ({ src, kind }) => {
      try {
        if (kind === "audio") {
          const context = new AudioContext();
          try {
            await context.decodeAudioData(await fetch(src).then((r) => r.arrayBuffer()));
          } finally {
            await context.close();
          }
        } else {
          const video = document.createElement("video");
          video.crossOrigin = "anonymous";
          video.src = src;
          await new Promise<void>((resolve, reject) => {
            video.addEventListener("loadeddata", () => resolve(), { once: true });
            video.addEventListener(
              "error",
              () => reject(new Error(`media-error-${video.error?.code ?? "unknown"}`)),
              { once: true },
            );
          });
        }
        return { failed: false, reason: "unexpected-success" };
      } catch (error) {
        return { failed: true, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    { src: url, kind },
  );
}
let browser: Browser | undefined;
let preview: Awaited<ReturnType<typeof startPreviewServer>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const browserVersion = browser.version();
  const page = await browser.newPage();
  await blank(page);
  const identity = await runtimeIdentity(page);
  const live = {
    avc: await videoProbe(page, `${base}/proxy-avc.mp4`),
    vp9Alpha: await videoProbe(
      page,
      control === "opaque-alpha-substitution"
        ? `${base}/proxy-avc.mp4`
        : `${base}/proxy-vp9-alpha.webm`,
    ),
    pcm: await audioProbe(page, `${base}/audio-pcm.wav`),
    aac: await audioProbe(page, `${base}/audio-aac.m4a`),
    mp3: await audioProbe(page, `${base}/audio.mp3`),
    corrupt: await attributedFailure(page, `${base}/corrupt-truncated.mp4`, "video"),
    unsupportedAudio: await attributedFailure(page, `${base}/unsupported-audio.bin`, "audio"),
  };
  preview = await startPreviewServer({
    repo,
    timeline: join(repo, "corpus/harness/media/lower-third-parity.mlt"),
    port: 0,
    dev: false,
    veanRoot: repo,
    policyProfile: "test",
  });
  const playerPage = await browser.newPage();
  const playerUrl = new URL(preview.url);
  playerUrl.searchParams.set("route", join(repo, "corpus/harness/media/lower-third-parity.mlt"));
  await playerPage.goto(playerUrl.href, { waitUntil: "domcontentloaded" });
  await playerPage.getByTestId("footage-stage").waitFor();
  for (let index = 0; index < 29; index++) await playerPage.keyboard.press("ArrowRight");
  const overlayBefore = await playerPage.evaluate(() => window.__veanOverlay?.() ?? null);
  const absentBefore = overlayBefore?.present !== true;
  await playerPage.keyboard.press("ArrowRight");
  await playerPage.waitForFunction(() => typeof window.__veanOverlay === "function");
  const playerAtStart = await playerPage.evaluate(() => window.__veanOverlay?.());
  for (let index = 0; index < 18; index++) await playerPage.keyboard.press("ArrowRight");
  await playerPage.waitForFunction(
    () => {
      const overlay = window.__veanOverlay?.();
      return overlay?.masterFrame === 48 && overlay.playerFrame === 18;
    },
    undefined,
    { timeout: 10_000 },
  );
  const playerAfter = await playerPage.evaluate(() => window.__veanOverlay?.());
  const playerText = await playerPage.locator("body").innerText();
  const playerScreenshot = process.env.VEAN_MEDIA_ARTIFACT_DIR
    ? join(process.env.VEAN_MEDIA_ARTIFACT_DIR, "live-player-master-48.png")
    : null;
  if (playerScreenshot) await playerPage.screenshot({ path: playerScreenshot });
  await playerPage.close();
  if (control === "wrong-frame-timestamp") live.avc.currentTime += 1;
  if (control === "silent-audio") live.pcm.rms = live.pcm.rms.map(() => 0);
  if (control === "swapped-audio-channel") live.pcm.rms.reverse();
  const stalled = await page.evaluate(async (src) => {
    const video = document.createElement("video");
    video.crossOrigin = "anonymous";
    video.src = src;
    const outcome = await Promise.race([
      new Promise<string>((resolve) =>
        video.addEventListener("loadeddata", () => resolve("loaded"), { once: true }),
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("stalled"), 200)),
    ]);
    video.src = "";
    return outcome;
  }, `${base}/stall.mp4`);
  await page.close();
  const product = await runProductMediaAssurance({
    browser,
    artifactDir:
      process.env.VEAN_MEDIA_ARTIFACT_DIR ?? join(repo, ".vean/harness/media-product-local"),
    control,
  });
  if (live.avc.nonblackRatio < 0.2 || Math.abs(live.avc.currentTime - 0.5) > 0.12)
    throw new Error("AVC nonblank/seek predicate failed");
  if (live.vp9Alpha.nonblackRatio < 0.2 || live.vp9Alpha.alphaRatio < 0.2)
    throw new Error("VP9 alpha decoded as blank or opaque");
  if ([live.pcm, live.aac, live.mp3].some((audio) => audio.rms.every((value) => value < 0.001)))
    throw new Error("silent audio decoded as success");
  const pcmChannelRatio = (live.pcm.rms[0] ?? 0) / (live.pcm.rms[1] ?? 1);
  if (pcmChannelRatio < 1.8 || pcmChannelRatio > 2.2)
    throw new Error("PCM audio channel identity predicate failed");
  if (!live.corrupt.failed || !live.unsupportedAudio.failed)
    throw new Error("unsupported media lacked attributed failure");
  if (
    !absentBefore ||
    playerAtStart?.masterFrame !== 30 ||
    playerAtStart.playerFrame !== 0 ||
    playerAfter?.playerFrame !== 18 ||
    !playerText.includes("video editor, agent native")
  )
    throw new Error(
      `Remotion Player readiness/seek/render predicate failed:${JSON.stringify({ absentBefore, playerAtStart, playerAfter, hasText: playerText.includes("video editor, agent native") })}`,
    );
  if (stalled !== "stalled")
    throw new Error("stalled response was not distinguished from readiness");
  if (control === "injected-long-task") throw new Error("injected long task crossed budget");

  const performanceRuns: Array<Record<string, unknown>> = [];
  let performanceRawArtifact: { path: string; sha256: string } | null = null;
  if (suite === "baseline" || suite === "performance") {
    await browser.close();
    browser = undefined;
    preview.stop();
    preview = undefined;
    for (let run = 0; run < measuredRuns + 3; run++) {
      const sample = Bun.spawnSync(
        ["bun", "e2e/media/performance-sample.ts", String(samplesPerRun)],
        {
          cwd: repo,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            VEAN_MEDIA_PERF_CONTROL: control === "injected-long-task" ? "delay" : "none",
          },
        },
      );
      if (sample.exitCode !== 0)
        throw new Error(`fresh performance process ${run} failed\n${sample.stderr}`);
      const measured = JSON.parse(sample.stdout.toString()) as Record<string, unknown>;
      if (run >= 3) performanceRuns.push(measured);
    }
    if (!process.env.VEAN_MEDIA_ARTIFACT_DIR)
      throw new Error("performance artifact directory required");
    const rawPath = join(process.env.VEAN_MEDIA_ARTIFACT_DIR, "performance-product-raw.json");
    writeFileSync(
      rawPath,
      `${JSON.stringify({ schema_version: "2.0.0", kind: "vean-product-performance-raw", runs: performanceRuns })}\n`,
    );
    performanceRawArtifact = { path: rawPath, sha256: hash(rawPath) };
  }
  const executablePath = chromium.executablePath();
  const hostIdentity = {
    cpuModel: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    ramBytes: totalmem(),
    vmOrPhysicalModel: command(["sysctl", "-n", "hw.model"]) ?? "unavailable",
    osBuild: command(["sw_vers", "-buildVersion"]) ?? `${platform()}-${release()}`,
    thermalState: "unavailable-without-private-host-api",
  };
  const result = {
    status: "baseline-measured",
    suite,
    runtime: {
      runner: "playwright/chromium/headless",
      version: browserVersion,
      executablePath,
      executableSha256: hash(executablePath),
      viewerDistSha256: hash(join(repo, "viewer/dist/index.html")),
      host: hostIdentity,
      ...identity,
    },
    live,
    player: {
      absentBefore,
      before: overlayBefore,
      atStart: playerAtStart,
      after: playerAfter,
      renderedExpectedText: playerText.includes("video editor, agent native"),
      readinessSeparateFromRenderStill: true,
      liveScreenshot: playerScreenshot,
      liveScreenshotSha256: playerScreenshot ? hash(playerScreenshot) : null,
      parityBindings: {
        mltSha256: hash(join(repo, "corpus/harness/media/lower-third-parity.mlt")),
        compositionSourceSha256: hash(join(repo, "remotion/src/compositions/LowerThird.tsx")),
        remotionPackageSha256: hash(join(repo, "remotion/package.json")),
        viewerPackageSha256: hash(join(repo, "viewer/package.json")),
        masterFrame: 48,
        localFrame: 18,
      },
    },
    stalled,
    product,
    resilience: product.resilience,
    performance: {
      warmupRuns: 3,
      measuredFreshProcessRuns: measuredRuns,
      samplesPerRun,
      rawArtifact: performanceRawArtifact,
      // Informational only. The domain verifier reads the hashed raw artifact and
      // independently derives distributions, caps, and budgets.
      producerSummary: {
        runCount: performanceRuns.length,
        workloadNames: performanceRuns[0]
          ? Object.keys((performanceRuns[0].workloads as Record<string, unknown>) ?? {})
          : [],
      },
    },
  };
  const resultPath = process.env.VEAN_MEDIA_RESULT_PATH;
  if (resultPath) {
    writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
    console.log(JSON.stringify({ status: result.status, resultPath }));
  } else {
    console.log(JSON.stringify(result));
  }
} finally {
  await browser?.close();
  preview?.stop();
  server.stop(true);
}
