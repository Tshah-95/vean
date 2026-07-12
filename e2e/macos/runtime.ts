import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { $, browser } from "@wdio/globals";
import { processIdentity } from "../tauri/runtime";

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
  elementType: string,
  accessibleName: string,
  timeout = 15_000,
) {
  const escaped = accessibleName.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  const element = await $(
    `-ios predicate string:elementType == ${elementType} AND (title == '${escaped}' OR label == '${escaped}')`,
  );
  await element.waitForExist({ timeout });
  return element;
}

export async function nativeInventory(): Promise<{
  source: string;
  windows: number;
  dialogs: number;
  sheets: number;
}> {
  const source = await browser.getPageSource();
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
