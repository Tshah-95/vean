#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const VM_NAME = "vean-macos-dev";
export const VM_CPU = 8;
export const VM_MEMORY_MB = 32_768;
export const VM_DISK_GB = 200;
export const DEFAULT_IMAGE = "ghcr.io/cirruslabs/macos-tahoe-xcode:latest";
export const REPOSITORY_URL = "https://github.com/Tshah-95/vean.git";
export const GUEST_REPOSITORY = "/Users/admin/Github/vean-runner";
export const DEFAULT_SSH_KEY = join(homedir(), ".ssh/vean_tart_ed25519");
export const HEADLESS_RUN_ARGS = [
  "run",
  "--no-graphics",
  "--no-audio",
  "--no-clipboard",
  VM_NAME,
] as const;

type VmInfo = {
  OS: string;
  CPU: number;
  Memory: number;
  Disk: number;
  Running: boolean;
  State: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function fail(message: string): never {
  throw new Error(message);
}

function run(
  command: string,
  args: readonly string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
  });
  const normalized = {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
  if (!options.allowFailure && normalized.exitCode !== 0) {
    fail(`${command} ${args.join(" ")} failed (${normalized.exitCode})\n${normalized.stderr}`);
  }
  return normalized;
}

function tart(
  args: readonly string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): CommandResult {
  return run("tart", args, options);
}

function runPlan(
  plan: readonly string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): CommandResult {
  const [command, ...args] = plan;
  if (!command) fail("execution plan must not be empty");
  return run(command, args, options);
}

export function validateSourceRef(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes("..") || value.endsWith("/")) {
    fail(`invalid Git source ref: ${JSON.stringify(value)}`);
  }
  return value;
}

export function tartRunPlan(): readonly string[] {
  return ["tart", ...HEADLESS_RUN_ARGS];
}

export function guestExecPlan(command: string): readonly string[] {
  if (!command) fail("guest command must not be empty");
  return ["tart", "exec", VM_NAME, "/bin/bash", "-lc", command];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function validateGuestIp(value: string): string {
  const candidate = value.trim();
  const octets = candidate.split(".").map(Number);
  const validIpv4 =
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate) &&
    octets.length === 4 &&
    octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255);
  const privateAddress =
    octets[0] === 10 ||
    (octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
  if (!validIpv4 || !privateAddress) {
    fail(`refusing SSH fallback to non-private Tart DHCP address ${JSON.stringify(candidate)}`);
  }
  return candidate;
}

export function sshGuestExecPlan(
  ip: string,
  command: string,
  keyPath = DEFAULT_SSH_KEY,
): readonly string[] {
  const guestIp = validateGuestIp(ip);
  if (!command) fail("guest command must not be empty");
  return [
    "ssh",
    "-i",
    keyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=2",
    `admin@${guestIp}`,
    `/bin/bash -lc ${shellQuote(command)}`,
  ];
}

type GuestConnection = { kind: "tart-agent" } | { kind: "ssh"; ip: string; keyPath: string };

function resolveGuestConnection(): GuestConnection {
  const agent = tart(["exec", VM_NAME, "/usr/bin/true"], {
    allowFailure: true,
    timeoutMs: 15_000,
  });
  if (agent.exitCode === 0) return { kind: "tart-agent" };

  const keyPath = resolve(process.env.VEAN_TART_SSH_KEY ?? DEFAULT_SSH_KEY);
  if (!existsSync(keyPath)) {
    fail(`Tart guest agent is unavailable and the SSH fallback key is absent: ${keyPath}`);
  }
  const ip = validateGuestIp(tart(["ip", VM_NAME, "--resolver", "dhcp", "--wait", "60"]).stdout);
  const probe = runPlan(sshGuestExecPlan(ip, "true", keyPath), { allowFailure: true });
  if (probe.exitCode !== 0) {
    fail(
      `Tart guest agent and strict SSH fallback are unavailable for ${VM_NAME} at ${ip}: ${probe.stderr}`,
    );
  }
  return { kind: "ssh", ip, keyPath };
}

function runGuestCommand(command: string): CommandResult {
  const connection = resolveGuestConnection();
  return connection.kind === "tart-agent"
    ? runPlan(guestExecPlan(command))
    : runPlan(sshGuestExecPlan(connection.ip, command, connection.keyPath));
}

export function nativeVerifyPlan(
  sourceRef = "main",
  extraArgs: readonly string[] = [],
): readonly string[] {
  const ref = validateSourceRef(sourceRef);
  const encodedArgs = extraArgs.map(shellQuote).join(" ");
  const command = [
    "set -euo pipefail",
    `cd ${GUEST_REPOSITORY}`,
    `test \"$(git remote get-url origin)\" = ${REPOSITORY_URL}`,
    'test -z "$(git status --porcelain)"',
    `test \"$(git rev-parse HEAD)\" = \"$(git rev-parse origin/${ref})\"`,
    'test "$(uname -s)" = Darwin',
    'export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/share/mise/shims:/opt/homebrew/opt/libxml2/bin:/opt/homebrew/bin:$PATH"',
    "export VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION=1",
    "export VEAN_MACOS_RUNNER_CLASS=dedicated",
    `bun run verify:macos${encodedArgs ? ` -- ${encodedArgs}` : ""}`,
  ].join("; ");
  return guestExecPlan(command);
}

