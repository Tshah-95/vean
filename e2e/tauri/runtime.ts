import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { readLedger, recordProcess } from "../../scripts/harness/process-ledger";

export type NativeRunContext = {
  runId: string;
  sourceSha: string;
  repo: string;
  projectRoot: string;
  timelinePath: string;
  artifactDir: string;
  processLedger: string;
  previewPort: number;
  webdriverPort: number;
  bundlePath: string;
  binaryPath: string;
  binaryHash: string;
  bundleId: string;
  expectedFinalUrl: string;
};

export function readContext(): NativeRunContext {
  const path = process.env.VEAN_H05_CONTEXT;
  if (!path) throw new Error("VEAN_H05_CONTEXT is required");
  return JSON.parse(readFileSync(path, "utf8")) as NativeRunContext;
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function command(...args: string[]): string {
  return execFileSync(args[0] as string, args.slice(1), { encoding: "utf8" }).trim();
}

export function listenerPid(port: number): number {
  const raw = command("lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t")
    .split("\n")
    .find(Boolean);
  const pid = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(pid)) throw new Error(`no listener PID for 127.0.0.1:${port}`);
  return pid;
}

export function processIdentity(pid: number): {
  pid: number;
  executable: string;
  command: string;
  startedAt: string;
  executableHash: string;
} {
  const executableLine = command("lsof", "-a", "-p", String(pid), "-d", "txt", "-Fn")
    .split("\n")
    .find((line) => line.startsWith("n"));
  if (!executableLine) throw new Error(`could not observe executable for PID ${pid}`);
  const executable = realpathSync(executableLine.slice(1));
  const fullCommand = command("ps", "-p", String(pid), "-o", "command=");
  const startedAt = command("ps", "-p", String(pid), "-o", "lstart=");
  return {
    pid,
    executable: resolve(executable),
    command: fullCommand,
    startedAt,
    executableHash: sha256(executable),
  };
}

export function bundleIdentifier(pid: number): string {
  try {
    const info = command("lsappinfo", "info", "-only", "bundleid", "-app", String(pid));
    return info.match(/"CFBundleIdentifier"="([^"]+)"/)?.[1] ?? "";
  } catch {
    return "";
  }
}

export function recordNativeProcess(
  context: NativeRunContext,
  pid: number,
  marker: string,
): ReturnType<typeof recordProcess> {
  const identity = processIdentity(pid);
  const existing = readLedger(context.processLedger).processes.find(
    (record) => record.pid === pid && record.startedAt === identity.startedAt,
  );
  if (existing) return existing;
  return recordProcess(context.processLedger, {
    pid,
    marker,
    executable: basename(identity.executable),
    startedAt: identity.startedAt,
  });
}

export function writeNativeResult(context: NativeRunContext, result: unknown): string {
  const path = resolve(context.artifactDir, "native-session.json");
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  return path;
}
