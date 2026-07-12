#!/usr/bin/env bun
import { inspectAndReap } from "./watchdog-lib";

const index = process.argv.indexOf("--ledger");
const ledger = index >= 0 ? process.argv[index + 1] : undefined;
if (!ledger) throw new Error("--ledger is required");
const result = await inspectAndReap(ledger, { reap: process.argv.includes("--reap") });
console.log(JSON.stringify(result));
process.exit(result.findings.length === 0 ? 0 : 1);
