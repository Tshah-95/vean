#!/usr/bin/env bun
import { join, resolve } from "node:path";
import { startPreviewServer } from "../../src/preview/server";
import { chromium } from "../../viewer/node_modules/playwright/index.js";

const repo = resolve(import.meta.dirname, "../..");
const count = Number(process.argv[2] ?? "300");
if (!Number.isInteger(count) || count < 1) throw new Error("positive sample count required");
const preview = await startPreviewServer({
  repo,
  timeline: join(repo, "corpus/demo/graphic-overlay.mlt"),
  port: 0,
  dev: false,
  veanRoot: repo,
  policyProfile: "test",
});
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const url = new URL(preview.url);
  url.searchParams.set("route", join(repo, "corpus/demo/graphic-overlay.mlt"));
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __veanPerfReset?: unknown }).__veanPerfReset === "function",
  );
  await page.evaluate(() =>
    (window as unknown as { __veanPerfReset: () => void }).__veanPerfReset(),
  );
  for (let index = 0; index < count; index++) {
    await page.keyboard.press(index % 2 === 0 ? "ArrowRight" : "ArrowLeft");
    await page.waitForTimeout(1);
  }
  await page.waitForFunction(
    (expected) =>
      ((window as unknown as { __veanPerf?: { samples?: number } }).__veanPerf?.samples ?? 0) >=
      expected,
    count,
    { timeout: 30_000 },
  );
  const samples = await page.evaluate(
    () =>
      (window as unknown as { __veanPerf?: { rawCompositeMs?: number[] } }).__veanPerf
        ?.rawCompositeMs ?? [],
  );
  if (samples.length !== count) throw new Error(`expected ${count} samples, got ${samples.length}`);
  console.log(JSON.stringify(samples));
} finally {
  await browser.close();
  preview.stop();
}
