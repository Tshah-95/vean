import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { bundleIdentifier, childPids, processIdentity } from "../tauri/runtime";
import {
  NATIVE_ELEMENT_TYPE,
  appProcess,
  nativeInventory,
  nativePredicate,
  readMacosContext,
  semanticElement,
  writeMacosResult,
} from "./runtime";

const MENU_BAR_ITEM = NATIVE_ELEMENT_TYPE.MenuBarItem;
const MENU_ITEM = NATIVE_ELEMENT_TYPE.MenuItem;
const BUTTON = NATIVE_ELEMENT_TYPE.Button;

describe("Vean AppKit-owned shell", () => {
  it("drives native menus, file panels, focus, window close, and quit semantically", async () => {
    const context = readMacosContext();
    const scenarios: Array<Record<string, unknown>> = [];

    const initial = await nativeInventory();
    if (initial.windows !== 1)
      throw new Error(`expected one native window, got ${initial.windows}`);
    const window = await $(
      nativePredicate(NATIVE_ELEMENT_TYPE.Window, "title == 'vean' OR label == 'vean'"),
    );
    await window.waitForExist();
    await expect(window).toBeDisplayed();
    scenarios.push({
      id: "macos-shell-role-name-focus",
      role: await window.getTagName(),
      title: await window.getAttribute("title"),
      label: await window.getAttribute("label"),
      focused: await window.getAttribute("focused"),
    });

    const file = await semanticElement(MENU_BAR_ITEM, "File");
    await file.click();
    let openProject = await $(
      nativePredicate(
        MENU_ITEM,
        `title == '${context.expectedMenuLabel}' OR label == '${context.expectedMenuLabel}'`,
      ),
    );
    if (!(await openProject.isExisting())) {
      throw new Error(
        `SENSITIVITY_NATIVE_MACOS_SHELL: canonical accessibility label '${context.expectedMenuLabel}' was not found`,
      );
    }
    await openProject.click();
    const cancel = await semanticElement(BUTTON, "Cancel", 30_000);
    await cancel.click();
    await cancel.waitForExist({ reverse: true, timeout: 15_000 });
    scenarios.push({
      id: "macos-open-project-cancel-focus-restore",
      focusRestored: (await window.getAttribute("focused")) === "true",
      residual: await nativeInventory(),
    });

    await file.click();
    openProject = await semanticElement(MENU_ITEM, context.expectedMenuLabel);
    await openProject.click();
    if (context.residualDialogControl) {
      const residual = await nativeInventory();
      writeMacosResult(context, { ok: false, residualDialogControl: true, scenarios, residual });
      throw new Error(
        "SENSITIVITY_NATIVE_MACOS_RESIDUAL_DIALOG: file panel intentionally unresolved",
      );
    }

    await browser.keys(["Shift", "Command", "g"]);
    await browser.waitUntil(
      async () => {
        const fields = browser.$$(nativePredicate(NATIVE_ELEMENT_TYPE.TextField));
        return (await fields.length) === 1;
      },
      {
        timeout: 15_000,
        timeoutMsg: "Go-to-folder sheet did not expose exactly one semantic text field",
      },
    );
    const fields = browser.$$(nativePredicate(NATIVE_ELEMENT_TYPE.TextField));
    const location = await fields[0];
    if (!location) throw new Error("Go-to-folder text field disappeared");
    await location.setValue(context.projectRoot);
    await browser.keys(["Enter"]);
    const open = await semanticElement(BUTTON, "Open", 15_000);
    await open.click();
    await open.waitForExist({ reverse: true, timeout: 30_000 });

    const app = appProcess(context);
    const appBundleId = bundleIdentifier(app.pid);
    const sidecars = childPids(app.pid)
      .map(processIdentity)
      .filter(
        (candidate) =>
          candidate.command.includes("src/cli.ts preview") &&
          candidate.command.includes(`--repo ${context.projectRoot}`),
      );
    if (sidecars.length !== 1) {
      throw new Error(
        `selected project did not own exactly one sidecar: ${JSON.stringify(sidecars)}`,
      );
    }
    scenarios.push({
      id: "macos-open-project-real-folder",
      selectedFolder: context.projectRoot,
      sidecar: sidecars[0],
      focusRestored: (await window.getAttribute("focused")) === "true",
    });

    const screenshotPath = join(context.artifactDir, "native-shell.png");
    await browser.saveScreenshot(screenshotPath);

    const closeButton = await window.$(
      nativePredicate(NATIVE_ELEMENT_TYPE.Button, "identifier == '_XCUI:CloseWindow'"),
    );
    await closeButton.waitForExist();
    const closeName =
      (await closeButton.getAttribute("identifier")) ||
      (await closeButton.getAttribute("title")) ||
      (await closeButton.getAttribute("label"));
    await closeButton.click();
    await browser.waitUntil(async () => (await nativeInventory()).windows === 0, {
      timeout: 15_000,
      timeoutMsg: "native close button left the Vean window open",
    });
    const afterClose = await nativeInventory();
    await browser.execute("macos: terminateApp", [
      { bundleId: context.bundleId, path: context.bundlePath },
    ]);
    await browser.waitUntil(
      async () => {
        try {
          process.kill(app.pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      { timeout: 15_000, timeoutMsg: "automation cleanup did not terminate the closed app" },
    );
    scenarios.push({
      id: "macos-window-close-reopen-classification",
      closeAccessibleName: closeName,
      windowsAfterClose: afterClose.windows,
      reopenSupportedByProduct: false,
      reason: "the current Tauri shell does not implement macOS reopen activation",
      automationTerminateAfterClose: true,
      automationRelaunchForQuit: true,
    });

    await browser.execute("macos: launchApp", [
      {
        bundleId: context.bundleId,
        path: context.bundlePath,
        environment: context.appEnvironment,
      },
    ]);
    await browser.waitUntil(async () => (await nativeInventory()).windows === 1, {
      timeout: 30_000,
      timeoutMsg: "automation-only relaunch for the independent Quit scenario failed",
    });
    const quitApp = appProcess(context);
    const quitBundleId = bundleIdentifier(quitApp.pid);
    const appMenu = await semanticElement(MENU_BAR_ITEM, "vean");
    await appMenu.click();
    const quit = await $(
      nativePredicate(MENU_ITEM, "title BEGINSWITH 'Quit' OR label BEGINSWITH 'Quit'"),
    );
    await quit.waitForExist();
    const quitName = (await quit.getAttribute("title")) || (await quit.getAttribute("label"));
    await quit.click();
    const deadline = Date.now() + 15_000;
    let aliveAfterQuit = true;
    while (Date.now() < deadline) {
      try {
        process.kill(quitApp.pid, 0);
      } catch {
        aliveAfterQuit = false;
        break;
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    scenarios.push({ id: "macos-native-quit", accessibleName: quitName, aliveAfterQuit });

    writeMacosResult(context, {
      ok: true,
      fixtureRunId: context.runId,
      sourceSha: context.sourceSha,
      binary: {
        path: context.binaryPath,
        hash: context.binaryHash,
        bundlePath: context.bundlePath,
      },
      process: app,
      bundleId: appBundleId,
      quitProcess: {
        ...quitApp,
        bundleId: quitBundleId,
        aliveAfterQuit,
      },
      session: { id: browser.sessionId, capabilities: browser.capabilities },
      scenarios,
      screenshotPath,
    });
  });
});
