import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { $, browser } from "@wdio/globals";
import { childPids, processIdentity } from "../tauri/runtime";

export type MacosRunContext = {
  runId: string;
  sourceSha: string;
  repo: string;
  projectRoot: string;
  artifactDir: string;
  processLedger: string;
  appiumPort: number;
  systemPort: number;
  bundlePath: string;
  binaryPath: string;
  binaryHash: string;
  bundleId: string;
  expectedMenuLabel: string;
  residualDialogControl: boolean;
  appEnvironment: Record<string, string>;
};

export function readMacosContext(): MacosRunContext {
  const path = process.env.VEAN_H06_CONTEXT;
  if (!path) throw new Error("VEAN_H06_CONTEXT is required");
  return JSON.parse(readFileSync(path, "utf8")) as MacosRunContext;
}

export function appProcess(context: MacosRunContext): ReturnType<typeof processIdentity> {
  const output = execFileSync("pgrep", ["-f", `^${context.binaryPath.replaceAll("/", "\\/")}`], {
    encoding: "utf8",
  });
  const candidates = output
    .trim()
    .split("\n")
    .map(Number)
    .filter(Number.isInteger)
    .map(processIdentity)
    .filter((candidate) => realpathSync(candidate.executable) === realpathSync(context.binaryPath));
  if (candidates.length !== 1) {
    throw new Error(`expected exact app process, got ${JSON.stringify(candidates)}`);
  }
  return candidates[0] as ReturnType<typeof processIdentity>;
}

export type PreviewSidecarObservation = {
  parentPid: number;
  projectRoot: string;
  childPids: number[];
  observed: Array<ReturnType<typeof processIdentity>>;
  observationErrors: Array<{ pid: number; error: string }>;
  matching: Array<ReturnType<typeof processIdentity>>;
};

export class PreviewSidecarWaitError extends Error {
  readonly reasonCode: "E_H06_PREVIEW_SIDECAR_TIMEOUT" | "E_H06_PREVIEW_SIDECAR_AMBIGUOUS";
  readonly observation: PreviewSidecarObservation;

  constructor(
    reasonCode: PreviewSidecarWaitError["reasonCode"],
    observation: PreviewSidecarObservation,
  ) {
    super(`${reasonCode}: ${JSON.stringify(observation)}`);
    this.name = "PreviewSidecarWaitError";
    this.reasonCode = reasonCode;
    this.observation = observation;
  }
}

export type PreviewSidecarPollDependencies = {
  listChildPids: (parentPid: number) => number[];
  observeProcess: typeof processIdentity;
  now: () => number;
  sleep: (durationMs: number) => Promise<void>;
};

const previewSidecarPollDefaults: PreviewSidecarPollDependencies = {
  listChildPids: childPids,
  observeProcess: processIdentity,
  now: Date.now,
  sleep: (durationMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, durationMs)),
};

export function observePreviewSidecars(
  parentPid: number,
  projectRoot: string,
  dependencies: Pick<
    PreviewSidecarPollDependencies,
    "listChildPids" | "observeProcess"
  > = previewSidecarPollDefaults,
): PreviewSidecarObservation {
  const pids = dependencies.listChildPids(parentPid);
  const observed: PreviewSidecarObservation["observed"] = [];
  const observationErrors: PreviewSidecarObservation["observationErrors"] = [];
  for (const pid of pids) {
    try {
      observed.push(dependencies.observeProcess(pid));
    } catch (error) {
      observationErrors.push({ pid, error: String(error) });
    }
  }
  const matching = observed.filter(
    (candidate) =>
      candidate.parentPid === parentPid &&
      candidate.command.includes("src/cli.ts preview") &&
      candidate.command.includes(`--repo ${projectRoot}`),
  );
  return { parentPid, projectRoot, childPids: pids, observed, observationErrors, matching };
}

