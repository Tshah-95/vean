#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..");
const requiredNode = "v24.15.0";

function command(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(args, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

const pinnedNode = command(["mise", "exec", "node@24.15.0", "--", "node", "-v"]);
const systemNode = command(["node", "-v"]);
const serviceImport = command([
  "mise",
  "exec",
  "node@24.15.0",
  "--",
  "node",
  "--input-type=module",
  "-e",
  "import('@wdio/tauri-service').then(()=>import('@wdio/native-utils')).then(m=>{if(typeof m.installMockSyncOverride!=='function')process.exit(2)})",
]);
const packageJson = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
  resolutions?: Record<string, string>;
};
const checks = {
  miseAvailable: command(["mise", "--version"]).exitCode === 0,
  pinnedNodeExact: pinnedNode.exitCode === 0 && pinnedNode.stdout === requiredNode,
  systemNodeRecordedAsDiagnosticOnly: systemNode.exitCode === 0 && systemNode.stdout.length > 0,
  tauriServiceExact: packageJson.devDependencies?.["@wdio/tauri-service"] === "1.2.0",
  webdriverioExact: packageJson.devDependencies?.webdriverio === "9.29.1",
  nativeUtilsExact: packageJson.devDependencies?.["@wdio/native-utils"] === "2.5.0",
  nativeUtilsOverride:
    packageJson.overrides?.["@wdio/native-utils"] === "2.5.0" &&
    packageJson.resolutions?.["@wdio/native-utils"] === "2.5.0",
  serviceImportsOnPinnedRuntime: serviceImport.exitCode === 0,
};
const result = {
  ok: Object.values(checks).every(Boolean),
  checks,
  runtime: {
    requiredNode,
    selectedNode: pinnedNode.stdout,
    systemNode: systemNode.stdout,
    systemNodePurpose: "diagnostic only; the WDIO lane never uses the system runtime",
  },
  serviceImportStderr: serviceImport.stderr,
};
console.log(JSON.stringify(result));
if (!result.ok) process.exit(1);
