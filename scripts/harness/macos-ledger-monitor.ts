#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { appProcess, readMacosContext } from "../../e2e/macos/runtime";
import { childPids, processIdentity } from "../../e2e/tauri/runtime";
import { readLedger, recordProcess } from "./process-ledger";

const context = readMacosContext();
const stopPath = process.env.VEAN_H06_MONITOR_STOP;
if (!stopPath) throw new Error("VEAN_H06_MONITOR_STOP is required");
const recorded = new Set(
  readLedger(context.processLedger).processes.map(
    (process) => `${process.pid}:${process.startedAt}`,
  ),
);
const observed: Array<{ pid: number; parentPid: number; executable: string; startedAt: string }> =
  [];

function recordTree(pid: number): void {
  let identity: ReturnType<typeof processIdentity>;
  try {
    identity = processIdentity(pid);
  } catch {
    return;
  }
  const key = `${identity.pid}:${identity.startedAt}`;
  if (!recorded.has(key)) {
    recordProcess(context.processLedger, {
      pid: identity.pid,
      marker: `vean-h06-${context.runId}`,
      executable: identity.executable,
      startedAt: identity.startedAt,
    });
    recorded.add(key);
    observed.push(identity);
  }
  let children: number[] = [];
  try {
    children = childPids(pid);
  } catch {}
  for (const child of children) recordTree(child);
}

while (!existsSync(stopPath)) {
  try {
    recordTree(appProcess(context).pid);
  } catch {}
  await Bun.sleep(50);
}
try {
  recordTree(appProcess(context).pid);
} catch {}
console.log(JSON.stringify({ observed }));
