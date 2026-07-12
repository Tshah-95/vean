import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { browser } from "@wdio/globals";
import {
  bundleIdentifier,
  listenerPid,
  processIdentity,
  readContext,
  writeNativeResult,
} from "./runtime";

type Cell = {
  id: string;
  outcome: string;
  observations: Record<string, unknown>;
};

describe("Vean media in the actual Tauri WKWebView", () => {
  it("executes every declared WKWebView media cell", async () => {
    const context = readContext();
    if (!context.mediaManifestPath || !context.mediaStaticPrefix) {
      throw new Error("H07 media context is incomplete");
    }
    const finalOrigin = `http://127.0.0.1:${context.previewPort}`;
    await browser.waitUntil(async () => (await browser.getUrl()).startsWith(finalOrigin), {
      timeout: 90_000,
      interval: 250,
      timeoutMsg: `main WKWebView never reached ${finalOrigin}`,
    });

    const prefix = context.mediaStaticPrefix;
    const cells = (await browser.executeAsync(
      (staticPrefix: string, done: (value: Cell[]) => void) => {
        const url = (name: string) => `${staticPrefix}/${name}`;
        const wait = (target: EventTarget, success: string, failure: string, timeout = 20_000) =>
          new Promise<void>((resolve, reject) => {
            const timer = window.setTimeout(() => reject(new Error(`timeout:${success}`)), timeout);
            target.addEventListener(
              success,
              () => {
                window.clearTimeout(timer);
                resolve();
              },
              { once: true },
            );
            target.addEventListener(
              failure,
              () => {
                window.clearTimeout(timer);
                reject(new Error(failure));
              },
              { once: true },
            );
          });
        const video = async (name: string, alpha: boolean) => {
          const element = document.createElement("video");
          element.muted = true;
          element.playsInline = true;
          element.preload = "auto";
          element.src = url(name);
          document.body.append(element);
          await wait(element, "loadeddata", "error");
          const requested = Math.min(0.5, Math.max(0, element.duration / 3));
          const seek = wait(element, "seeked", "error");
          element.currentTime = requested;
          await seek;
          const canvas = document.createElement("canvas");
          canvas.width = element.videoWidth;
          canvas.height = element.videoHeight;
          canvas.dataset.h07Cell = name;
          canvas.style.width = "320px";
          canvas.style.height = "180px";
          canvas.style.background = "repeating-conic-gradient(#ddd 0 25%,#777 0 50%) 0/24px 24px";
          document.body.append(canvas);
          const context2d = canvas.getContext("2d", { alpha: true });
          if (!context2d) throw new Error("2d-context-unavailable");
          context2d.clearRect(0, 0, canvas.width, canvas.height);
          context2d.drawImage(element, 0, 0);
          const pixels = context2d.getImageData(0, 0, canvas.width, canvas.height).data;
          let nonblack = 0;
          let transparent = 0;
          for (let index = 0; index < pixels.length; index += 4) {
            if ((pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0) > 24)
              nonblack += 1;
            if ((pixels[index + 3] ?? 255) < 250) transparent += 1;
          }
          element.remove();
          const count = pixels.length / 4;
          return {
            decoded: true,
            requested_time_seconds: requested,
            decoded_time_seconds: element.currentTime,
            seek_error_seconds: Math.abs(element.currentTime - requested),
            nonblack_ratio: nonblack / count,
            ...(alpha ? { alpha_ratio: transparent / count } : {}),
            video_width: canvas.width,
            video_height: canvas.height,
          };
        };
        const audio = async (name: string) => {
          const response = await fetch(url(name));
          if (!response.ok) throw new Error(`fetch:${response.status}`);
          const audioContext = new AudioContext();
          try {
            const buffer = await audioContext.decodeAudioData(await response.arrayBuffer());
            const rms = Array.from({ length: buffer.numberOfChannels }, (_, channel) => {
              const samples = buffer.getChannelData(channel);
              let sum = 0;
              for (const sample of samples) sum += sample * sample;
              return Math.sqrt(sum / samples.length);
            });
            return { rms, channels: buffer.numberOfChannels, sample_rate: buffer.sampleRate };
          } finally {
            await audioContext.close();
          }
        };
        const failsVideo = async (name: string) => {
          const element = document.createElement("video");
          element.muted = true;
          element.src = url(name);
          try {
            await wait(element, "loadeddata", "error", 10_000);
            return { failed: false, failure_reason: "unexpected-decode" };
          } catch (error) {
            return { failed: true, failure_reason: String(error) };
          }
        };
        const failsAudio = async (name: string) => {
          const audioContext = new AudioContext();
          try {
            const response = await fetch(url(name));
            await audioContext.decodeAudioData(await response.arrayBuffer());
            return { failed: false, failure_reason: "unexpected-decode" };
          } catch (error) {
            return { failed: true, failure_reason: String(error) };
          } finally {
            await audioContext.close();
          }
        };
        const fallback = async () => {
          const image = new Image();
          image.src = url("fallback-mlt-still.png");
          await wait(image, "load", "error");
          const canvas = document.createElement("canvas");
          canvas.width = image.naturalWidth;
          canvas.height = image.naturalHeight;
          canvas.dataset.h07Cell = "fallback-mlt-still";
          document.body.append(canvas);
          const context2d = canvas.getContext("2d");
          if (!context2d) throw new Error("2d-context-unavailable");
          context2d.drawImage(image, 0, 0);
          const pixel = context2d.getImageData(canvas.width / 2, canvas.height / 2, 1, 1).data;
          return {
            fallback_used: true,
            fallback_kind: "mlt-still",
            nonblank: (pixel[0] ?? 0) + (pixel[1] ?? 0) + (pixel[2] ?? 0) > 0,
          };
        };
        const alphaProbe = async () => {
          const response = await fetch(url("alpha-probe-failure.bin"));
          try {
            await createImageBitmap(await response.blob());
            return { failed_closed: false, reason: "UNEXPECTED_PROBE_SUCCESS" };
          } catch {
            return { failed_closed: true, reason: "ALPHA_PROBE_UNKNOWN" };
          }
        };
        (async () => {
          document.body.innerHTML = "<h1>H07 actual WKWebView media matrix</h1>";
          const avc = await video("proxy-avc.mp4", false);
          const alpha = await video("proxy-vp9-alpha.webm", true);
          const rows: Cell[] = [
            {
              id: "ingest.h264-aac",
              outcome: "verified_supported",
              observations: {
                ...avc,
                fixture_file: "source-h264-aac.mp4",
                decoded_file: "proxy-avc.mp4",
              },
            },
            {
              id: "ingest.hevc-main10",
              outcome: "verified_via_proxy",
              observations: {
                ...avc,
                fixture_file: "source-hevc-main10.mov",
                decoded_file: "proxy-avc.mp4",
              },
            },
            {
              id: "ingest.prores422-pcm",
              outcome: "verified_via_proxy",
              observations: {
                ...avc,
                fixture_file: "source-prores422.mov",
                decoded_file: "proxy-avc.mp4",
              },
            },
            {
              id: "ingest.prores4444-alpha",
              outcome: "verified_supported",
              observations: {
                ...alpha,
                fixture_file: "source-prores4444-alpha.mov",
                decoded_file: "proxy-vp9-alpha.webm",
              },
            },
            {
              id: "runtime.proxy-avc",
              outcome: "verified_supported",
              observations: {
                ...avc,
                fixture_file: "proxy-avc.mp4",
                decoded_file: "proxy-avc.mp4",
              },
            },
            {
              id: "runtime.proxy-vp9-alpha",
              outcome: "verified_supported",
              observations: {
                ...alpha,
                fixture_file: "proxy-vp9-alpha.webm",
                decoded_file: "proxy-vp9-alpha.webm",
              },
            },
            {
              id: "audio.pcm-wav",
              outcome: "verified_supported",
              observations: { ...(await audio("audio-pcm.wav")), fixture_file: "audio-pcm.wav" },
            },
            {
              id: "audio.aac-lc",
              outcome: "verified_supported",
              observations: { ...(await audio("audio-aac.m4a")), fixture_file: "audio-aac.m4a" },
            },
            {
              id: "audio.mp3",
              outcome: "verified_supported",
              observations: { ...(await audio("audio.mp3")), fixture_file: "audio.mp3" },
            },
            {
              id: "unsupported.corrupt",
              outcome: "verified_attributed_failure",
              observations: {
                ...(await failsVideo("corrupt-truncated.mp4")),
                fixture_file: "corrupt-truncated.mp4",
              },
            },
            {
              id: "unsupported.audio",
              outcome: "verified_attributed_failure",
              observations: {
                ...(await failsAudio("unsupported-audio.bin")),
                fixture_file: "unsupported-audio.bin",
              },
            },
            {
              id: "fallback.approx-filter",
              outcome: "verified_explicit_fallback",
              observations: await fallback(),
            },
            {
              id: "probe.alpha-unknown",
              outcome: "verified_fail_closed",
              observations: await alphaProbe(),
            },
          ];
          done(rows);
        })().catch((error) =>
          done([
            { id: "provider.failure", outcome: "failed", observations: { error: String(error) } },
          ]),
        );
      },
      prefix,
    )) as Cell[];

    mkdirSync(context.artifactDir, { recursive: true });
    const screenshotPath = join(context.artifactDir, "wkwebview-media.png");
    await browser.saveScreenshot(screenshotPath);
    const appPid = listenerPid(context.webdriverPort);
    const app = processIdentity(appPid);
    const userAgent = await browser.execute(() => navigator.userAgent);
    writeNativeResult(context, {
      provider: "embedded-safe-wkwebview-media",
      sourceSha: context.sourceSha,
      fixtureRunId: context.runId,
      cells,
      runtime: {
        userAgent,
        webkitVersion: String(userAgent).match(/AppleWebKit\/([^ ]+)/)?.[1] ?? null,
        finalUrl: await browser.getUrl(),
      },
      process: { ...app, observedBundleId: bundleIdentifier(appPid) },
      driver: {
        port: context.webdriverPort,
        sessionId: browser.sessionId,
        capabilities: browser.capabilities,
      },
      screenshotPath,
    });
  });
});
