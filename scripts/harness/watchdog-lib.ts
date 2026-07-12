import { spawnSync } from "node:child_process";
import { connect } from "node:net";
import { type ProcessRecord, readLedger } from "./process-ledger";

export type WatchdogFinding = {
  kind: "process" | "identity" | "marker" | "port" | "open-file";
  detail: string;
};

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function portOpen(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(300, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function markedProcesses(marker: string): number[] {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .filter((line) => line.includes(marker))
    .flatMap((line) => {
      const pid = Number.parseInt(line.trim().split(/\s+/, 1)[0] ?? "", 10);
      return Number.isInteger(pid) && pid !== process.pid ? [pid] : [];
    });
}

function identityMatches(record: ProcessRecord): boolean {
  const result = spawnSync("ps", ["-o", "lstart=", "-o", "command=", "-p", String(record.pid)], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout.trim()) return false;
  const fields = result.stdout.trim().split(/\s+/);
  const started = Date.parse(fields.slice(0, 5).join(" "));
  const command = fields.slice(5).join(" ");
  const expectedStarted = Date.parse(record.startedAt);
  return (
    command.includes(record.executable) &&
    Number.isFinite(started) &&
    Number.isFinite(expectedStarted) &&
    Math.abs(started - expectedStarted) < 10_000
  );
}

function reap(record: ProcessRecord, safeIdentity: boolean): void {
  if (safeIdentity) {
    try {
      process.kill(-record.pgid, "SIGKILL");
    } catch {}
    try {
      process.kill(record.pid, "SIGKILL");
    } catch {}
  }
  for (const pid of markedProcesses(record.marker)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

export async function inspectAndReap(
  ledgerPath: string,
  options: { reap: boolean },
): Promise<{ findings: WatchdogFinding[]; reaped: number[] }> {
  const ledger = readLedger(ledgerPath);
  const findings: WatchdogFinding[] = [];
  const reaped: number[] = [];
  for (const record of ledger.processes) {
    const marked = markedProcesses(record.marker);
    const directAlive = alive(record.pid);
    const safeIdentity = directAlive && identityMatches(record);
    if (directAlive && safeIdentity) {
      findings.push({
        kind: "process",
        detail: `${record.pid}:${record.pgid}:${record.executable}:${record.startedAt}`,
      });
    } else if (directAlive) {
      findings.push({ kind: "identity", detail: `${record.pid}:identity-mismatch` });
    }
    for (const pid of marked) findings.push({ kind: "marker", detail: `${record.marker}:${pid}` });
    if (options.reap && (directAlive || marked.length > 0)) {
      reap(record, safeIdentity);
      reaped.push(record.pid);
    }
  }
  for (const port of ledger.ports) {
    if (await portOpen(port)) findings.push({ kind: "port", detail: String(port) });
  }
  const fixtureRoot = ledgerPath.replace(/\/artifacts\/process-ledger\.json$/, "");
  const lsof = spawnSync("lsof", ["+D", fixtureRoot, "-Fn"], { encoding: "utf8" });
  if (lsof.status === 0 && lsof.stdout.trim()) {
    findings.push({ kind: "open-file", detail: lsof.stdout.trim() });
  }
  return { findings, reaped };
}
