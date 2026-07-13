import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  type BrowserMutationObservation,
  evaluateBrowserMutation,
} from "../../scripts/harness/browser-domain-truth";
import { createFixture, hashFile } from "../../scripts/harness/fixture";
import { fromMlt } from "../../src/ir/parse";
import type { Item, Timeline } from "../../src/ir/types";
import { startPreviewServer } from "../../src/preview/server";
import { type Browser, type Page, chromium } from "../../viewer/node_modules/playwright/index.js";

const repo = resolve(import.meta.dirname, "../..");
const scenarioLedger = JSON.parse(
  readFileSync(join(repo, "artifacts/specs/harness-scenarios/browser.json"), "utf8"),
) as { scenarios: Array<{ id: string }> };
const artifactDir = process.env.VEAN_BROWSER_ARTIFACT_DIR;
if (!artifactDir) throw new Error("VEAN_BROWSER_ARTIFACT_DIR is required");
mkdirSync(artifactDir, { recursive: true });

const executed: string[] = [];
const browserLog: string[] = [];
const scenarioResults: Record<string, unknown> = {};
const titleSource = join(repo, "remotion/src/compositions/Title.tsx");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function itemLength(item: Item): number {
  if (item.kind === "clip") return item.out - item.in + 1;
  if (item.kind === "blank") return item.length;
  return item.frames;
}

function locate(timeline: Timeline, uuid: string) {
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    let position = 0;
    for (const item of track.items) {
      if (item.kind === "clip" && item.id === uuid) return { uuid, track: track.id, position };
      position += itemLength(item);
    }
  }
  return null;
}

function attachLogging(page: Page, scenarioId: string): void {
  page.on("console", (message) =>
    browserLog.push(`${scenarioId} console.${message.type()}: ${message.text()}`),
  );
  page.on("pageerror", (error) => browserLog.push(`${scenarioId} pageerror: ${error.message}`));
  page.on("requestfailed", (request) =>
    browserLog.push(
      `${scenarioId} requestfailed: ${request.url()} ${request.failure()?.errorText}`,
    ),
  );
}

async function openRoute(
  page: Page,
  baseUrl: string,
  route: string,
  decoyRoute: string,
): Promise<void> {
  const url = new URL(baseUrl);
  url.searchParams.set("route", route);
  url.searchParams.set("decoyRoute", decoyRoute);
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof window.__veanLayers === "function", undefined, {
    timeout: 30_000,
  });
}

async function scenario(
  browser: Browser,
  baseUrl: string,
  id: string,
  route: string,
  decoyRoute: string,
  run: (page: Page) => Promise<unknown>,
): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  const page = await context.newPage();
  attachLogging(page, id);
  try {
    await openRoute(page, baseUrl, route, decoyRoute);
    scenarioResults[id] = await run(page);
    await page.screenshot({ path: join(artifactDir, `${id}.png`), fullPage: true });
    executed.push(id);
  } finally {
    await context.tracing.stop({ path: join(artifactDir, `${id}.zip`) });
    await context.close();
  }
}

