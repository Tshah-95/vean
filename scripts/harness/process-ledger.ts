import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

export type ProcessRecord = {
  pid: number;
  pgid: number;
  marker: string;
  executable: string;
  startedAt: string;
};

export type ProcessLedger = {
  version: 1;
  processes: ProcessRecord[];
  ports: number[];
};

export function readLedger(path: string): ProcessLedger {
  return JSON.parse(readFileSync(path, "utf8")) as ProcessLedger;
}

export function writeLedger(path: string, ledger: ProcessLedger): void {
  writeFileSync(path, JSON.stringify(ledger, null, 2));
}

export function processGroup(pid: number): number {
  const result = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" });
  const pgid = Number.parseInt(result.stdout.trim(), 10);
  return Number.isInteger(pgid) ? pgid : pid;
}

export function recordProcess(path: string, record: Omit<ProcessRecord, "pgid">): ProcessRecord {
  const full = { ...record, pgid: processGroup(record.pid) };
  const ledger = readLedger(path);
  ledger.processes.push(full);
  writeLedger(path, ledger);
  return full;
}