export async function waitForPreviewSidecar(
  parentPid: number,
  projectRoot: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    dependencies?: Partial<PreviewSidecarPollDependencies>;
  } = {},
): Promise<ReturnType<typeof processIdentity>> {
  const dependencies = { ...previewSidecarPollDefaults, ...options.dependencies };
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 100;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("preview sidecar timeoutMs must be positive and finite");
  }
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error("preview sidecar intervalMs must be positive and finite");
  }
  const deadline = dependencies.now() + timeoutMs;
  let observation = observePreviewSidecars(parentPid, projectRoot, dependencies);
  while (true) {
    if (observation.matching.length > 1) {
      throw new PreviewSidecarWaitError("E_H06_PREVIEW_SIDECAR_AMBIGUOUS", observation);
    }
    const match = observation.matching[0];
    if (match) return match;
    if (dependencies.now() >= deadline) {
      throw new PreviewSidecarWaitError("E_H06_PREVIEW_SIDECAR_TIMEOUT", observation);
    }
    await dependencies.sleep(intervalMs);
    observation = observePreviewSidecars(parentPid, projectRoot, dependencies);
  }
}

export function writeMacosResult(context: MacosRunContext, result: unknown): void {
  writeFileSync(
    resolve(context.artifactDir, "macos-session.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    {
      mode: 0o600,
    },
  );
}

export async function semanticElement(
  elementType: number,
  accessibleName: string,
  timeout = 15_000,
) {
  const escaped = accessibleName.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  const element = await $(
    nativePredicate(elementType, `title == '${escaped}' OR label == '${escaped}'`),
  );
  await element.waitForExist({ timeout });
  return element;
}

export const NATIVE_ELEMENT_TYPE = {
  Window: 4,
  Sheet: 5,
  Dialog: 8,
  Button: 9,
  SearchField: 45,
  TextField: 49,
  MenuItem: 54,
  MenuBarItem: 56,
} as const;

export function nativePredicate(elementType: number, condition?: string): string {
  if (!Number.isInteger(elementType)) throw new Error("native element type must be an integer");
  if (
    condition &&
    /(?:^|[\s(])focused\s*(?:==|!=|<|>|BEGINSWITH|ENDSWITH|CONTAINS)/i.test(condition)
  ) {
    throw new Error(
      "Mac2 does not expose 'focused' as an XCTest predicate key; locate semantically, then call getAttribute('focused') on the selected element",
    );
  }
  return `-ios predicate string:elementType == ${elementType}${condition ? ` AND (${condition})` : ""}`;
}

export const NATIVE_PANEL_ROOT_TYPES = [
  NATIVE_ELEMENT_TYPE.Sheet,
  NATIVE_ELEMENT_TYPE.Dialog,
] as const;

export function enabledTextFieldPredicate(): string {
  return nativePredicate(NATIVE_ELEMENT_TYPE.TextField, "enabled == true");
}

export const OPEN_PANEL_IDENTIFIER = "open-panel";

export const GO_TO_FOLDER_KEYSTROKE = {
  key: "g",
  // XCUIKeyModifierShift (1 << 1) | XCUIKeyModifierCommand (1 << 4)
  modifierFlags: (1 << 1) | (1 << 4),
} as const;

export async function nativeInventory(): Promise<{
  source: string;
  windows: number;
  dialogs: number;
  sheets: number;
}> {
  const source = await browser.getPageSource();
  return nativeInventoryFromSource(source);
}

export function nativeInventoryFromSource(source: string): {
  source: string;
  windows: number;
  dialogs: number;
  sheets: number;
} {
  return {
    source,
    windows: countNativeElements(source, "XCUIElementTypeWindow"),
    dialogs: countNativeElements(source, "XCUIElementTypeDialog"),
    sheets: countNativeElements(source, "XCUIElementTypeSheet"),
  };
}

export type NativeElementName =
  | "XCUIElementTypeWindow"
  | "XCUIElementTypeDialog"
  | "XCUIElementTypeSheet";

export function countNativeElements(source: string, name: NativeElementName): number {
  return source.match(new RegExp(`<${name}(?:\\s|>)`, "g"))?.length ?? 0;
}
