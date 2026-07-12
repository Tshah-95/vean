import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { describe, it } from "mocha";
import { bundleIdentifier, type processIdentity } from "../tauri/runtime";
import {
  GO_TO_FOLDER_KEYSTROKE,
  NATIVE_ELEMENT_TYPE,
  NATIVE_PANEL_ROOT_TYPES,
  OPEN_PANEL_IDENTIFIER,
  PreviewSidecarWaitError,
  appProcess,
  enabledTextFieldPredicate,
  nativeInventory,
  nativeInventoryFromSource,
  nativePredicate,
  readMacosContext,
  semanticElement,
  waitForPreviewSidecar,
  writeMacosResult,
} from "./runtime";

const MENU_BAR_ITEM = NATIVE_ELEMENT_TYPE.MenuBarItem;
const MENU_ITEM = NATIVE_ELEMENT_TYPE.MenuItem;
const BUTTON = NATIVE_ELEMENT_TYPE.Button;

async function goToFolderLocationField() {
  const matchedRoots: Array<{
    rootType: number;
    rootIndex: number;
    field: WebdriverIO.Element;
  }> = [];
  const rootInventory: Array<{
    rootType: number;
    roots: number;
    displayedRoots: number;
    rootsObserved: Array<{
      rootIndex: number;
      identifier: string;
      title: string;
      label: string;
      enabledTextFields: number;
      excludedAsOpenPanel: boolean;
    }>;
  }> = [];

  for (const rootType of NATIVE_PANEL_ROOT_TYPES) {
    const roots = await browser.$$(nativePredicate(rootType));
    const inventory = {
      rootType,
      roots: await roots.length,
      displayedRoots: 0,
      rootsObserved: [] as Array<{
        rootIndex: number;
        identifier: string;
        title: string;
        label: string;
        enabledTextFields: number;
        excludedAsOpenPanel: boolean;
      }>,
    };
    let rootIndex = 0;
    for await (const root of roots) {
      if (await root.isDisplayed()) {
        inventory.displayedRoots += 1;
        const identifier = (await root.getAttribute("identifier")) ?? "";
        const title = (await root.getAttribute("title")) ?? "";
        const label = (await root.getAttribute("label")) ?? "";
        const fields = await root.$$(enabledTextFieldPredicate());
        const fieldCount = await fields.length;
        const excludedAsOpenPanel = identifier === OPEN_PANEL_IDENTIFIER;
        inventory.rootsObserved.push({
          rootIndex,
          identifier,
          title,
          label,
          enabledTextFields: fieldCount,
          excludedAsOpenPanel,
        });
        if (!excludedAsOpenPanel && fieldCount === 1) {
          const field = await fields[0]?.getElement();
          if (field) matchedRoots.push({ rootType, rootIndex, field });
        }
      }
      rootIndex += 1;
    }
    rootInventory.push(inventory);
  }

  return { matchedRoots, rootInventory };
}

async function writeGoToFolderDiagnostic(
  context: ReturnType<typeof readMacosContext>,
  rootInventory: unknown,
): Promise<void> {
  const source = await browser.getPageSource();
  const native = nativeInventoryFromSource(source);
  writeFileSync(join(context.artifactDir, "go-to-folder-page-source.xml"), source, {
    mode: 0o600,
  });
  writeFileSync(
    join(context.artifactDir, "go-to-folder-inventory.json"),
    `${JSON.stringify(
      {
        native: {
          windows: native.windows,
          dialogs: native.dialogs,
          sheets: native.sheets,
        },
        panelRoots: rootInventory,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

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

    const openPanel = await $(
      nativePredicate(NATIVE_ELEMENT_TYPE.Sheet, `identifier == '${OPEN_PANEL_IDENTIFIER}'`),
    );
    await openPanel.waitForExist({ timeout: 15_000 });
    await expect(openPanel).toBeDisplayed();
    await browser.execute("macos: keys", { keys: [GO_TO_FOLDER_KEYSTROKE] });
    let location: WebdriverIO.Element | undefined;
    let lastRootInventory: unknown = [];
    await browser
      .waitUntil(
        async () => {
          const lookup = await goToFolderLocationField();
          lastRootInventory = lookup.rootInventory;
          if (lookup.matchedRoots.length !== 1) return false;
          location = lookup.matchedRoots[0]?.field;
          return location !== undefined;
        },
        {
          timeout: 15_000,
          timeoutMsg:
            "Go-to-folder did not expose exactly one distinct native sheet/dialog with one enabled semantic text field",
        },
      )
      .catch(async (error) => {
        await writeGoToFolderDiagnostic(context, lastRootInventory);
        throw error;
      });
    if (!location) {
      await writeGoToFolderDiagnostic(context, lastRootInventory);
      throw new Error("Go-to-folder semantic text field disappeared");
    }
    const locationFocused = await location.getAttribute("focused");
    if (locationFocused !== "true") {
      await writeGoToFolderDiagnostic(context, lastRootInventory);
      throw new Error(
        `Go-to-folder semantic text field was selected but lacked keyboard focus: ${locationFocused}`,
      );
    }
    await location.setValue(context.projectRoot);
    await browser.keys(["Enter"]);
    const open = await semanticElement(BUTTON, "Open", 15_000);
    await open.click();
    await open.waitForExist({ reverse: true, timeout: 30_000 });

    const app = appProcess(context);
    const appBundleId = bundleIdentifier(app.pid);
    let sidecar: ReturnType<typeof processIdentity>;
    try {
      sidecar = await waitForPreviewSidecar(app.pid, context.projectRoot);
    } catch (error) {
      const diagnostic =
        error instanceof PreviewSidecarWaitError
          ? {
              reasonCode: error.reasonCode,
              observation: error.observation,
            }
          : { reasonCode: "E_H06_PREVIEW_SIDECAR_OBSERVATION", error: String(error) };
      writeFileSync(
        join(context.artifactDir, "preview-sidecar-timeout.json"),
        `${JSON.stringify(diagnostic, null, 2)}\n`,
        { mode: 0o600 },
      );
      throw error;
    }
    scenarios.push({
      id: "macos-open-project-real-folder",
      selectedFolder: context.projectRoot,
      sidecar,
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
