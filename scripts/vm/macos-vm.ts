#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const VM_NAME = "vean-macos-dev";
export const VM_CPU = 8;
export const VM_MEMORY_MB = 32_768;
export const VM_DISK_GB = 200;
export const DEFAULT_IMAGE =
  "ghcr.io/cirruslabs/macos-tahoe-xcode@sha256:61f6e857a3d65dd2f8daf9c51c7b837fa458bcc9181ae8556e645b534dab6bf6";
export const REPOSITORY_URL = "https://github.com/Tshah-95/vean.git";
export const GUEST_REPOSITORY = "/Users/admin/Github/vean-runner";
export const GUEST_SMOKE_PROJECT = "/Users/admin/Projects/vean-smoke";
export const GUEST_PROJECTS_ROOT = "/Users/admin/Projects";
export const MIN_GUEST_ROOT_FREE_KB = 40 * 1024 * 1024;
export const MIN_GUEST_PROJECT_FREE_KB = 20 * 1024 * 1024;
export const DEFAULT_SSH_KEY = join(homedir(), ".ssh/vean_tart_ed25519");
export const DEFAULT_KNOWN_HOSTS = join(homedir(), ".ssh/known_hosts.vean-tart");
export const DEFAULT_STATE_DIR = join(homedir(), ".local/state/vean-vm");
export const HEADLESS_RUN_ARGS = ["run", "--no-graphics", "--no-audio", "--no-clipboard"] as const;
export const READY_STEPS = [
  "start",
  "sync",
  "doctor-guest",
  "verify-shares",
  "seed-smoke-project",
] as const;

export type VmShare = {
  name: string;
  hostPath: string;
};

export type ShareConfig = {
  version: 1;
  shares: VmShare[];
};

export type LaunchPlan = {
  version: 1;
  vm: string;
  args: string[];
  shares: VmShare[];
  shareConfigSha256: string;
};

type LaunchRecord = LaunchPlan & {
  pid: number;
  processCommand: string;
  startedAt: string;
};

export type LaunchAssessment =
  | { ok: true; status: "current" }
  | { ok: false; status: "unknown" | "stale"; reason: string };

export type RemoteRefAssessment = { ok: true; sha: string } | { ok: false; reason: string };

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

function stateDir(): string {
  return resolve(process.env.VEAN_VM_STATE_DIR ?? DEFAULT_STATE_DIR);
}

function shareConfigPath(): string {
  return join(stateDir(), "shares.json");
}

function launchRecordPath(): string {
  return join(stateDir(), `${VM_NAME}.launch.json`);
}

