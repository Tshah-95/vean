#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const VM_NAME = "vean-macos-dev";
export const VM_CPU = 8;
export const VM_MEMORY_MB = 32_768;
export const VM_DISK_GB = 200;
export const DEFAULT_IMAGE =
  "ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:61f6e857a3d65dd2f8daf9c51c7b837fa458bcc9181ae8556e645b534dab6bf6";
export const REPOSITORY_URL = "https://github.com/Tshah-95/vean.git";
export const GUEST_REPOSITORY = "/Users/admin/Github/vean-runner";
export const DEFAULT_SSH_KEY = join(homedir(), ".ssh/vean_tart_ed25519");
export const DEFAULT_KNOWN_HOSTS = join(homedir(), ".ssh/known_hosts.vean-tart");
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
  knownHostsPath = DEFAULT_KNOWN_HOSTS,
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
    `UserKnownHostsFile=${knownHostsPath}`,
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

export function sshPasswordInstallPlan(
  ip: string,
  command: string,
  knownHostsPath = DEFAULT_KNOWN_HOSTS,
): readonly string[] {
  const guestIp = validateGuestIp(ip);
  if (!command) fail("guest command must not be empty");
  return [
    "ssh",
    "-o",
    "BatchMode=no",
    "-o",
    "PreferredAuthentications=password",
    "-o",
    "PubkeyAuthentication=no",
    "-o",
    "NumberOfPasswordPrompts=1",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${knownHostsPath}`,
    "-o",
    "ConnectTimeout=15",
    `admin@${guestIp}`,
    `/bin/bash -lc ${shellQuote(command)}`,
  ];
}

export function expectPasswordScript(password: string): string {
  const passwordHex = Buffer.from(password).toString("hex");
  return [
    "set timeout 45",
    `set password [binary format H* {${passwordHex}}]`,
    "spawn {*}$argv",
    "expect {",
    '  -re {(?i)password:} { send -- "$password\\r"; exp_continue }',
    "  eof { set result [wait]; exit [lindex $result 3] }",
    "  timeout { exit 124 }",
    "}",
  ].join("\n");
}

type GuestConnection =
  | { kind: "tart-agent" }
  | { kind: "ssh"; ip: string; keyPath: string; knownHostsPath: string };

function resolveGuestConnection(): GuestConnection {
  const keyPath = resolve(process.env.VEAN_TART_SSH_KEY ?? DEFAULT_SSH_KEY);
  const knownHostsPath = resolve(process.env.VEAN_TART_KNOWN_HOSTS ?? DEFAULT_KNOWN_HOSTS);
  if (existsSync(keyPath) && existsSync(knownHostsPath)) {
    const ip = validateGuestIp(tart(["ip", VM_NAME, "--resolver", "dhcp", "--wait", "60"]).stdout);
    const probe = runPlan(sshGuestExecPlan(ip, "true", keyPath, knownHostsPath), {
      allowFailure: true,
    });
    if (probe.exitCode === 0) return { kind: "ssh", ip, keyPath, knownHostsPath };
  }

  const agent = tart(["exec", VM_NAME, "/usr/bin/true"], {
    allowFailure: true,
    timeoutMs: 5_000,
  });
  if (agent.exitCode === 0) return { kind: "tart-agent" };
  fail(
    `no guest command transport is ready; run bun run vm:macos:setup-ssh (key=${keyPath}, knownHosts=${knownHostsPath})`,
  );
}

function runGuestCommand(command: string): CommandResult {
  const connection = resolveGuestConnection();
  return connection.kind === "tart-agent"
    ? runPlan(guestExecPlan(command))
    : runPlan(
        sshGuestExecPlan(connection.ip, command, connection.keyPath, connection.knownHostsPath),
      );
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
    'test "$(sw_vers -productVersion)" = 26.4',
    'test "$(sw_vers -buildVersion)" = 25E246',
    'test "$(sysctl -n hw.model)" = VirtualMac2,1',
    'xcodebuild -version | grep -q "^Xcode 26.5$"',
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

function hostKeyMaterial(line: string): string | null {
  const fields = line.trim().split(/\s+/);
  const typeIndex = fields.indexOf("ssh-ed25519");
  if (typeIndex < 0 || !fields[typeIndex + 1]) return null;
  return `${fields[typeIndex]} ${fields[typeIndex + 1]}`;
}

export function validateHostKeyPin(
  scannedLines: readonly string[],
  existingLines?: readonly string[],
): string {
  const scannedMaterial = scannedLines.length === 1 ? hostKeyMaterial(scannedLines[0] ?? "") : null;
  if (!scannedMaterial) fail("expected exactly one Ed25519 host key from the Tart guest");
  if (existingLines) {
    const existingMaterials = existingLines
      .map(hostKeyMaterial)
      .filter((value): value is string => value !== null);
    if (existingMaterials.length !== 1 || existingMaterials[0] !== scannedMaterial) {
      fail("dedicated known-hosts entry does not match the Tart guest");
    }
  }
  return scannedLines[0] ?? fail("missing scanned host key");
}

function setupSsh(): void {
  const info = assertConfigured();
  if (!info.Running || info.State !== "running") {
    fail(`${VM_NAME} must be running before SSH setup`);
  }
  if (!existsSync("/usr/bin/expect"))
    fail("/usr/bin/expect is required for terminal-only SSH setup");

  const ip = validateGuestIp(tart(["ip", VM_NAME, "--resolver", "dhcp", "--wait", "60"]).stdout);
  const keyPath = resolve(process.env.VEAN_TART_SSH_KEY ?? DEFAULT_SSH_KEY);
  const knownHostsPath = resolve(process.env.VEAN_TART_KNOWN_HOSTS ?? DEFAULT_KNOWN_HOSTS);
  mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(keyPath), 0o700);
  if (!existsSync(keyPath)) {
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `${VM_NAME}-runner`, "-f", keyPath]);
  }
  if ((statSync(keyPath).mode & 0o077) !== 0) {
    fail(`SSH private key permissions are too broad: ${keyPath}`);
  }
  const publicKey = run("ssh-keygen", ["-y", "-f", keyPath]).stdout.trim();
  if (!publicKey.startsWith("ssh-ed25519 ")) fail(`dedicated key is not Ed25519: ${keyPath}`);

  mkdirSync(dirname(knownHostsPath), { recursive: true, mode: 0o700 });
  const scan = run("ssh-keyscan", ["-T", "10", "-t", "ed25519", ip]);
  const scannedLines = scan.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  validateHostKeyPin(scannedLines);
  if (existsSync(knownHostsPath)) {
    const existing = run("ssh-keygen", ["-F", ip, "-f", knownHostsPath], {
      allowFailure: true,
    });
    const existingLines = existing.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    try {
      if (existing.exitCode !== 0) throw new Error("host is absent from the pin file");
      validateHostKeyPin(scannedLines, existingLines);
    } catch {
      fail(
        `dedicated known-hosts entry does not match ${VM_NAME} at ${ip}; refusing automatic replacement: ${knownHostsPath}`,
      );
    }
  } else {
    writeFileSync(knownHostsPath, `${validateHostKeyPin(scannedLines)}\n`, { mode: 0o600 });
  }
  chmodSync(knownHostsPath, 0o600);

  const installCommand = [
    "set -euo pipefail",
    "umask 077",
    'mkdir -p "$HOME/.ssh"',
    'touch "$HOME/.ssh/authorized_keys"',
    `grep -qxF ${shellQuote(publicKey)} "$HOME/.ssh/authorized_keys" || printf '%s\\n' ${shellQuote(publicKey)} >> "$HOME/.ssh/authorized_keys"`,
    'chmod 700 "$HOME/.ssh"',
    'chmod 600 "$HOME/.ssh/authorized_keys"',
  ].join("; ");
  const password = process.env.VEAN_TART_BOOTSTRAP_PASSWORD ?? "admin";
  const expectScript = expectPasswordScript(password);
  const installPlan = sshPasswordInstallPlan(ip, installCommand, knownHostsPath);
  const expect = spawnSync("/usr/bin/expect", ["-f", "-", "--", ...installPlan], {
    input: expectScript,
    encoding: "utf8",
    timeout: 60_000,
  });
  if ((expect.status ?? 1) !== 0) {
    fail(`failed to authorize dedicated SSH key in ${VM_NAME}: ${expect.stderr ?? expect.stdout}`);
  }
  runPlan(sshGuestExecPlan(ip, "true", keyPath, knownHostsPath));
  const fingerprint = run("ssh-keygen", ["-lf", knownHostsPath]).stdout.trim();
  print({ ok: true, vm: VM_NAME, ip, keyPath, knownHostsPath, fingerprint, strictLogin: true });
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
    "usage: macos-vm.ts <doctor|configure|start|setup-ssh|status|bootstrap|doctor-guest|verify-native|collect-evidence|stop> [options]",
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
      case "setup-ssh":
        setupSsh();
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