async function runProdScenarios(
  browser: Browser,
  projectRoot: string,
  port: number,
  decoyRoute: string,
): Promise<BrowserMutationObservation> {
  const handle = await startPreviewServer({
    repo: projectRoot,
    timeline: join(projectRoot, "corpus/shotcut-single.mlt"),
    port,
    dev: false,
    veanRoot: repo,
    policyProfile: "test",
  });
  try {
    await scenario(
      browser,
      handle.url,
      "browser.live-overlay.prod",
      join(projectRoot, "corpus/demo/graphic-overlay.mlt"),
      decoyRoute,
      async (page) => {
        await page.waitForFunction(() => typeof window.__veanOverlay === "function");
        const overlay = await page.evaluate(() => window.__veanOverlay?.());
        const layers = await page.evaluate(() => window.__veanLayers?.(20));
        requireValue(
          overlay?.present === true && overlay.durationInFrames === 90,
          "live overlay did not mount",
        );
        requireValue(
          Array.isArray(layers) &&
            layers.some((layer) => layer.trackIndex === 0) &&
            !layers.some((layer) => layer.trackIndex === 1),
          "footage compositor did not exclude the graphic track",
        );
        requireValue(
          (await page.locator("body").innerText()).includes("video editor, agent native"),
          "LowerThird did not render",
        );
        return { overlay, layers };
      },
    );

    await scenario(
      browser,
      handle.url,
      "browser.live-comp.prod",
      join(projectRoot, "corpus/demo/title-overlay.mlt"),
      decoyRoute,
      async (page) => {
        await page.waitForFunction(() => typeof window.__veanOverlay === "function");
        const ids = await page.evaluate(() => window.__veanCompositions?.());
        const overlay = await page.evaluate(() => window.__veanOverlay?.());
        requireValue(
          ids?.includes("LowerThird") && ids.includes("Title"),
          "dynamic comp registry incomplete",
        );
        requireValue(overlay?.compositionId === "Title", "non-default comp did not resolve");
        return { ids, overlay };
      },
    );

    const current = join(projectRoot, "corpus/shotcut-single.mlt");
    const beforeMltHash = hashFile(current);
    const expectedInput = {
      uuid: "{7c1a0e2a-0001-4abc-9d00-000000000001}",
      toTrack: { trackId: "playlist0" },
      toPosition: 1,
      ripple: false,
      rippleAllTracks: false,
    };
    let actionRequest: BrowserMutationObservation["actionRequest"] | undefined;
    let actionResponse: BrowserMutationObservation["actionResponse"] | undefined;
    let saveResponse: BrowserMutationObservation["saveResponse"] | undefined;
    let applyOpRequestCount = 0;
    const dom: BrowserMutationObservation["dom"] = {};
    await scenario(
      browser,
      handle.url,
      "browser.editor.persisted-move",
      current,
      decoyRoute,
      async (page) => {
        const trackLabel = page
          .getByRole("group", { name: "Video track V1" })
          .getByText("V1", { exact: true });
        const timelineClips = page.getByRole("listbox", { name: "Timeline clips" });
        const findMedia = page.getByRole("textbox", { name: "Find media" });
        await Promise.all([trackLabel.waitFor(), timelineClips.waitFor(), findMedia.waitFor()]);
        const trackLabelBox = await trackLabel.boundingBox();
        const timelineBox = await timelineClips.boundingBox();
        requireValue(trackLabelBox && timelineBox, "timeline selection probe has no layout box");

        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        await page.mouse.move(
          trackLabelBox.x + trackLabelBox.width / 2,
          trackLabelBox.y + trackLabelBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
          timelineBox.x + Math.min(800, timelineBox.width - 20),
          timelineBox.y + 10,
          { steps: 20 },
        );
        const duringSelection = await page.evaluate(() => {
          const selection = window.getSelection();
          return {
            text: selection?.toString() ?? "",
            rangeCount: selection?.rangeCount ?? 0,
            collapsed: selection?.isCollapsed ?? true,
          };
        });
        await page.mouse.up();
        const afterSelection = await page.evaluate(() => {
          const selection = window.getSelection();
          return {
            text: selection?.toString() ?? "",
            rangeCount: selection?.rangeCount ?? 0,
            collapsed: selection?.isCollapsed ?? true,
          };
        });
        const bodySelection = await page.evaluate(() => {
          const style = getComputedStyle(document.body);
          return { userSelect: style.userSelect, webkitUserSelect: style.webkitUserSelect };
        });
        const chromeSelection = await trackLabel.evaluate((element) => {
          const style = getComputedStyle(element);
          return { userSelect: style.userSelect, webkitUserSelect: style.webkitUserSelect };
        });
        const inputSelection = await findMedia.evaluate((element) => {
          const style = getComputedStyle(element);
          return { userSelect: style.userSelect, webkitUserSelect: style.webkitUserSelect };
        });
        await findMedia.fill("selection probe");
        await findMedia.selectText();
        const inputRange = await findMedia.evaluate((element) => {
          if (!(element instanceof HTMLInputElement))
            throw new Error("media search is not an input");
          return {
            start: element.selectionStart,
            end: element.selectionEnd,
            valueLength: element.value.length,
          };
        });
        await findMedia.fill("");
        dom.selectionPolicy = {
          bodyUserSelect: bodySelection.userSelect,
          bodyWebkitUserSelect: bodySelection.webkitUserSelect,
          chromeUserSelect: chromeSelection.userSelect,
          chromeWebkitUserSelect: chromeSelection.webkitUserSelect,
          inputUserSelect: inputSelection.userSelect,
          inputWebkitUserSelect: inputSelection.webkitUserSelect,
          inputSelectionStart: inputRange.start,
          inputSelectionEnd: inputRange.end,
          inputValueLength: inputRange.valueLength,
          clipDragRequestCount: 0,
          clipDragText: "",
          clipDragRangeCount: 0,
          duringText: duringSelection.text,
          duringRangeCount: duringSelection.rangeCount,
          duringCollapsed: duringSelection.collapsed,
          afterText: afterSelection.text,
          afterRangeCount: afterSelection.rangeCount,
          afterCollapsed: afterSelection.collapsed,
        };

        page.on("request", (request) => {
          if (new URL(request.url()).pathname === "/api/apply-op") {
            applyOpRequestCount++;
            actionRequest ??= request.postDataJSON() as BrowserMutationObservation["actionRequest"];
          }
        });
        page.on("response", async (response) => {
          const path = new URL(response.url()).pathname;
          if (path === "/api/apply-op") actionResponse ??= await response.json();
          if (path === "/api/save") saveResponse = await response.json();
        });
        const outcome = await page.evaluate(
          async ({ args }) => await window.__veanEdit?.("move", args),
          { args: expectedInput },
        );
        requireValue((outcome as { ok?: boolean } | undefined)?.ok === true, "editor move failed");
        const save = page.getByRole("button", { name: /Save to disk/ });
        await save.waitFor();
        dom.dirtyBeforeSave = await save.isEnabled();
        dom.clipName =
          (await page
            .locator(`[data-clip-id="${expectedInput.uuid}"]`)
            .getAttribute("aria-label")) ?? undefined;
        await save.click();
        await page.waitForFunction(() => {
          const button = [...document.querySelectorAll("button")].find((candidate) =>
            candidate.getAttribute("aria-label")?.startsWith("Save to disk"),
          );
          return button instanceof HTMLButtonElement && button.disabled;
        });
        dom.dirtyAfterSave = await save.isEnabled();

        // Drive the actual clip gesture after persistence. It intentionally leaves
        // an unsaved session-only edit in the disposable fixture; the canonical
        // request/response above stay captured as the first action. This catches
        // both native text-selection leakage and React StrictMode replay of a
        // side-effectful state updater (one pointerup must submit exactly once).
        const snap = page.getByRole("button", { name: /Toggle snapping/ });
        if ((await snap.getAttribute("aria-pressed")) === "true") await snap.click();
        const draggedClip = page.locator(`[data-clip-id="${expectedInput.uuid}"]`);
        const draggedClipBox = await draggedClip.boundingBox();
        requireValue(draggedClipBox, "physical clip-drag probe has no layout box");
        await page.evaluate(() => window.getSelection()?.removeAllRanges());
        const requestsBeforeDrag = applyOpRequestCount;
        const dragResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/apply-op" &&
            response.request().method() === "POST",
        );
        await page.mouse.move(
          draggedClipBox.x + draggedClipBox.width / 2,
          draggedClipBox.y + draggedClipBox.height / 2,
        );
        await page.mouse.down();
        await page.mouse.move(
          draggedClipBox.x + draggedClipBox.width / 2 + 80,
          draggedClipBox.y + draggedClipBox.height / 2,
          { steps: 20 },
        );
        await page.mouse.up();
        await dragResponse;
        await page.waitForTimeout(100);
        const clipDragSelection = await page.evaluate(() => {
          const selection = window.getSelection();
          return { text: selection?.toString() ?? "", rangeCount: selection?.rangeCount ?? 0 };
        });
        if (!dom.selectionPolicy) throw new Error("selection policy evidence missing");
        dom.selectionPolicy.clipDragRequestCount = applyOpRequestCount - requestsBeforeDrag;
        dom.selectionPolicy.clipDragText = clipDragSelection.text;
        dom.selectionPolicy.clipDragRangeCount = clipDragSelection.rangeCount;
        return { outcome, dom };
      },
    );
    requireValue(
      actionRequest && actionResponse && saveResponse,
      "network action/save envelope missing",
    );
    const afterMltHash = hashFile(current);
    const parsedPlacement = locate(fromMlt(readFileSync(current, "utf8")), expectedInput.uuid);
    return {
      currentDocumentUri: current,
      expectedActionId: "move",
      expectedInput,
      actionRequest,
      actionResponse,
      saveResponse,
      beforeMltHash,
      afterMltHash,
      parsedPlacement,
      expectedPlacement: { track: "playlist0", position: 1, uuid: expectedInput.uuid },
      dom,
      cleanup: { developerCanaryUnchanged: true, sourceCorpusUnchanged: true },
    };
  } finally {
    handle.stop();
  }
}

