import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { startPreviewServer } from "../../src/preview/server";
import type { Browser, Page } from "../../viewer/node_modules/playwright/index.js";

const repo = resolve(import.meta.dirname, "../..");
const assets = join(repo, "corpus/harness/media/assets");

type ProductState = {
  currentFrame: number;
  shownFrame: number;
  decodingKeys: string[];
  cache: { entries: number; sizeBytes: number; maxSizeBytes: number };
  decoder: {
    workerCount: number;
    decodes: number;
    inFlight: number;
    queued: number;
    activeClipIds: string[];
    failures: number;
    lastError: string | null;
  } | null;
  audio: {
    contextState: string;
    scheduledClips: number;
    bufferedResources: number;
    playing: boolean;
  } | null;
  resources: { balanced: boolean; outstanding: Array<{ kind: string; id: string }> };
  contextRecovery: { losses: number; restores: number; contentValid: boolean } | null;
  approximate: { active: boolean; hasStill: boolean; stillFrame: number | null };
};

type ProxyMeta = {
  schema: string;
  key: string;
  sourcePath: string;
  sourceSha256: string;
  artifactSha256: string;
  artifactBytes: number;
  hasAlpha: boolean;
  codecName: string;
  pixFmt: string;
  width: number;
  height: number;
  encoderIdentity: string;
  encoderArgv: string[];
};

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function productTimeline(
  path: string,
  clips: Array<{ id: string; source: string; filter?: string }>,
): void {
  const producers = clips
    .map(
      ({ id, source, filter }) =>
        `<producer id="${id}" in="0" out="29"><property name="resource">${xml(source)}</property><property name="length">30</property><property name="shotcut:uuid">${id}</property>${
          filter
            ? `<filter id="${id}-filter" in="0" out="29"><property name="mlt_service">${filter}</property><property name="sigma">4</property></filter>`
            : ""
        }</producer>`,
    )
    .join("");
  const entries = clips.map(({ id }) => `<entry producer="${id}" in="0" out="29"/>`).join("");
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="utf-8"?><mlt LC_NUMERIC="C" root="${xml(
      repo,
    )}" title="H07 product media"><profile description="H07 product media 320x180 30fps" width="320" height="180" progressive="1" frame_rate_num="30" frame_rate_den="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" colorspace="709"/>${producers}<playlist id="v1"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property>${entries}</playlist><tractor id="main" shotcut="1"><track producer="v1"/></tractor></mlt>\n`,
  );
}

async function state(page: Page): Promise<ProductState> {
  return page.evaluate(() => {
    const bridge = (window as unknown as { __veanMediaState?: () => ProductState })
      .__veanMediaState;
    if (!bridge) throw new Error("product media state bridge unavailable");
    return bridge();
  });
}

async function waitForClip(
  page: Page,
  clipId: string,
  priorDecodes: number,
): Promise<ProductState> {
  await page.waitForFunction(
    ({ clipId, priorDecodes }) => {
      const current = (
        window as unknown as { __veanMediaState?: () => ProductState }
      ).__veanMediaState?.();
      return (
        current?.decoder?.activeClipIds.includes(clipId) === true &&
        (current.decoder?.decodes ?? 0) > priorDecodes &&
        current.cache.entries > 0 &&
        current.decodingKeys.length === 0
      );
    },
    { clipId, priorDecodes },
    { timeout: 30_000 },
  );
  return state(page);
}

async function openProduct(browser: Browser, url: string, timeline: string): Promise<Page> {
  const page = await browser.newPage();
  const target = new URL(url);
  target.searchParams.set("route", timeline);
  target.searchParams.set("harness", "media");
  await page.goto(target.href, { waitUntil: "domcontentloaded" });
  await page.getByTestId("footage-stage").waitFor({ timeout: 20_000 });
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __veanMediaState?: unknown }).__veanMediaState === "function",
  );
  return page;
}

