import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type WatchdogFinding, inspectAndReap } from "./watchdog-lib";

type RegistryEntry = { root: string; processLedger: string };

export type SupervisionResult = {
  exitCode: number;
  timedOut: boolean;
  detected: WatchdogFinding[];
  remaining: WatchdogFinding[];
};

async function cleanupRegistry(registryDir: string): Promise<{
  detected: WatchdogFinding[];
  remaining: WatchdogFinding[];
}> {
  const detected: WatchdogFinding[] = [];
  const remaining: WatchdogFinding[] = [];
  for (const entry of readdirSync(registryDir)) {
    const registryPath = join(registryDir, entry);
    let registry: RegistryEntry;
    try {
      registry = JSON.parse(readFileSync(registryPath, "utf8")) as RegistryEntry;
    } catch {
      continue;
    }
    const first = await inspectAndReap(registry.processLedger, { reap: true });
    detected.push(...first.findings);
    await new Promise((done) => setTimeout(done, 100));
    const second = await inspectAndReap(registry.processLedger, { reap: false });
    remaining.push(...second.findings);
    rmSync(registry.root, { recursive: true, force: true });
  }
  return { detected, remaining };
}

/** Run a fixture-owning worker under an outliving parent and clean every ledger
 * it registers, even when the worker is SIGKILLed or times out. */
export async function superviseCommand(
  command: string[],
  options: { cwd: string; timeoutMs: number; env?: Record<string, string | undefined> },
): Promise<SupervisionResult> {
  const registryDir = mkdtempSync(join(tmpdir(), "vean-harness-supervisor-"));
  const [executable, ...args] = command;
  if (!executable) throw new Error("supervisor command is empty");
  const worker = spawn(executable, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, VEAN_HARNESS_SUPERVISOR_DIR: registryDir },
    stdio: "inherit",
  });
  const exited = new Promise<number>((resolve) => {
    worker.once("exit", (code, signal) => resolve(code ?? (signal === "SIGKILL" ? 137 : 1)));
  });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<number>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        worker.kill("SIGKILL");
      } catch {}
      resolve(124);
    }, options.timeoutMs);
  });
  const exitCode = await Promise.race([exited, timeout]);
  if (timer) clearTimeout(timer);
  if (timedOut) await exited;
  const cleanup = await cleanupRegistry(registryDir);
  rmSync(registryDir, { recursive: true, force: true });
  return { exitCode, timedOut, ...cleanup };
}

export async function runSelfUnderSupervisor(scriptPath: string, args: string[]): Promise<never> {
  const timeoutMs = Number.parseInt(process.env.VEAN_HARNESS_TIMEOUT_MS ?? "120000", 10);
  const result = await superviseCommand(["bun", scriptPath, ...args], {
    cwd: process.cwd(),
    timeoutMs,
    env: { VEAN_HARNESS_SUPERVISED: "1" },
  });
  if (result.remaining.length > 0) {
    console.error(JSON.stringify({ reason_code: "HARNESS_SUPERVISOR_LEAK", ...result }));
    process.exit(1);
  }
  process.exit(result.exitCode);
}
