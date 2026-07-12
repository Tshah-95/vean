import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";

export const MACOS_NODE_VERSION = "24.15.0";
export const APPIUM_VERSION = "3.5.2";
export const MAC2_VERSION = "4.0.3";

export type TimedCommand = {
  command: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
};

export type DoctorFinding = { code: string; detail: string; userAction: string };

export function classifyXcodeFirstLaunch(result: TimedCommand): DoctorFinding | null {
  if (!result.timedOut && result.exitCode === 0) return null;
  const observed = result.timedOut
    ? `timed out after ${result.durationMs}ms`
    : `exited ${result.exitCode}${result.stderr ? `: ${result.stderr}` : ""}`;
  return {
    code: "E_XCODE_FIRST_LAUNCH",
    detail: `${result.command.join(" ")} ${observed}`,
    userAction:
      "Complete Xcode first-launch setup interactively; the harness never runs the privileged repair.",
  };
}

export function buildMacosBlockedEvidence(options: {
  finding: DoctorFinding;
  versions: unknown;
  observedCheck: TimedCommand;
  sourceSha: string;
  fixtureRunId: string;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    contract_version: "1.0.0",
    claim_id: "claim-native-macos-shell",
    status: "blocked_with_user_decision",
    reason_code: options.finding.code,
    predicate_met: false,
    oracle_command: "bun run verify:macos",
    blocked_command: options.observedCheck.command,
    detail: options.finding.detail,
    user_action: options.finding.userAction,
    versions: options.versions,
    observed_check: options.observedCheck,
    source_sha: options.sourceSha,
    fixture_run_id: options.fixtureRunId,
    timestamp: options.timestamp ?? new Date().toISOString(),
  };
}

export function pinnedNodeCommand(repo: string, args: string[]): string[] {
  return [
    "mise",
    "exec",
    `node@${MACOS_NODE_VERSION}`,
    "--",
    "node",
    join(repo, "node_modules/appium/index.js"),
    ...args,
  ];
}

export async function runTimed(
  command: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<TimedCommand> {
  const started = Date.now();
  const child = spawn(command[0] as string, command.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 1_000).unref();
    }
  }, options.timeoutMs ?? 15_000);
  const result = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
    (done) => child.once("close", (exitCode, signal) => done({ exitCode, signal })),
  );
  clearTimeout(timeout);
  return {
    command,
    ...result,
    timedOut,
    durationMs: Date.now() - started,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

function packageVersion(repo: string, name: string): string | null {
  const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
  };
  return manifest.devDependencies?.[name] ?? null;
}

export async function ensureMac2Installed(repo: string, home: string): Promise<TimedCommand> {
  mkdirSync(home, { recursive: true });
  if (
    packageVersion(repo, "appium") !== APPIUM_VERSION ||
    packageVersion(repo, "appium-mac2-driver") !== MAC2_VERSION
  ) {
    throw new Error("Appium/Mac2 worktree package pins do not match the H06 contract");
  }
  const localDriver = join(repo, "node_modules/appium-mac2-driver");
  const extension = JSON.parse(readFileSync(join(localDriver, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
    appium?: { driverName?: string; automationName?: string };
  };
  if (
    extension.name !== "appium-mac2-driver" ||
    extension.version !== MAC2_VERSION ||
    extension.appium?.driverName !== "mac2" ||
    extension.appium?.automationName !== "Mac2"
  ) {
    throw new Error("local Mac2 extension manifest does not match the pinned driver contract");
  }
  writeFileSync(
    join(home, "package.json"),
    `${JSON.stringify({ private: true, name: "vean-h06-appium-home", version: "1.0.0" }, null, 2)}\n`,
  );
  return await runTimed(["npm", "link", "--save-dev", "--ignore-scripts", localDriver, "--json"], {
    cwd: home,
    env: { APPIUM_HOME: home },
    timeoutMs: 30_000,
  });
}

export async function waitForAppium(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) {
        const body = (await response.json()) as { value?: { ready?: boolean } };
        if (body.value?.ready === true) return;
      }
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`Appium did not become ready on 127.0.0.1:${port}`);
}

export async function freePort(): Promise<number> {
  return await new Promise((done, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no port"));
      server.close((error) => (error ? reject(error) : done(address.port)));
    });
  });
}

export function realRepo(importMetaDir: string): string {
  return resolve(importMetaDir, "../..");
}