function ensureStateDir(): string {
  const directory = stateDir();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function isInside(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

export function validateShareName(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    fail(
      `invalid share name ${JSON.stringify(value)}; use a lowercase slug (letters, digits, hyphens; maximum 63 characters)`,
    );
  }
  return value;
}

export function validateSharePath(value: string, home = homedir()): string {
  if (!isAbsolute(value)) fail(`share path must be absolute: ${JSON.stringify(value)}`);
  let canonical: string;
  try {
    canonical = realpathSync(value);
  } catch {
    fail(`share path must be an existing real directory: ${JSON.stringify(value)}`);
  }
  if (!lstatSync(canonical).isDirectory()) {
    fail(`share path must be an existing real directory: ${JSON.stringify(value)}`);
  }
  if (canonical.includes(":")) {
    fail(
      `share path cannot contain ':' because Tart uses it as a mount-field delimiter: ${canonical}`,
    );
  }

  const canonicalHome = realpathSync(home);
  const forbiddenSystemRoots = ["/", "/Users", "/etc", "/private/etc", "/var/root"];
  if (forbiddenSystemRoots.includes(canonical) || canonical === canonicalHome) {
    fail(`refusing broad or sensitive share root: ${canonical}`);
  }

  const relativeToHome = relative(canonicalHome, canonical);
  const firstHomeSegment = relativeToHome.split(sep)[0] ?? "";
  if (isInside(canonical, canonicalHome) && firstHomeSegment.startsWith(".")) {
    fail(`refusing sensitive dot-config path: ${canonical}`);
  }
  const sensitiveRoots = [
    join(canonicalHome, "Library/Keychains"),
    join(canonicalHome, "Library/Application Support"),
  ];
  if (sensitiveRoots.some((root) => isInside(canonical, root))) {
    fail(`refusing sensitive host path: ${canonical}`);
  }

  if (existsSync(join(canonical, ".git"))) {
    fail(`refusing Git repository root as a share: ${canonical}`);
  }
  return canonical;
}

export function parseShareSpecs(specs: readonly string[], home = homedir()): VmShare[] {
  const seen = new Set<string>();
  return specs.map((spec) => {
    const separator = spec.indexOf("=");
    if (separator <= 0 || separator === spec.length - 1) {
      fail(`invalid share ${JSON.stringify(spec)}; expected name=/absolute/host/path`);
    }
    const name = validateShareName(spec.slice(0, separator));
    if (seen.has(name)) fail(`duplicate share name: ${name}`);
    seen.add(name);
    return { name, hostPath: validateSharePath(spec.slice(separator + 1), home) };
  });
}

function normalizeShareConfig(value: unknown): ShareConfig {
  if (!value || typeof value !== "object") fail("invalid VM share configuration");
  const input = value as { version?: unknown; shares?: unknown };
  if (input.version !== 1 || !Array.isArray(input.shares)) {
    fail("unsupported or invalid VM share configuration");
  }
  const seen = new Set<string>();
  const shares = input.shares.map((entry) => {
    if (!entry || typeof entry !== "object") fail("invalid VM share entry");
    const share = entry as { name?: unknown; hostPath?: unknown };
    if (typeof share.name !== "string" || typeof share.hostPath !== "string") {
      fail("invalid VM share entry");
    }
    const name = validateShareName(share.name);
    if (seen.has(name)) fail(`duplicate share name: ${name}`);
    seen.add(name);
    return { name, hostPath: validateSharePath(share.hostPath) };
  });
  return { version: 1, shares };
}

export function readShareConfig(path = shareConfigPath()): ShareConfig {
  if (!existsSync(path)) return { version: 1, shares: [] };
  const mode = statSync(path).mode & 0o777;
  if (mode !== 0o600) fail(`VM share configuration must have mode 0600: ${path}`);
  return normalizeShareConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function writeShareConfig(
  specs: readonly string[],
  path = shareConfigPath(),
  home = homedir(),
): ShareConfig {
  const config: ShareConfig = { version: 1, shares: parseShareSpecs(specs, home) };
  writePrivateJson(path, config);
  return config;
}

function shareConfigDigest(config: ShareConfig): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function buildLaunchPlan(shares: readonly VmShare[]): LaunchPlan {
  const config: ShareConfig = { version: 1, shares: [...shares] };
  return {
    version: 1,
    vm: VM_NAME,
    args: [
      ...HEADLESS_RUN_ARGS,
      ...shares.map(({ name, hostPath }) => `--dir=${name}:${hostPath}:ro`),
      VM_NAME,
    ],
    shares: [...shares],
    shareConfigSha256: shareConfigDigest(config),
  };
}

export function assessLaunchRecord(
  expected: LaunchPlan,
  recorded: unknown,
  pidAlive = true,
  actualProcessCommand?: string,
): LaunchAssessment {
  if (!recorded || typeof recorded !== "object") {
    return { ok: false, status: "unknown", reason: "no valid launch record exists" };
  }
  const candidate = recorded as Partial<LaunchRecord>;
  if (
    candidate.version !== 1 ||
    candidate.vm !== VM_NAME ||
    !Array.isArray(candidate.args) ||
    !Array.isArray(candidate.shares) ||
    typeof candidate.shareConfigSha256 !== "string" ||
    !Number.isInteger(candidate.pid) ||
    typeof candidate.processCommand !== "string" ||
    typeof candidate.startedAt !== "string"
  ) {
    return { ok: false, status: "unknown", reason: "launch record is malformed" };
  }
  if (!pidAlive) {
    return { ok: false, status: "unknown", reason: "recorded Tart process is not alive" };
  }
  if (!actualProcessCommand || actualProcessCommand !== candidate.processCommand) {
    return {
      ok: false,
      status: "unknown",
      reason: "recorded PID no longer has the exact Tart launch command identity",
    };
  }
  if (!/(?:^|\/)tart\s+run\s/.test(candidate.processCommand)) {
    return { ok: false, status: "unknown", reason: "recorded process is not a Tart runner" };
  }
  const actualPlan: LaunchPlan = {
    version: 1,
    vm: candidate.vm,
    args: candidate.args,
    shares: candidate.shares as VmShare[],
    shareConfigSha256: candidate.shareConfigSha256,
  };
  if (JSON.stringify(actualPlan) !== JSON.stringify(expected)) {
    return {
      ok: false,
      status: "stale",
      reason: "running VM launch arguments do not match the current share configuration",
    };
  }
  return { ok: true, status: "current" };
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

export function assessRemoteRef(
  advertisedSha: string,
  localRemoteSha: string,
  headSha?: string,
): RemoteRefAssessment {
  const shaPattern = /^[0-9a-f]{40}$/;
  if (!shaPattern.test(advertisedSha))
    return { ok: false, reason: "remote did not advertise one commit" };
  if (localRemoteSha !== advertisedSha) {
    return { ok: false, reason: "local remote-tracking ref is stale relative to remote truth" };
  }
  if (headSha !== undefined && headSha !== advertisedSha) {
    return { ok: false, reason: "guest checkout does not match remote truth" };
  }
  return { ok: true, sha: advertisedSha };
}

function remoteRefTruthCommands(ref: string, requireHead: boolean): string[] {
  const branch = validateSourceRef(ref);
  return [
    `advertised="$(git ls-remote --exit-code origin ${shellQuote(`refs/heads/${branch}`)} | /usr/bin/awk 'NR == 1 { print $1 } END { if (NR != 1) exit 1 }')"`,
    'case "$advertised" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;; *) printf "invalid advertised commit: %s\\n" "$advertised" >&2; exit 1 ;; esac',
    `local_remote="$(git rev-parse ${shellQuote(`refs/remotes/origin/${branch}`)})"`,
    'test "$local_remote" = "$advertised" || { printf "stale origin ref: local=%s remote=%s\\n" "$local_remote" "$advertised" >&2; exit 1; }',
    ...(requireHead
      ? [
          'head="$(git rev-parse HEAD)"',
          'test "$head" = "$advertised" || { printf "checkout is not remote truth: head=%s remote=%s\\n" "$head" "$advertised" >&2; exit 1; }',
        ]
      : []),
  ];
}

export function remoteRefGuardCommand(sourceRef = "main", requireHead = true): string {
  return ["set -euo pipefail", ...remoteRefTruthCommands(sourceRef, requireHead)].join("; ");
}

export function syncGuestCommand(sourceRef = "main"): string {
  const ref = validateSourceRef(sourceRef);
  return [
    "set -euo pipefail",
    `cd ${GUEST_REPOSITORY}`,
    `test "$(git remote get-url origin)" = ${REPOSITORY_URL}`,
    'test -z "$(git status --porcelain)"',
    "git fetch --prune --tags origin",
    ...remoteRefTruthCommands(ref, false),
    'git checkout --detach "$advertised"',
    'git reset --hard "$advertised"',
    "git clean -ffd",
    'test -z "$(git status --porcelain)"',
    ...remoteRefTruthCommands(ref, true),
    'export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:$PATH"',
    "bun install --frozen-lockfile",
  ].join("; ");
}

function guestDiskCommands(): string[] {
  return [
    `root_free_kb="$(df -Pk / | /usr/bin/awk 'NR == 2 { print $4 }')"`,
    `test "$root_free_kb" -ge ${MIN_GUEST_ROOT_FREE_KB} || { printf "guest root disk below threshold: %s KiB free, need ${MIN_GUEST_ROOT_FREE_KB}\\n" "$root_free_kb" >&2; exit 1; }`,
    `mkdir -p ${GUEST_PROJECTS_ROOT}`,
    `project_free_kb="$(df -Pk ${GUEST_PROJECTS_ROOT} | /usr/bin/awk 'NR == 2 { print $4 }')"`,
    `test "$project_free_kb" -ge ${MIN_GUEST_PROJECT_FREE_KB} || { printf "guest project disk below threshold: %s KiB free, need ${MIN_GUEST_PROJECT_FREE_KB}\\n" "$project_free_kb" >&2; exit 1; }`,
  ];
}

function sshdEffectiveCommands(): string[] {
  return [
    'sshd_effective="$(sudo -n /usr/sbin/sshd -T)"',
    'printf "%s\\n" "$sshd_effective" | /usr/bin/awk \'$1 == "passwordauthentication" && $2 == "no" { found=1 } END { exit !found }\'',
    'printf "%s\\n" "$sshd_effective" | /usr/bin/awk \'$1 == "kbdinteractiveauthentication" && $2 == "no" { found=1 } END { exit !found }\'',
    'printf "%s\\n" "$sshd_effective" | /usr/bin/awk \'$1 == "pubkeyauthentication" && $2 == "yes" { found=1 } END { exit !found }\'',
  ];
}

export function tartRunPlan(shares: readonly VmShare[] = []): readonly string[] {
  return ["tart", ...buildLaunchPlan(shares).args];
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

export function sshHardeningGuestCommand(): string {
  const content = [
    "# Managed by vean vm:macos:setup-ssh",
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "ChallengeResponseAuthentication no",
    "",
  ].join("\n");
  const encoded = Buffer.from(content).toString("base64");
  return [
    "set -euo pipefail",
    'tmp="$(mktemp)"',
    `printf %s ${shellQuote(encoded)} | base64 -D > "$tmp"`,
    'chmod 600 "$tmp"',
    "sudo -n mkdir -p /etc/ssh/sshd_config.d",
    'sudo -n install -o root -g wheel -m 600 "$tmp" /etc/ssh/sshd_config.d/99-vean-key-only.conf',
    'rm -f "$tmp"',
    "sudo -n /usr/sbin/sshd -t",
    ...sshdEffectiveCommands(),
    "sudo -n /bin/launchctl kickstart -k system/com.openssh.sshd",
  ].join("; ");
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

function runGuestCommandWithInput(command: string, input: Buffer): CommandResult {
  const connection = resolveGuestConnection();
  const plan =
    connection.kind === "tart-agent"
      ? guestExecPlan(command)
      : sshGuestExecPlan(connection.ip, command, connection.keyPath, connection.knownHostsPath);
  const [executable, ...args] = plan;
  if (!executable) fail("guest input execution plan is empty");
  const result = spawnSync(executable, args, {
    input,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  const normalized = {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
  if (normalized.exitCode !== 0) {
    fail(`${executable} guest transfer failed (${normalized.exitCode})\n${normalized.stderr}`);
  }
  return normalized;
}

const PINNED_RUST_PATH =
  'rust_bin="$(dirname "$(rustup which --toolchain 1.95.0 cargo)")"; export PATH="$rust_bin:$PATH"';

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
    ...remoteRefTruthCommands(ref, true),
    'test "$(uname -s)" = Darwin',
    'export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/share/mise/shims:/opt/homebrew/opt/libxml2/bin:/opt/homebrew/bin:$PATH"',
    PINNED_RUST_PATH,
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
    ...remoteRefTruthCommands(ref, true),
    ...guestDiskCommands(),
    ...sshdEffectiveCommands(),
    'export PATH="$HOME/.bun/bin:$HOME/.cargo/bin:$HOME/.local/share/mise/shims:/opt/homebrew/opt/libxml2/bin:/opt/homebrew/bin:$PATH"',
    PINNED_RUST_PATH,
    'test "$(bun --version)" = 1.3.14',
    'test "$(node --version)" = v24.15.0',
    'rust_version="$(rustup run 1.95.0 rustc --version)"',
    'case "$rust_version" in "rustc 1.95.0 "*) ;; *) printf "unexpected rustc version: %s\\n" "$rust_version" >&2; exit 1 ;; esac',
    'cargo_version="$(cargo --version)"',
    'case "$cargo_version" in "cargo 1.95.0 "*) ;; *) printf "unexpected cargo version: %s\\n" "$cargo_version" >&2; exit 1 ;; esac',
    'test "$(sw_vers -productVersion)" = 26.4',
    'test "$(sw_vers -buildVersion)" = 25E246',
    'test "$(sysctl -n hw.model)" = VirtualMac2,1',
    'xcode_version="$(xcodebuild -version)"',
    'case "$xcode_version" in "Xcode 26.5"$\'\\n\'*) ;; *) printf "unexpected Xcode version: %s\\n" "$xcode_version" >&2; exit 1 ;; esac',
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processCommand(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const result = run("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
    allowFailure: true,
  });
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined;
}

function currentLaunchAssessment(): LaunchAssessment {
  const expected = buildLaunchPlan(readShareConfig().shares);
  const path = launchRecordPath();
  if (!existsSync(path)) return assessLaunchRecord(expected, undefined);
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) {
      return {
        ok: false,
        status: "unknown",
        reason: "launch record permissions are not mode 0600",
      };
    }
    const recorded = JSON.parse(readFileSync(path, "utf8")) as Partial<LaunchRecord>;
    const pid = typeof recorded.pid === "number" ? recorded.pid : -1;
    return assessLaunchRecord(
      expected,
      recorded,
      pid > 0 && processIsAlive(pid),
      processCommand(pid),
    );
  } catch {
    return assessLaunchRecord(expected, undefined);
  }
}

function assertLaunchCurrent(): void {
  const assessment = currentLaunchAssessment();
  if (!assessment.ok) {
    fail(
      `${VM_NAME} is running with ${assessment.status} launch/share configuration (${assessment.reason}); stop and restart it before using the guest`,
    );
  }
}

function assertRunning(): VmInfo {
  const info = assertConfigured();
  if (!info.Running || info.State !== "running") {
    fail(`${VM_NAME} is not running; use bun run vm:macos:start`);
  }
  assertLaunchCurrent();
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
  if (!hostOnly) {
    const info = assertConfigured();
    if (info.Running) assertLaunchCurrent();
    report.vm = info;
    report.launch = info.Running ? currentLaunchAssessment() : { status: "stopped" };
    report.shares = readShareConfig().shares;
  }
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

function configureShares(specs: readonly string[]): void {
  const path = shareConfigPath();
  const config = writeShareConfig(specs, path);
  const info = listVmNames().includes(VM_NAME) ? getVmInfo() : undefined;
  const restartRequired = Boolean(info?.Running);
  print({
    ok: true,
    config: path,
    mode: "0600",
    shares: config.shares,
    restartRequired,
    ...(restartRequired ? { action: "stop and restart the VM to apply these shares" } : {}),
  });
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
  const directory = ensureStateDir();
  const config = readShareConfig();
  const plan = buildLaunchPlan(config.shares);
  const logPath = join(directory, `${VM_NAME}.log`);
  const log = openSync(logPath, "a");
  const child = spawn("tart", plan.args, {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  writeFileSync(join(directory, `${VM_NAME}.pid`), `${child.pid}\n`, { mode: 0o600 });
  const pid = child.pid ?? fail("Tart runner did not return a process id");
  let identity: string | undefined;
  for (let attempt = 0; attempt < 50 && !identity; attempt += 1) {
    identity = processCommand(pid);
    if (!identity) Bun.sleepSync(100);
  }
  if (!identity || !/(?:^|\/)tart\s+run\s/.test(identity)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    fail(`could not prove exact Tart process identity for PID ${pid}`);
  }
  const record: LaunchRecord = {
    ...plan,
    pid,
    processCommand: identity,
    startedAt: new Date().toISOString(),
  };
  writePrivateJson(launchRecordPath(), record);
  tart(["ip", VM_NAME, "--resolver", "dhcp", "--wait", "300"]);
  assertRunning();
  print({
    ok: true,
    vm: VM_NAME,
    pid: child.pid,
    logPath,
    headless: true,
    shares: config.shares,
    launchRecord: launchRecordPath(),
  });
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
  let keyProbe = runPlan(sshGuestExecPlan(ip, "true", keyPath, knownHostsPath), {
    allowFailure: true,
  });
  if (keyProbe.exitCode !== 0) {
    const password = process.env.VEAN_TART_BOOTSTRAP_PASSWORD ?? "admin";
    const expectScript = expectPasswordScript(password);
    const installPlan = sshPasswordInstallPlan(ip, installCommand, knownHostsPath);
    const expect = spawnSync("/usr/bin/expect", ["-f", "-", "--", ...installPlan], {
      input: expectScript,
      encoding: "utf8",
      timeout: 60_000,
    });
    if ((expect.status ?? 1) !== 0) {
      fail(
        `failed to authorize dedicated SSH key in ${VM_NAME}: ${expect.stderr ?? expect.stdout}`,
      );
    }
    keyProbe = runPlan(sshGuestExecPlan(ip, "true", keyPath, knownHostsPath), {
      allowFailure: true,
    });
    if (keyProbe.exitCode !== 0) fail("dedicated SSH key did not work after authorization");
  }

  runPlan(sshGuestExecPlan(ip, sshHardeningGuestCommand(), keyPath, knownHostsPath));
  let hardened = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const probe = runPlan(
      sshGuestExecPlan(
        ip,
        [...sshdEffectiveCommands(), 'printf "ready\\n"'].join("; "),
        keyPath,
        knownHostsPath,
      ),
      { allowFailure: true },
    );
    if (probe.exitCode === 0 && probe.stdout.includes("ready")) {
      hardened = true;
      break;
    }
    Bun.sleepSync(500);
  }
  if (!hardened) {
    fail(
      "SSH key-only hardening did not survive sshd restart; use Tart guest recovery before retrying",
    );
  }
  const fingerprint = run("ssh-keygen", ["-lf", knownHostsPath]).stdout.trim();
  print({
    ok: true,
    vm: VM_NAME,
    ip,
    keyPath,
    knownHostsPath,
    fingerprint,
    strictLogin: true,
    passwordAuthentication: false,
    keyboardInteractiveAuthentication: false,
  });
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
  const launch = info.Running
    ? currentLaunchAssessment()
    : ({ ok: true, status: "stopped" } as const);
  const ok = configured && launch.ok;
  print({ ok, vm: VM_NAME, configured, info, launch, shares: readShareConfig().shares });
  if (!ok) process.exitCode = 1;
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

function sync(sourceRef: string): void {
  assertRunning();
  const ref = validateSourceRef(sourceRef);
  runGuestCommand(syncGuestCommand(ref));
  print({ ok: true, vm: VM_NAME, repository: GUEST_REPOSITORY, sourceRef: ref, synced: true });
}

export function validateProjectName(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(value)) {
    fail(`invalid guest project name: ${JSON.stringify(value)}`);
  }
  return value;
}

export function validateRemoteRepositoryUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`invalid remote repository URL: ${JSON.stringify(value)}`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !parsed.hostname
  ) {
    fail("remote provisioning accepts only credential-free HTTPS Git URLs");
  }
  return parsed.toString();
}

export function guestProjectPath(name: string): string {
  return `${GUEST_PROJECTS_ROOT}/${validateProjectName(name)}`;
}

export function provisionRemoteGuestCommand(url: string, sourceRef: string, name: string): string {
  const repositoryUrl = validateRemoteRepositoryUrl(url);
  const ref = validateSourceRef(sourceRef);
  const target = guestProjectPath(name);
  return [
    "set -euo pipefail",
    `target=${shellQuote(target)}`,
    'test ! -e "$target" || { printf "guest project already exists: %s\\n" "$target" >&2; exit 1; }',
    'tmp="${target}.tmp-$$"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    `git clone --no-checkout --origin origin ${shellQuote(repositoryUrl)} "$tmp"`,
    'cd "$tmp"',
    "git fetch --prune --tags origin",
    ...remoteRefTruthCommands(ref, false),
    'git checkout --detach "$advertised"',
    'test -z "$(git status --porcelain)"',
    "cd ..",
    'mv "$tmp" "$target"',
    "trap - EXIT",
    'printf "%s\\n" "$target"',
  ].join("; ");
}

function provisionRemoteProject(url: string, sourceRef: string, name: string): void {
  assertRunning();
  const target = guestProjectPath(name);
  runGuestCommand(provisionRemoteGuestCommand(url, sourceRef, name));
  print({ ok: true, vm: VM_NAME, project: target, source: "remote", sourceRef });
}

function createTrackedArchive(source: string, sourceRef: string): { archive: Buffer; sha: string } {
  const root = realpathSync(source);
  if (!lstatSync(root).isDirectory()) fail(`local project source is not a directory: ${root}`);
  const inside = run("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
    allowFailure: true,
  });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    fail(`local project source is not a Git worktree: ${root}`);
  }
  for (const args of [
    ["-C", root, "diff", "--quiet"],
    ["-C", root, "diff", "--cached", "--quiet"],
  ]) {
    if (run("git", args, { allowFailure: true }).exitCode !== 0) {
      fail("local project has tracked changes; commit them before making a safe tracked archive");
    }
  }
  const ref = validateSourceRef(sourceRef);
  const sha = run("git", ["-C", root, "rev-parse", "--verify", `${ref}^{commit}`]).stdout.trim();
  const temporary = mkdtempSync(join(stateDir(), "project-archive-"));
  const archivePath = join(temporary, "tracked.tar.gz");
  try {
    run("git", ["-C", root, "archive", "--format=tar.gz", "-o", archivePath, sha]);
    return { archive: readFileSync(archivePath), sha };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function provisionArchiveGuestCommand(name: string, sourceSha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sourceSha)) fail(`invalid archive source commit: ${sourceSha}`);
  const target = guestProjectPath(name);
  return [
    "set -euo pipefail",
    `target=${shellQuote(target)}`,
    'test ! -e "$target" || { printf "guest project already exists: %s\\n" "$target" >&2; exit 1; }',
    'tmp="${target}.tmp-$$"',
    "trap 'rm -rf \"$tmp\"' EXIT",
    'mkdir -p "$tmp"',
    'tar -xzf - -C "$tmp"',
    'cd "$tmp"',
    "git init -q",
    "git add -A",
    `git -c user.name=vean-harness -c user.email=vean-harness@invalid commit -q -m ${shellQuote(`Provision tracked snapshot ${sourceSha}`)}`,
    `git config vean.sourceCommit ${shellQuote(sourceSha)}`,
    'test -z "$(git status --porcelain)"',
    "cd ..",
    'mv "$tmp" "$target"',
    "trap - EXIT",
    'printf "%s\\n" "$target"',
  ].join("; ");
}

function provisionArchiveProject(source: string, sourceRef: string, name: string): void {
  assertRunning();
  ensureStateDir();
  const target = guestProjectPath(name);
  const { archive, sha } = createTrackedArchive(source, sourceRef);
  runGuestCommandWithInput(provisionArchiveGuestCommand(name, sha), archive);
  print({
    ok: true,
    vm: VM_NAME,
    project: target,
    source: "tracked-archive",
    sourceRef,
    sourceSha: sha,
    bytes: archive.length,
    excludesUntrackedFiles: true,
  });
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

export function verifySharesGuestCommand(shares: readonly VmShare[]): string {
  const commands = ["set -euo pipefail"];
  for (const { name } of shares) {
    validateShareName(name);
    const guestPath = `/Volumes/My Shared Files/${name}`;
    commands.push(`share=${shellQuote(guestPath)}`);
    commands.push('test -d "$share"');
    commands.push('probe="$share/.vean-readonly-probe-$$"');
    commands.push(
      'if /usr/bin/touch "$probe" 2>/dev/null; then /bin/rm -f "$probe"; printf "share unexpectedly writable: %s\\n" "$share" >&2; exit 1; fi',
    );
  }
  return commands.join("; ");
}

export function seedSmokeProjectGuestCommand(sourceRef = "main"): string {
  const ref = validateSourceRef(sourceRef);
  const commands = [
    "set -euo pipefail",
    'export PATH="$HOME/.bun/bin:$HOME/.local/share/mise/shims:/opt/homebrew/bin:$PATH"',
    `cd ${GUEST_REPOSITORY}`,
    `test "$(git remote get-url origin)" = ${REPOSITORY_URL}`,
    'test -z "$(git status --porcelain)"',
    ...remoteRefTruthCommands(ref, true),
    `project=${shellQuote(GUEST_SMOKE_PROJECT)}`,
    'mkdir -p "$project/corpus"',
    `test -f "$project/corpus/smoke.mlt" || cp ${GUEST_REPOSITORY}/corpus/shotcut-single.mlt "$project/corpus/smoke.mlt"`,
    `test -f "$project/corpus/tone.wav" || cp ${GUEST_REPOSITORY}/corpus/tone.wav "$project/corpus/tone.wav"`,
    'bun src/cli.ts project init --repo "$project" --json >/dev/null',
    'bun src/cli.ts project use "$project" --json >/dev/null',
    'bun src/cli.ts timeline use "$project/corpus/smoke.mlt" --repo "$project" --json >/dev/null',
  ];
  for (const role of ["library", "recordings", "mic", "acquired"]) {
    commands.push(
      `bun src/cli.ts media root add ${shellQuote(`/Volumes/My Shared Files/media-${role}`)} --role ${role} --repo "$project" --json >/dev/null`,
    );
  }
  commands.push('bun src/cli.ts timeline current --repo "$project" --json');
  commands.push('bun src/cli.ts media root list --repo "$project" --json');
  return commands.join("; ");
}

function verifyShares(): void {
  assertRunning();
  const shares = readShareConfig().shares;
  if (shares.length === 0) {
    fail("no read-only VM shares are configured; use bun run vm:macos:configure-shares");
  }
  runGuestCommand(verifySharesGuestCommand(shares));
  print({
    ok: true,
    vm: VM_NAME,
    verifiedReadOnly: true,
    shares: shares.map(({ name }) => ({
      name,
      guestPath: `/Volumes/My Shared Files/${name}`,
    })),
  });
}

function seedSmokeProject(sourceRef: string): void {
  assertRunning();
  const shares = readShareConfig().shares;
  const required = ["media-acquired", "media-library", "media-mic", "media-recordings"];
  const configured = shares.map(({ name }) => name).sort();
  if (configured.join("\0") !== required.join("\0")) {
    fail(`smoke project requires exactly the four canonical media shares: ${required.join(", ")}`);
  }
  runGuestCommand(verifySharesGuestCommand(shares));
  runGuestCommand(seedSmokeProjectGuestCommand(sourceRef));
  print({
    ok: true,
    vm: VM_NAME,
    sourceRef,
    project: GUEST_SMOKE_PROJECT,
    activeTimeline: `${GUEST_SMOKE_PROJECT}/corpus/smoke.mlt`,
    mediaRoots: required.map((name) => `/Volumes/My Shared Files/${name}`),
  });
}

export const PROJECT_ARTIFACT_ALLOWLIST = [
  ".vean/harness/native-runs",
  ".vean/harness/browser-runs",
  "test-results",
  "playwright-report",
  "coverage",
] as const;

export function validateProjectArtifactIncludes(values: readonly string[]): string[] {
  const allowed = new Set<string>(PROJECT_ARTIFACT_ALLOWLIST);
  const unique = [...new Set(values)];
  if (unique.length === 0) fail("at least one project artifact include is required");
  for (const value of unique) {
    if (!allowed.has(value))
      fail(`project artifact path is not allowlisted: ${JSON.stringify(value)}`);
  }
  return unique;
}

export function collectProjectArtifactsGuestCommand(
  name: string,
  includes: readonly string[],
): string {
  const project = guestProjectPath(name);
  const paths = validateProjectArtifactIncludes(includes);
  const commands = ["set -euo pipefail", `project=${shellQuote(project)}`, 'test -d "$project"'];
  for (const path of paths) {
    commands.push(`path=${shellQuote(path)}`);
    commands.push(
      'test -e "$project/$path" || { printf "requested artifact is absent: %s\\n" "$path" >&2; exit 1; }',
    );
    commands.push(
      'test -z "$(find "$project/$path" -type l -print -quit)" || { printf "artifact path contains a symlink: %s\\n" "$path" >&2; exit 1; }',
    );
  }
  commands.push(`tar -czf - -C "$project" -- ${paths.map(shellQuote).join(" ")} | base64`);
  return commands.join("; ");
}

function collectProjectArtifacts(
  name: string,
  includes: readonly string[],
  destination?: string,
): void {
  assertRunning();
  const project = guestProjectPath(name);
  const selected = validateProjectArtifactIncludes(includes);
  const target = resolve(
    destination ??
      join(
        process.cwd(),
        ".vean/vm-harness/project-artifacts",
        `${name}-${new Date().toISOString().replaceAll(":", "-")}.tgz`,
      ),
  );
  mkdirSync(dirname(target), { recursive: true });
  const result = runGuestCommand(collectProjectArtifactsGuestCommand(name, selected));
  const bytes = Buffer.from(result.stdout.replaceAll(/\s/g, ""), "base64");
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
    fail("guest returned an invalid project artifact archive");
  }
  writeFileSync(target, bytes, { mode: 0o600 });
  chmodSync(target, 0o600);
  print({
    ok: true,
    vm: VM_NAME,
    project,
    includes: selected,
    artifact: target,
    mode: "0600",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
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
  rmSync(launchRecordPath(), { force: true });
  rmSync(join(stateDir(), `${VM_NAME}.pid`), { force: true });
  print({ ok: true, vm: VM_NAME, stopped: true });
}

function ready(sourceRef: string): void {
  const ref = validateSourceRef(sourceRef);
  for (const step of READY_STEPS) {
    switch (step) {
      case "start":
        start();
        break;
      case "sync":
        sync(ref);
        break;
      case "doctor-guest":
        doctorGuest(ref);
        break;
      case "verify-shares":
        verifyShares();
        break;
      case "seed-smoke-project":
        seedSmokeProject(ref);
        break;
    }
  }
  print({
    ok: true,
    vm: VM_NAME,
    ready: true,
    sourceRef: ref,
    project: GUEST_SMOKE_PROJECT,
  });
}

function optionValue(argv: readonly string[], option: string): string | undefined {
  const index = argv.indexOf(option);
  if (index < 0) return undefined;
  return argv[index + 1] ?? usage();
}

function optionValues(argv: readonly string[], option: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === option) values.push(argv[index + 1] ?? usage());
  }
  return values;
}

function usage(): never {
  fail(
    "usage: macos-vm.ts <doctor|configure|configure-shares|start|setup-ssh|status|bootstrap|sync|ready|doctor-guest|verify-shares|seed-smoke-project|provision-project|verify-native|collect-evidence|collect-project-artifacts|stop> [options]",
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
      case "configure-shares":
        configureShares(argv);
        break;
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
      case "sync":
        sync(sourceRef);
        break;
      case "ready":
        ready(sourceRef);
        break;
      case "doctor-guest":
        doctorGuest(sourceRef);
        break;
      case "verify-shares":
        verifyShares();
        break;
      case "seed-smoke-project":
        seedSmokeProject(sourceRef);
        break;
      case "provision-project": {
        const name = optionValue(argv, "--name") ?? usage();
        const url = optionValue(argv, "--url");
        const source = optionValue(argv, "--source");
        if (Boolean(url) === Boolean(source))
          fail("provision-project requires exactly one of --url or --source");
        if (url) provisionRemoteProject(url, sourceRef, name);
        else provisionArchiveProject(source ?? usage(), sourceRef, name);
        break;
      }
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
      case "collect-project-artifacts": {
        const name = optionValue(argv, "--name") ?? usage();
        const includes = optionValues(argv, "--include");
        collectProjectArtifacts(name, includes, optionValue(argv, "--destination"));
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
