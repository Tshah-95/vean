import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import {
  bundleIdentifier,
  listenerPid,
  processIdentity,
  readContext,
  recordNativeProcess,
  writeNativeResult,
} from "./runtime";

describe("Vean's final localhost WKWebView", () => {
  it("persists one real split through the existing editor and Save path", async () => {
    const context = readContext();
    const finalOrigin = `http://127.0.0.1:${context.previewPort}`;
    await browser.waitUntil(async () => (await browser.getUrl()).startsWith(finalOrigin), {
      timeout: 90_000,
      interval: 250,
      timeoutMsg: `main WKWebView never reached ${finalOrigin}`,
    });

    const clip = await $('[data-clip-id="{7c1a0e2a-0001-4abc-9d00-000000000001}"]');
    await clip.waitForDisplayed({ timeout: 30_000 });
    await clip.click();
    await expect(clip).toBeDisplayed();

    const actionEnvelope = await browser.executeAsync(
      (uuid: string, done: (value: unknown) => void) => {
        const edit = (
          window as unknown as {
            __veanEdit?: (op: string, args: Record<string, unknown>) => Promise<unknown>;
          }
        ).__veanEdit;
        if (!edit) {
          done({ ok: false, error: "window.__veanEdit is unavailable" });
          return;
        }
        edit("split", { uuid, frame: 40 }).then(
          (value) => done({ ok: true, value }),
          (error) => done({ ok: false, error: String(error) }),
        );
      },
      "{7c1a0e2a-0001-4abc-9d00-000000000001}",
    );
    if (!(actionEnvelope as { ok?: boolean }).ok) {
      throw new Error(`split action failed: ${JSON.stringify(actionEnvelope)}`);
    }

    await browser.execute(() => {
      const original = window.fetch.bind(window);
      let resolveSave: (value: unknown) => void = () => {};
      const saveResult = new Promise<unknown>((resolve) => {
        resolveSave = resolve;
      });
      (window as unknown as { __h05SaveResult?: Promise<unknown> }).__h05SaveResult = saveResult;
      window.fetch = async (...args) => {
        const response = await original(...args);
        const target =
          typeof args[0] === "string"
            ? args[0]
            : args[0] instanceof URL
              ? args[0].href
              : args[0].url;
        if (target.includes("/api/save")) resolveSave(await response.clone().json());
        return response;
      };
    });
    const save = await $('button[aria-label="Save"]');
    await save.waitForEnabled({ timeout: 10_000 });
    await save.click();
    await browser.waitUntil(async () => (await save.getText()).includes("Saved"), {
      timeout: 10_000,
      interval: 100,
      timeoutMsg: "Save did not report persisted state",
    });
    const saveEnvelope = await browser.executeAsync((done: (value: unknown) => void) => {
      const result = (window as unknown as { __h05SaveResult?: Promise<unknown> }).__h05SaveResult;
      if (!result) done({ ok: false, error: "save result probe missing" });
      else result.then(done, (error) => done({ ok: false, error: String(error) }));
    });
    if ((saveEnvelope as { path?: string }).path !== context.timelinePath) {
      throw new Error(`Save touched the wrong URI: ${JSON.stringify(saveEnvelope)}`);
    }

    mkdirSync(context.artifactDir, { recursive: true });
    const screenshotPath = join(context.artifactDir, "final-wkwebview.png");
    await browser.saveScreenshot(screenshotPath);

    const appPid = listenerPid(context.webdriverPort);
    const sidecarPid = listenerPid(context.previewPort);
    const app = processIdentity(appPid);
    const sidecar = processIdentity(sidecarPid);
    const appRecord = recordNativeProcess(context, appPid, `vean-h05-${context.runId}`);
    const sidecarRecord = recordNativeProcess(
      context,
      sidecarPid,
      `vean-sidecar-${appPid}-${context.previewPort}`,
    );
    const url = await browser.getUrl();
    const userAgent = await browser.execute(() => navigator.userAgent);
    const windowHandles = await browser.getWindowHandles();
    const result = {
      ok: true,
      provider: "embedded-safe",
      fixtureRunId: context.runId,
      sourceSha: context.sourceSha,
      binary: {
        bundlePath: context.bundlePath,
        expectedPath: context.binaryPath,
        expectedHash: context.binaryHash,
        observedPath: app.executable,
        observedHash: app.executableHash,
      },
      process: {
        ...app,
        processGroup: appRecord.pgid,
        observedBundleId: bundleIdentifier(appPid),
        expectedBundleId: context.bundleId,
      },
      sidecar: { ...sidecar, ledgerProcessGroup: sidecarRecord.pgid },
      window: { label: "main", handles: windowHandles, finalUrl: url },
      runtime: {
        userAgent,
        webkitVersion: String(userAgent).match(/AppleWebKit\/([^ ]+)/)?.[1] ?? null,
      },
      driver: {
        port: context.webdriverPort,
        listenerPid: appPid,
        sessionId: browser.sessionId,
        capabilities: browser.capabilities,
        node: process.version,
      },
      actionEnvelope,
      action: {
        id: "split",
        input: { uuid: "{7c1a0e2a-0001-4abc-9d00-000000000001}", frame: 40 },
      },
      saveEnvelope,
      persistedTimeline: context.timelinePath,
      screenshotPath,
    };
    if (url !== context.expectedFinalUrl) {
      throw new Error(`unexpected final WKWebView URL: ${url}`);
    }
    if (appPid === sidecarPid || windowHandles.length !== 1) {
      throw new Error("native process/window identity predicate failed");
    }
    writeNativeResult(context, result);
  });
});