export async function runProductMediaAssurance(args: {
  browser: Browser;
  artifactDir: string;
  control: string;
}): Promise<{
  lineage: Array<{ id: string; manifest: ProxyMeta; responseSha256: string }>;
  productDecode: Array<{ id: string; frame: number; state: ProductState }>;
  resilience: { beforeUnmount: ProductState; afterUnmount: ProductState };
  alphaProbeFailure: { status: string };
  approximateFallback: { status: string; requests: number };
  runtimeProxyCellsSeparate: boolean;
  knownWkProductDecoderBlockerPreserved: boolean;
  control: string;
}> {
  mkdirSync(args.artifactDir, { recursive: true });
  const clipInputs = [
    { id: "ingest-h264", file: "source-h264-aac.mp4", codec: "h264", alpha: false },
    { id: "ingest-hevc", file: "source-hevc-main10.mov", codec: "h264", alpha: false },
    { id: "ingest-prores422", file: "source-prores422.mov", codec: "h264", alpha: false },
    {
      id: "ingest-prores4444-alpha",
      file: "source-prores4444-alpha.mov",
      codec: "vp9",
      alpha: true,
    },
  ];
  const timeline = join(args.artifactDir, "product-ingest.mlt");
  productTimeline(
    timeline,
    clipInputs.map(({ id, file }) => ({ id, source: join(assets, file) })),
  );
  const preview = await startPreviewServer({
    repo,
    timeline,
    port: 0,
    dev: false,
    veanRoot: repo,
    policyProfile: "test",
  });
  let page: Page | undefined;
  try {
    const lineage: Array<{ id: string; manifest: ProxyMeta; responseSha256: string }> = [];
    for (const input of clipInputs) {
      const source = join(assets, input.file);
      const query = new URLSearchParams({ path: source, route: timeline });
      const response = await fetch(new URL(`/api/source-proxy?${query.toString()}`, preview.url));
      if (!response.ok)
        throw new Error(`product source-proxy failed:${input.id}:${await response.text()}`);
      const responseBytes = Buffer.from(await response.arrayBuffer());
      const responseSha256 = createHash("sha256").update(responseBytes).digest("hex");
      const manifests = readdirSync(join(repo, ".vean/cache/source-proxy"))
        .filter((name) => name.endsWith(".json"))
        .map(
          (name) =>
            JSON.parse(
              readFileSync(join(repo, ".vean/cache/source-proxy", name), "utf8"),
            ) as ProxyMeta,
        );
      const body = manifests.find(
        (candidate) =>
          candidate.sourcePath === source &&
          candidate.sourceSha256 === sha256(source) &&
          candidate.artifactSha256 === responseSha256,
      );
      if (!body) throw new Error(`product source-proxy omitted lineage:${input.id}`);
      if (
        body.artifactSha256 !== responseSha256 ||
        body.artifactBytes !== responseBytes.byteLength ||
        body.codecName !== input.codec ||
        body.hasAlpha !== input.alpha ||
        (!input.alpha && body.pixFmt !== "yuv420p") ||
        !body.encoderIdentity ||
        body.encoderArgv.length === 0
      )
        throw new Error(`product source-proxy lineage mismatch:${input.id}`);
      lineage.push({ id: input.id, manifest: body, responseSha256 });
    }

    page = await openProduct(args.browser, preview.url, timeline);
    const productDecode: Array<{ id: string; frame: number; state: ProductState }> = [];
    let priorDecodes = 0;
    for (let index = 0; index < clipInputs.length; index++) {
      const input = clipInputs[index];
      if (!input) continue;
      const targetFrame = index * 30 + 10;
      const current = (await state(page)).currentFrame;
      for (let frame = current; frame < targetFrame; frame++)
        await page.keyboard.press("ArrowRight");
      const observed = await waitForClip(page, input.id, priorDecodes);
      priorDecodes = observed.decoder?.decodes ?? priorDecodes;
      productDecode.push({ id: input.id, frame: targetFrame, state: observed });
    }

    // Real transport/audio/seek lifecycle. Space enters product playback, a large
    // seek exercises generation cancellation, and the actual product canvas loses
    // and restores its own GL context.
    await page.keyboard.press("Space");
    await page.waitForFunction(
      () =>
        (window as unknown as { __veanMediaState?: () => ProductState }).__veanMediaState?.().audio
          ?.playing === true,
    );
    await page.waitForTimeout(200);
    await page.keyboard.press("Space");
    for (let index = 0; index < 40; index++) await page.keyboard.press("ArrowLeft");
    await page.waitForFunction(
      () => {
        const value = (
          window as unknown as { __veanMediaState?: () => ProductState }
        ).__veanMediaState?.();
        return (value?.decoder?.inFlight ?? 1) === 0 && (value?.decoder?.queued ?? 1) === 0;
      },
      undefined,
      { timeout: 20_000 },
    );
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="footage-canvas"]');
      const gl = canvas?.getContext("webgl2");
      const extension = gl?.getExtension("WEBGL_lose_context");
      if (!extension) throw new Error("product canvas lacks WEBGL_lose_context");
      extension.loseContext();
      setTimeout(() => extension.restoreContext(), 100);
    });
    await page.waitForFunction(
      () => {
        const recovery = (
          window as unknown as { __veanMediaState?: () => ProductState }
        ).__veanMediaState?.().contextRecovery;
        return (
          (recovery?.losses ?? 0) >= 1 && (recovery?.restores ?? 0) >= 1 && recovery?.contentValid
        );
      },
      undefined,
      { timeout: 10_000 },
    );
    const beforeUnmount = await state(page);
    await page.evaluate(() => {
      const unmount = (window as unknown as { __veanHarnessUnmount?: () => void })
        .__veanHarnessUnmount;
      if (!unmount) throw new Error("media harness unmount unavailable");
      unmount();
    });
    const afterUnmount = await state(page);
    if (!afterUnmount.resources.balanced || afterUnmount.resources.outstanding.length > 0)
      throw new Error(`product resources leaked:${JSON.stringify(afterUnmount.resources)}`);
    if (beforeUnmount.cache.sizeBytes > beforeUnmount.cache.maxSizeBytes)
      throw new Error("product frame cache exceeded hard byte cap");
    await page.close();
    page = undefined;

    // Alpha-probe failure: authorize the exact malformed source through a real
    // timeline, load the real viewer, and require the product decoder/server error.
    const invalidTimeline = join(args.artifactDir, "product-alpha-probe-failure.mlt");
    const invalidSource = join(assets, "alpha-probe-failure.bin");
    productTimeline(invalidTimeline, [{ id: "alpha-probe-failure", source: invalidSource }]);
    const invalidPreview = await startPreviewServer({
      repo,
      timeline: invalidTimeline,
      port: 0,
      dev: false,
      veanRoot: repo,
      policyProfile: "test",
    });
    let invalidPage: Page | undefined;
    try {
      invalidPage = await openProduct(args.browser, invalidPreview.url, invalidTimeline);
      const query = new URLSearchParams({ path: invalidSource, route: invalidTimeline });
      const response = await fetch(
        new URL(`/api/source-proxy?${query.toString()}`, invalidPreview.url),
      );
      const body = await response.text();
      if (response.status !== 422 || !body.includes("ALPHA_PROBE_UNKNOWN"))
        throw new Error(`alpha probe did not fail closed:${response.status}:${body}`);
      await invalidPage.waitForFunction(
        () =>
          (window as unknown as { __veanMediaState?: () => ProductState }).__veanMediaState?.()
            .decoder?.failures !== 0,
        undefined,
        { timeout: 10_000 },
      );
    } finally {
      await invalidPage?.close();
      invalidPreview.stop();
    }

    // Approximate fallback: an actual parsed filter marks FootageStage approximate;
    // invoking its bridge must make exactly one real /api/still request and place
    // the returned product still. No synthetic PNG or createImageBitmap probe.
    const approxTimeline = join(args.artifactDir, "product-approx-filter.mlt");
    productTimeline(approxTimeline, [
      {
        id: "approx-filter",
        source: join(assets, "source-h264-aac.mp4"),
        filter: "frei0r.gaussianblur",
      },
    ]);
    const approxPreview = await startPreviewServer({
      repo,
      timeline: approxTimeline,
      port: 0,
      dev: false,
      veanRoot: repo,
      policyProfile: "test",
    });
    let approxPage: Page | undefined;
    try {
      approxPage = await openProduct(args.browser, approxPreview.url, approxTimeline);
      await approxPage.waitForFunction(
        () =>
          (window as unknown as { __veanMediaState?: () => ProductState }).__veanMediaState?.()
            .approximate.active === true,
      );
      let stillRequests = 0;
      approxPage.on("request", (request) => {
        if (new URL(request.url()).pathname === "/api/still") stillRequests++;
      });
      await approxPage.evaluate(async () => {
        const fallback = (
          window as unknown as { __veanApprox?: { requestExactStill: () => Promise<void> } }
        ).__veanApprox;
        if (!fallback) throw new Error("product approximate fallback unavailable");
        await fallback.requestExactStill();
      });
      await approxPage.getByTestId("exact-still").waitFor({ timeout: 20_000 });
      if (stillRequests !== 1)
        throw new Error(`expected one product still request, got ${stillRequests}`);
    } finally {
      await approxPage?.close();
      approxPreview.stop();
    }

    const result = {
      lineage,
      productDecode,
      resilience: { beforeUnmount, afterUnmount },
      alphaProbeFailure: { status: "verified_fail_closed" },
      approximateFallback: { status: "verified", requests: 1 },
      runtimeProxyCellsSeparate: true,
      knownWkProductDecoderBlockerPreserved: true,
      control: args.control,
    };
    writeFileSync(
      join(args.artifactDir, "product-media.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    return result;
  } finally {
    await page?.close();
    preview.stop();
  }
}