async function runDevScenarios(
  browser: Browser,
  projectRoot: string,
  port: number,
  decoyRoute: string,
): Promise<void> {
  const handle = await startPreviewServer({
    repo: projectRoot,
    timeline: join(projectRoot, "corpus/demo/title-overlay.mlt"),
    port,
    dev: true,
    veanRoot: repo,
    policyProfile: "dev",
  });
  try {
    await scenario(
      browser,
      handle.url,
      "browser.live-multi.dev",
      join(projectRoot, "corpus/demo/multi-overlay.mlt"),
      decoyRoute,
      async (page) => {
        await page.waitForFunction(() => typeof window.__veanOverlay === "function");
        await page.evaluate(() => {
          for (let frame = 0; frame < 60; frame++)
            window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight" }));
        });
        await page.waitForFunction(() => window.__veanOverlay?.().masterFrame === 60);
        const overlay = await page.evaluate(() => window.__veanOverlay?.());
        requireValue(
          overlay?.compositionId === "LowerThird" && overlay.playerFrame === 15,
          "playhead-aware composition did not switch/offset",
        );
        return overlay;
      },
    );

    await scenario(
      browser,
      handle.url,
      "browser.live-error.dev",
      join(projectRoot, "corpus/demo/boom-overlay.mlt"),
      decoyRoute,
      async (page) => {
        await page.waitForFunction(
          () => window.__veanOverlayError?.compositionId === "BoomProbe",
          undefined,
          { timeout: 15_000 },
        );
        const error = await page.evaluate(() => window.__veanOverlayError);
        const layers = await page.evaluate(() => window.__veanLayers?.(20));
        requireValue(
          layers?.some((layer) => layer.trackIndex === 0),
          "throwing comp killed editor",
        );
        requireValue(
          !(await page.locator('[data-testid="overlay-player"]').innerText()).includes("⚠"),
          "throwing comp exposed Remotion glyph",
        );
        return { error, layers };
      },
    );

    const original = readFileSync(titleSource, "utf8");
    const baselineText = "{kicker}";
    const probe = `hmr probe ${randomUUID()}`;
    requireValue(original.includes(baselineText), "HMR baseline text missing");
    try {
      await scenario(
        browser,
        handle.url,
        "browser.live-hmr.dev",
        join(projectRoot, "corpus/demo/title-overlay.mlt"),
        decoyRoute,
        async (page) => {
          await page.waitForFunction(() => typeof window.__veanOverlay === "function");
          await page.evaluate(() => {
            for (let frame = 0; frame < 20; frame++)
              window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight" }));
          });
          await page.waitForFunction(() => window.__veanOverlay?.().masterFrame === 20);
          writeFileSync(titleSource, original.replace(baselineText, `{kicker} ${probe}`));
          await page.waitForFunction((text) => document.body.textContent?.includes(text), probe, {
            timeout: 20_000,
          });
          const overlay = await page.evaluate(() => window.__veanOverlay?.());
          requireValue(
            overlay?.masterFrame === 20 && overlay.playerFrame === 20,
            "HMR reset or failed to restore the master/player playhead",
          );
          return { probe, overlay };
        },
      );
    } finally {
      writeFileSync(titleSource, original);
    }
  } finally {
    handle.stop();
  }
}

const sourceSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
  .stdout.toString()
  .trim();
const canary = join(repo, ".vean/harness/developer-state-canary");
mkdirSync(dirname(canary), { recursive: true });
if (!Bun.file(canary).size) writeFileSync(canary, "poisoned-developer-state\n", { mode: 0o600 });
const canaryHash = hashFile(canary);
const corpusHash = sha256(join(repo, "corpus/shotcut-single.mlt"));
const titleHash = sha256(titleSource);
const fixture = await createFixture({ sourceSha, developerCanary: canary });
cpSync(join(repo, "corpus"), join(fixture.descriptor.projectRoot, "corpus"), { recursive: true });
const decoyRoute = join(fixture.descriptor.projectRoot, "corpus/decoy.mlt");
copyFileSync(join(fixture.descriptor.projectRoot, "corpus/shotcut-single.mlt"), decoyRoute);
const browser = await chromium.launch({ headless: true });
let observation: BrowserMutationObservation | undefined;
let cleanupFindings: unknown[] = [];
try {
  observation = await runProdScenarios(
    browser,
    fixture.descriptor.projectRoot,
    fixture.descriptor.previewPort,
    decoyRoute,
  );
  await runDevScenarios(
    browser,
    fixture.descriptor.projectRoot,
    fixture.descriptor.vitePort,
    decoyRoute,
  );
  observation.cleanup = {
    developerCanaryUnchanged: hashFile(canary) === canaryHash,
    sourceCorpusUnchanged: sha256(join(repo, "corpus/shotcut-single.mlt")) === corpusHash,
  };
  requireValue(sha256(titleSource) === titleHash, "HMR scenario did not restore Title.tsx");
  const truth = evaluateBrowserMutation(observation);
  if (!truth.ok) throw new Error(`browser domain truth failed: ${JSON.stringify(truth.issues)}`);
  const required = scenarioLedger.scenarios.map((entry) => entry.id).sort();
  const actual = [...executed].sort();
  requireValue(required.join("\0") === actual.join("\0"), `scenario mismatch: ${actual.join(",")}`);
  writeFileSync(join(artifactDir, "browser.log"), `${browserLog.join("\n")}\n`);
  writeFileSync(
    join(artifactDir, "mutation-truth.json"),
    `${JSON.stringify({ observation, truth }, null, 2)}\n`,
  );
  writeFileSync(
    join(artifactDir, "scenario-results.json"),
    `${JSON.stringify(scenarioResults, null, 2)}\n`,
  );
} finally {
  await browser.close();
  const cleanup = await fixture.close();
  cleanupFindings = cleanup.detected;
}

console.log(
  JSON.stringify({
    status: "verified",
    browser: "playwright/chromium/headless",
    host: "127.0.0.1",
    strictPorts: [fixture.descriptor.previewPort, fixture.descriptor.vitePort],
    executedScenarioIds: executed,
    observation,
    cleanupFindings,
  }),
);

declare global {
  interface Window {
    __veanLayers?: (frame: number) => Array<{ trackIndex: number }>;
    __veanOverlay?: () => {
      present: boolean;
      compositionId: string;
      durationInFrames: number;
      playerFrame: number | null;
      masterFrame: number;
    };
    __veanCompositions?: () => string[];
    __veanOverlayError?: { compositionId: string; message: string };
    __veanEdit?: (op: string, args: Record<string, unknown>) => Promise<unknown>;
  }
}
