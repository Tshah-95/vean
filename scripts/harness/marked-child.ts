#!/usr/bin/env bun
import { spawn } from "node:child_process";

const marker = process.argv[2];
if (!marker) throw new Error("marker is required");
if (process.argv.includes("--reparent")) {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", marker], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  process.exit(0);
}
setInterval(() => {}, 1000);
