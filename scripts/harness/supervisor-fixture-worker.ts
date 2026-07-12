#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { createFixture } from "./fixture";
import { recordProcess } from "./process-ledger";

const repo = resolve(import.meta.dirname, "../..");
const mode = process.argv[2];
const fixture = await createFixture({
  sourceSha: "supervisor-proof",
  developerCanary: join(repo, ".vean/harness/developer-state-canary"),
});
const marker = `vean-supervisor-${fixture.descriptor.runId}`;
const child = spawn(
  "bun",
  [
    join(repo, "scripts/harness/marked-child.ts"),
    marker,
    ...(mode === "abrupt" ? ["--reparent"] : []),
  ],
  { detached: true, stdio: "ignore" },
);
recordProcess(fixture.descriptor.processLedger, {
  pid: child.pid ?? -1,
  marker,
  executable: "bun",
  startedAt: new Date().toISOString(),
});
await Bun.sleep(150);
if (mode === "abrupt") process.kill(process.pid, "SIGKILL");
await new Promise(() => undefined);