export function guestDoctorPlan(sourceRef = "main"): readonly string[] {
  const ref = validateSourceRef(sourceRef);
  const command = [
    "set -euo pipefail",
    `cd ${GUEST_REPOSITORY}`,
    `test \"$(git remote get-url origin)\" = ${REPOSITORY_URL}`,
    'test -z "$(git status --porcelain)"',
    `test \"$(git rev-parse HEAD)\" = \"$(git rev-parse origin/${ref})\"`,
    'export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/share/mise/shims:/opt/homebrew/opt/libxml2/bin:/opt/homebrew/bin:$PATH"',
    'test "$(bun --version)" = 1.3.14',
    'test "$(node --version)" = v24.15.0',
    'rustup run 1.95.0 rustc --version | grep -q "^rustc 1.95.0"',
    "command -v melt",
    "command -v ffmpeg",
    "command -v xmllint",
    "xcodebuild -checkFirstLaunchStatus",
    "export VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION=1",
    "export VEAN_MACOS_RUNNER_CLASS=dedicated",
    "bun run doctor:macos-driver -- --json",
  ].join("; ");
  return guestExecPlan(command);
}

function listVmNames(): string[] {
  const parsed = JSON.parse(
    tart(["list", "--source", "local", "--format", "json"]).stdout,
  ) as Array<{
    Name: string;
  }>;
  return parsed.map((item) => item.Name);
}

function getVmInfo(): VmInfo {
  if (!listVmNames().includes(VM_NAME)) fail(`required Tart VM ${VM_NAME} does not exist`);
  return JSON.parse(tart(["get", VM_NAME, "--format", "json"]).stdout) as VmInfo;
}

function assertConfigured(info = getVmInfo()): VmInfo {
  const problems: string[] = [];
  if (info.OS !== "darwin") problems.push(`OS=${info.OS}`);
  if (info.CPU !== VM_CPU) problems.push(`CPU=${info.CPU}`);
  if (info.Memory !== VM_MEMORY_MB) problems.push(`Memory=${info.Memory}`);
  if (info.Disk !== VM_DISK_GB) problems.push(`Disk=${info.Disk}`);
  if (problems.length > 0) {
    fail(
      `${VM_NAME} has an unsafe/unexpected configuration (${problems.join(", ")}); expected darwin/${VM_CPU} CPU/${VM_MEMORY_MB} MB/${VM_DISK_GB} GB`,
    );
  }
  return info;
}

