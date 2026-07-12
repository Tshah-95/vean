#!/usr/bin/env bun
import { listenerPid, readContext, recordNativeProcess } from "../../e2e/tauri/runtime";

const context = readContext();
const deadline = Date.now() + 120_000;
let appPid: number | null = null;
let sidecarPid: number | null = null;

while (Date.now() < deadline && (!appPid || !sidecarPid)) {
  if (!appPid) {
    try {
      appPid = listenerPid(context.webdriverPort);
      recordNativeProcess(context, appPid, `vean-h05-${context.runId}`);
    } catch {}
  }
  if (!sidecarPid) {
    try {
      sidecarPid = listenerPid(context.previewPort);
      recordNativeProcess(
        context,
        sidecarPid,
        `vean-sidecar-${appPid ?? "unknown"}-${context.previewPort}`,
      );
    } catch {}
  }
  if (!appPid || !sidecarPid) await Bun.sleep(50);
}

if (!appPid || !sidecarPid) {
  throw new Error(
    `failed to ledger native listeners: app=${String(appPid)} sidecar=${String(sidecarPid)}`,
  );
}
console.log(JSON.stringify({ appPid, sidecarPid }));