function assertRunning(): VmInfo {
  const info = assertConfigured();
  if (!info.Running || info.State !== "running") {
    fail(`${VM_NAME} is not running; use bun run vm:macos:start`);
  }
  resolveGuestConnection();
  return info;
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function doctor(hostOnly: boolean): void {
  if (process.platform !== "darwin")
    fail(`Tart macOS harness requires a macOS host, got ${process.platform}`);
  const version = run("tart", ["--version"]).stdout.trim();
  if (!/^2\./.test(version)) fail(`unsupported Tart version ${version}; expected 2.x`);
  const report: Record<string, unknown> = { ok: true, tart: version, host: process.platform };
  if (!hostOnly) report.vm = assertConfigured();
  print(report);
}

function configure(image: string): void {
  if (!listVmNames().includes(VM_NAME)) tart(["clone", image, VM_NAME]);
  const before = getVmInfo();
  if (before.OS !== "darwin") fail(`refusing to adopt non-macOS VM ${VM_NAME}`);
  if (before.Disk > VM_DISK_GB) {
    fail(
      `refusing to adopt ${VM_NAME}: ${before.Disk} GB disk cannot be reduced to ${VM_DISK_GB} GB`,
    );
  }
  if (before.Running || before.State !== "stopped") {
    fail(`stop ${VM_NAME} before changing its configuration (state=${before.State})`);
  }
  tart([
    "set",
    VM_NAME,
    "--cpu",
    String(VM_CPU),
    "--memory",
    String(VM_MEMORY_MB),
    "--disk-size",
    String(VM_DISK_GB),
  ]);
  print({ ok: true, vm: assertConfigured(), adopted: true });
}

function start(): void {
  const info = assertConfigured();
  if (info.Running) {
    assertRunning();
    print({ ok: true, vm: VM_NAME, alreadyRunning: true, headless: true });
    return;
  }
  if (info.State !== "stopped") {
    fail(`refusing to start ${VM_NAME} from unexpected Tart state ${info.State}`);
  }
  const stateDir = join(homedir(), ".local/state/vean-vm");
  mkdirSync(stateDir, { recursive: true });
  const logPath = join(stateDir, `${VM_NAME}.log`);
  const log = openSync(logPath, "a");
  const child = spawn("tart", [...HEADLESS_RUN_ARGS], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(join(stateDir, `${VM_NAME}.pid`), `${child.pid}\n`, { mode: 0o600 });
  tart(["ip", VM_NAME, "--resolver", "dhcp", "--wait", "300"]);
  assertRunning();
  print({ ok: true, vm: VM_NAME, pid: child.pid, logPath, headless: true });
}

function status(): void {
  if (!listVmNames().includes(VM_NAME)) {
    print({ ok: false, vm: VM_NAME, exists: false });
    process.exitCode = 1;
    return;
  }
  const info = getVmInfo();
  const configured =
    info.OS === "darwin" &&
    info.CPU === VM_CPU &&
    info.Memory === VM_MEMORY_MB &&
    info.Disk === VM_DISK_GB;
  print({ ok: configured, vm: VM_NAME, configured, info });
  if (!configured) process.exitCode = 1;
}

function runGuestScript(scriptPath: string, args: readonly string[]): void {
  assertRunning();
  const payload = Buffer.from(readFileSync(scriptPath)).toString("base64");
  const safeArgs = args.map(shellQuote).join(" ");
  const command = `printf %s ${shellQuote(payload)} | base64 -D | /bin/bash -s -- ${safeArgs}`;
  runGuestCommand(command);
}

function bootstrap(sourceRef: string): void {
  const ref = validateSourceRef(sourceRef);
  runGuestScript(resolve(import.meta.dirname, "bootstrap-guest.sh"), [
    REPOSITORY_URL,
    ref,
    GUEST_REPOSITORY,
  ]);
  print({ ok: true, vm: VM_NAME, repository: GUEST_REPOSITORY, sourceRef: ref });
}

function verifyNative(sourceRef: string, args: readonly string[]): void {
  assertRunning();
  const command = nativeVerifyPlan(sourceRef, args).at(-1);
  if (!command) fail("native verification plan is empty");
  runGuestCommand(command);
  print({ ok: true, vm: VM_NAME, runnerClass: "dedicated", sourceRef });
}

function doctorGuest(sourceRef: string): void {
  assertRunning();
  const command = guestDoctorPlan(sourceRef).at(-1);
  if (!command) fail("guest doctor plan is empty");
  runGuestCommand(command);
  print({ ok: true, vm: VM_NAME, guestReady: true, sourceRef });
}

function collectEvidence(destination?: string): void {
  assertRunning();
  const target = resolve(
    destination ??
      join(
        process.cwd(),
        ".vean/vm-harness/evidence",
        new Date().toISOString().replaceAll(":", "-"),
        "h06.tgz",
      ),
  );
  mkdirSync(dirname(target), { recursive: true });
  const command = `set -euo pipefail; cd ${GUEST_REPOSITORY}; test -d .vean/harness/native-runs; tar -czf - .vean/harness/native-runs | base64`;
  const result = runGuestCommand(command);
  const bytes = Buffer.from(result.stdout.replaceAll(/\s/g, ""), "base64");
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    fail("guest returned an invalid H06 evidence archive");
  }
  writeFileSync(target, bytes, { mode: 0o600 });
  print({
    ok: true,
    vm: VM_NAME,
    evidence: target,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function stop(): void {
  if (!listVmNames().includes(VM_NAME)) fail(`required Tart VM ${VM_NAME} does not exist`);
  const info = getVmInfo();
  if (info.Running) tart(["stop", VM_NAME, "--timeout", "60"]);
  const after = getVmInfo();
  if (after.Running || after.State !== "stopped") {
    fail(`Tart did not stop ${VM_NAME} cleanly (state=${after.State})`);
  }
  print({ ok: true, vm: VM_NAME, stopped: true });
}

function usage(): never {
  fail(
    "usage: macos-vm.ts <doctor|configure|start|status|bootstrap|doctor-guest|verify-native|collect-evidence|stop> [options]",
  );
}

if (import.meta.main) {
  try {
    const [subcommand, ...argv] = process.argv.slice(2);
    const sourceRefIndex = argv.indexOf("--source-ref");
    const sourceRef = sourceRefIndex >= 0 ? (argv[sourceRefIndex + 1] ?? usage()) : "main";
    const passthrough = argv.includes("--") ? argv.slice(argv.indexOf("--") + 1) : [];
    switch (subcommand) {
      case "doctor":
        doctor(argv.includes("--host-only"));
        break;
      case "configure":
      case "create-or-adopt": {
        const imageIndex = argv.indexOf("--image");
        configure(imageIndex >= 0 ? (argv[imageIndex + 1] ?? usage()) : DEFAULT_IMAGE);
        break;
      }
      case "start":
        start();
        break;
      case "status":
        status();
        break;
      case "bootstrap":
        bootstrap(sourceRef);
        break;
      case "doctor-guest":
        doctorGuest(sourceRef);
        break;
      case "verify-native":
        verifyNative(sourceRef, passthrough);
        break;
      case "collect-evidence": {
        const destinationIndex = argv.indexOf("--destination");
        collectEvidence(
          destinationIndex >= 0 ? (argv[destinationIndex + 1] ?? usage()) : undefined,
        );
        break;
      }
      case "stop":
        stop();
        break;
      default:
        usage();
    }
  } catch (error) {
    console.error(
      JSON.stringify(
        { ok: false, error: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}
