import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolveBin } from "../driver/melt";
import { resolveWorktreeSlug, worktreeStatePath } from "../state/worktree";

export type DoctorHost = "all" | "claude-code" | "codex";
export type DoctorSurface = "all" | "cli" | "lsp" | "mcp" | "cli-lsp" | "mcp-lsp";

export type DoctorOptions = {
  repo?: string;
  host?: DoctorHost;
  json?: boolean;
  strict?: boolean;
  probe?: boolean;
  surface?: DoctorSurface;
};

export type DoctorCheck = {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
};

function check(name: string, status: DoctorCheck["status"], detail: string): DoctorCheck {
  return { name, status, detail };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function findCommand(command: string): string | null {
  const current = spawnSync("sh", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
  });
  if (current.status === 0 && current.stdout.trim())
    return current.stdout.trim().split("\n")[0] ?? null;
  const login = spawnSync("sh", ["-lc", `PATH="$HOME/.local/bin:$PATH"; command -v ${command}`], {
    encoding: "utf8",
  });
  if (login.status === 0 && login.stdout.trim()) return login.stdout.trim().split("\n")[0] ?? null;
  return null;
}

/** Resolve where the on-PATH `vean` bin points relative to THIS checkout's
 *  `src/cli.ts`, realpath-comparing both. Shared by the doctor `cli:path` /
 *  worktree checks and the `worktree.whereami` action so version-skew is reported
 *  identically everywhere (DESIGN-WORKTREE §4.3 / §4.5). `onPath` is the resolved
 *  bin path (null when `vean` isn't on PATH); `matchesCheckout` is true only when
 *  the global bin resolves to this tree's CLI. */
export function resolveVeanBin(repo: string): {
  onPath: string | null;
  expected: string;
  matchesCheckout: boolean;
} {
  const expected = realpathSync(join(repo, "src/cli.ts"));
  const vean = findCommand("vean");
  if (!vean) return { onPath: null, expected, matchesCheckout: false };
  let actual: string;
  try {
    actual = realpathSync(vean);
  } catch {
    actual = vean;
  }
  return { onPath: actual, expected, matchesCheckout: actual === expected };
}

function commandCheck(
  name: string,
  command: string,
  versionArgs: string[],
  missingDetail: string,
): DoctorCheck {
  const path = findCommand(command);
  if (!path) return check(name, "fail", missingDetail);
  const version = spawnSync(path, versionArgs, { encoding: "utf8" });
  const firstLine = (version.stdout || version.stderr).trim().split("\n")[0];
  return check(name, "pass", firstLine ? `${path} (${firstLine})` : path);
}

function skillResolutionCheck(repo: string, rel: string, canonicalRel: string): DoctorCheck {
  const path = join(repo, rel);
  const canonical = join(repo, canonicalRel);
  if (!existsSync(path)) return check(`skill:${rel}`, "fail", `${rel} is missing`);
  if (!existsSync(canonical)) {
    return check(`skill:${rel}`, "fail", `${canonicalRel} is missing`);
  }
  const actual = realpathSync(path);
  const expected = realpathSync(canonical);
  if (actual !== expected) {
    return check(`skill:${rel}`, "fail", `${rel} resolves to ${actual}, expected ${expected}`);
  }
  return check(`skill:${rel}`, "pass", `${rel} resolves to ${canonicalRel}`);
}

function validateCli(repo: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const packageJson = readJson(join(repo, "package.json")) as {
    bin?: Record<string, unknown>;
    scripts?: Record<string, unknown>;
  };
  if (packageJson.bin?.vean === "src/cli.ts") {
    checks.push(check("cli:package-bin", "pass", 'package.json exposes "vean" -> src/cli.ts'));
  } else {
    checks.push(check("cli:package-bin", "fail", 'package.json must expose "vean" -> src/cli.ts'));
  }
  if (packageJson.scripts?.["setup:cli"] === "bun link") {
    checks.push(
      check("cli:setup-script", "pass", "bun run setup:cli registers the local vean bin"),
    );
  } else {
    checks.push(
      check("cli:setup-script", "fail", 'package.json must define "setup:cli": "bun link"'),
    );
  }

  const bin = resolveVeanBin(repo);
  if (!bin.onPath) {
    checks.push(
      check(
        "cli:path",
        "fail",
        "vean is not on PATH; run `bun run setup:cli`, then ensure Bun's global bin directory is on PATH",
      ),
    );
    return checks;
  }
  if (bin.matchesCheckout) {
    checks.push(check("cli:path", "pass", `vean resolves to ${bin.onPath}`));
  } else {
    checks.push(
      check("cli:path", "fail", `vean resolves to ${bin.onPath}, expected ${bin.expected}`),
    );
  }
  return checks;
}

function lspMessage(payload: Record<string, unknown>): string {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function readJsonRpcMessages(buffer: Buffer): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let raw = buffer.toString("utf8");
  while (true) {
    const split = raw.indexOf("\r\n\r\n");
    if (split < 0) return messages;
    const match = raw.slice(0, split).match(/Content-Length:\s*(\d+)/i);
    if (!match) return messages;
    const length = Number(match[1]);
    const bodyStart = split + 4;
    const bodyEnd = bodyStart + length;
    if (Buffer.byteLength(raw.slice(bodyStart), "utf8") < length) return messages;
    messages.push(JSON.parse(raw.slice(bodyStart, bodyEnd)) as Record<string, unknown>);
    raw = raw.slice(bodyEnd);
  }
}

async function probeStdioServer(
  name: string,
  command: string,
  args: string[],
  initializeParams: Record<string, unknown>,
  extraAfterInitialize: string[] = [],
): Promise<DoctorCheck> {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = Buffer.alloc(0);
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = Buffer.concat([stdout, chunk]);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  child.stdin.write(
    lspMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: initializeParams }),
  );
  for (const message of extraAfterInitialize) child.stdin.write(message);

  const started = Date.now();
  let response: Record<string, unknown> | undefined;
  while (Date.now() - started < 5000) {
    response = readJsonRpcMessages(stdout).find((msg) => msg.id === 1);
    if (response) break;
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 25));
  }
  child.kill();

  if (!response) {
    return check(
      name,
      "fail",
      `no initialize response within 5s${stderr ? `; stderr: ${stderr}` : ""}`,
    );
  }
  if (typeof response.result !== "object" || response.result === null) {
    return check(name, "fail", `unexpected initialize response: ${JSON.stringify(response)}`);
  }
  return check(name, "pass", "stdio server answered initialize");
}

async function probeMcpServer(repo: string): Promise<DoctorCheck> {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["--cwd", repo, "src/bridge/mcp/server.ts"],
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const client = new Client({ name: "vean-doctor", version: "0.1.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    await client.close();
    const names = tools.tools.map((tool) => tool.name).sort();
    const required = [
      "apply-op",
      "diagnose",
      "find-references",
      "preview-op",
      "render",
      "resolve-value-at-frame",
      "still",
      "undo",
    ];
    const missing = required.filter((name) => !names.includes(name));
    if (missing.length > 0) {
      return check("mcp:tools", "fail", `server started but missing tools: ${missing.join(", ")}`);
    }
    return check("mcp:tools", "pass", `server started and listed ${names.length} tools`);
  } catch (error) {
    await client.close().catch(() => undefined);
    return check(
      "mcp:tools",
      "fail",
      `${error instanceof Error ? error.message : String(error)}${stderr ? `; stderr: ${stderr}` : ""}`,
    );
  }
}

function surfaceIncludes(surface: DoctorSurface, capability: "cli" | "lsp" | "mcp"): boolean {
  if (surface === "all") return true;
  if (surface === "cli-lsp") return capability === "cli" || capability === "lsp";
  if (surface === "mcp-lsp") return capability === "mcp" || capability === "lsp";
  return surface === capability;
}

function validateClaudeFiles(repo: string, surface: DoctorSurface): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const files = [".claude-plugin/plugin.json"];
  if (surfaceIncludes(surface, "lsp")) files.push(".lsp.json");
  if (surfaceIncludes(surface, "mcp")) files.push(".mcp.json");
  for (const rel of files) {
    const path = join(repo, rel);
    if (!existsSync(path)) {
      checks.push(check(`claude:${rel}`, "fail", `${rel} is missing`));
      continue;
    }
    try {
      readJson(path);
      checks.push(check(`claude:${rel}`, "pass", `${rel} parses as JSON`));
    } catch (error) {
      checks.push(
        check(
          `claude:${rel}`,
          "fail",
          `${rel} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  }

  if (surfaceIncludes(surface, "lsp")) {
    try {
      const lsp = readJson(join(repo, ".lsp.json")) as {
        lspServers?: {
          vean?: {
            command?: unknown;
            args?: unknown;
            extensionToLanguage?: Record<string, unknown>;
          };
        };
      };
      const vean = lsp.lspServers?.vean;
      if (
        vean?.command === "bun" &&
        Array.isArray(vean.args) &&
        vean.extensionToLanguage?.[".mlt"] === "mlt"
      ) {
        checks.push(check("claude:lsp-config", "pass", ".lsp.json maps .mlt to vean-lsp"));
      } else {
        checks.push(
          check("claude:lsp-config", "fail", ".lsp.json must define lspServers.vean for .mlt"),
        );
      }
    } catch {
      // The JSON parse failure is already reported above.
    }
  }

  if (surfaceIncludes(surface, "mcp")) {
    try {
      const mcp = readJson(join(repo, ".mcp.json")) as {
        vean?: { command?: unknown; args?: unknown };
      };
      if (mcp.vean?.command === "bun" && Array.isArray(mcp.vean.args)) {
        checks.push(
          check("claude:mcp-config", "pass", ".mcp.json defines the vean stdio MCP server"),
        );
      } else {
        checks.push(
          check("claude:mcp-config", "fail", ".mcp.json must define the vean stdio MCP server"),
        );
      }
    } catch {
      // The JSON parse failure is already reported above.
    }
  }

  const claude = findCommand("claude");
  if (claude) {
    const result = spawnSync(claude, ["plugin", "validate", repo], {
      encoding: "utf8",
    });
    checks.push(
      check(
        "claude:plugin-validate",
        result.status === 0 ? "pass" : "warn",
        (result.stdout + result.stderr).trim() || `claude plugin validate exited ${result.status}`,
      ),
    );
  } else {
    checks.push(
      check("claude:plugin-validate", "warn", "claude CLI not found; skipped plugin validation"),
    );
  }

  return checks;
}

function validateCodex(repo: string): DoctorCheck[] {
  const agents = join(repo, "AGENTS.md");
  if (!existsSync(agents)) return [check("codex:resolver", "fail", "AGENTS.md is missing")];
  const text = readFileSync(agents, "utf8");
  const required = [".agents/skills/setup/SKILL.md", ".agents/skills/editing/SKILL.md"];
  const missing = required.filter((needle) => !text.includes(needle));
  if (missing.length > 0) {
    return [check("codex:resolver", "fail", `AGENTS.md does not mention ${missing.join(", ")}`)];
  }
  return [check("codex:resolver", "pass", "AGENTS.md routes Codex to setup and editing skills")];
}

/**
 * Remotion/React parity between the two frontend workspaces. The viewer renders
 * the live `@remotion/player` preview and the `remotion/` workspace renders the
 * ProRes export — the SAME composition, two compositing paths. They are separate
 * installs (own node_modules, own lockfile), so they can silently drift to
 * different 4.0.x / 19.x versions; if they do, "one composition, two paths" quietly
 * becomes "two runtimes" and live preview can diverge from export. We read the
 * INSTALLED version of each runtime singleton in both trees and fail on a mismatch.
 * (The viewer's vite `resolve.dedupe` keeps the BROWSER bundle on a single copy —
 * this check guards the cross-process version drift dedupe can't see.) Workspaces
 * that aren't installed yet (fresh core-only clone) are a skip, not a failure.
 */
function validateRemotionParity(repo: string): DoctorCheck[] {
  const SINGLETONS = ["remotion", "@remotion/player", "react", "react-dom"];
  const installedVersion = (workspace: string, pkg: string): string | null => {
    const path = join(repo, workspace, "node_modules", pkg, "package.json");
    if (!existsSync(path)) return null;
    try {
      return (readJson(path) as { version?: string }).version ?? null;
    } catch {
      return null;
    }
  };
  return SINGLETONS.map((pkg) => {
    const viewer = installedVersion("viewer", pkg);
    const producer = installedVersion("remotion", pkg);
    if (viewer == null || producer == null) {
      return check(
        `remotion-parity:${pkg}`,
        "warn",
        `not installed in ${viewer == null ? "viewer/" : ""}${viewer == null && producer == null ? " and " : ""}${producer == null ? "remotion/" : ""} — run bun install in both to verify parity`,
      );
    }
    if (viewer !== producer) {
      return check(
        `remotion-parity:${pkg}`,
        "fail",
        `${pkg} drift: viewer has ${viewer}, remotion/ has ${producer} — live preview and ProRes export would run different ${pkg} versions; pin both package.json to the same exact version and reinstall`,
      );
    }
    return check(
      `remotion-parity:${pkg}`,
      "pass",
      `${pkg} ${viewer} matches across viewer/ + remotion/`,
    );
  });
}

async function validateState(repo: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  let getStateStatus: typeof import("../state/migrate").getStateStatus;
  try {
    ({ getStateStatus } = await import("../state/migrate"));
  } catch (error) {
    return [
      check(
        "state:db",
        "warn",
        `state checks require the Bun runtime (${error instanceof Error ? error.message : String(error)})`,
      ),
    ];
  }
  const status = getStateStatus(repo);
  if (!status.exists) {
    checks.push(check("state:db", "warn", "missing .vean/vean.db; run `vean state init`"));
  } else if (status.migrationsApplied < 1) {
    checks.push(
      check("state:db", "fail", `${status.dbPath} exists but no migrations are recorded`),
    );
  } else {
    checks.push(
      check("state:db", "pass", `${status.dbPath} (${status.migrationsApplied} migrations)`),
    );
  }
  if (status.exists && status.journalMode !== "wal") {
    checks.push(
      check(
        "state:wal",
        "warn",
        `expected WAL journal mode, got ${status.journalMode ?? "unknown"}`,
      ),
    );
  }

  const gitignore = join(repo, ".gitignore");
  if (!existsSync(gitignore)) {
    checks.push(check("state:gitignore", "warn", ".gitignore missing; .vean/ should be ignored"));
  } else if (readFileSync(gitignore, "utf8").split(/\r?\n/).includes(".vean/")) {
    checks.push(check("state:gitignore", "pass", ".vean/ is gitignored"));
  } else {
    checks.push(check("state:gitignore", "fail", ".gitignore must include .vean/"));
  }
  return checks;
}

/**
 * Worktree health (DESIGN-WORKTREE §4.3 / §4.5): is this checkout's identity
 * persisted, is `.vean/` initialized, and does the global `vean` bin point at
 * THIS tree? A linked worktree whose code differs from the canonical `bun link`
 * is the EXPECTED version-skew condition (invariant 5), so the bin mismatch is a
 * WARN, not a fail — it turns silent skew into a visible, expected note rather
 * than breaking the readiness gate.
 */
function validateWorktree(repo: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const identity = resolveWorktreeSlug(repo);

  const statePath = worktreeStatePath(repo);
  if (existsSync(statePath)) {
    checks.push(
      check("worktree:slug", "pass", `slug "${identity.slug}" persisted (.vean/worktree.json)`),
    );
  } else {
    // Not yet stamped — harmless (it lazily writes on first state touch / whereami),
    // so a warn with the slug doctor WOULD persist, not a fail.
    checks.push(
      check(
        "worktree:slug",
        "warn",
        `slug "${identity.slug}" not yet persisted; run \`vean whereami\` or \`bun run worktree:init\` to stamp .vean/worktree.json`,
      ),
    );
  }

  checks.push(
    check(
      "worktree:state-dir",
      existsSync(join(repo, ".vean")) ? "pass" : "warn",
      existsSync(join(repo, ".vean"))
        ? ".vean/ is initialized"
        : ".vean/ not initialized yet; created on first state touch (run `vean state init`)",
    ),
  );

  const bin = resolveVeanBin(repo);
  if (!bin.onPath) {
    checks.push(
      check(
        "worktree:bin",
        "warn",
        "vean is not on PATH; inside a worktree use `bun run <script>` / `bun src/cli.ts …` (the canonical checkout owns the global bin)",
      ),
    );
  } else if (bin.matchesCheckout) {
    checks.push(
      check("worktree:bin", "pass", `global vean resolves to this checkout (${bin.onPath})`),
    );
  } else {
    checks.push(
      check(
        "worktree:bin",
        "warn",
        `global vean resolves to ${bin.onPath}, not this checkout (${bin.expected}) — expected in a worktree; invoke via \`bun run <script>\` / \`bun src/cli.ts …\``,
      ),
    );
  }

  return checks;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const projectRepo = resolve(options.repo ?? process.cwd());
  // `--repo` names the consumer project being edited. The CLI/LSP/MCP, skills,
  // package metadata, and frontend runtimes belong to the installed VEAN
  // checkout, which is the source tree containing this module. Conflating the
  // two made `vean doctor --repo <consumer>` look for `<consumer>/src/cli.ts`.
  const runtimeRepo = resolve(import.meta.dirname, "../..");
  const host = options.host ?? "all";
  const probe = options.probe ?? true;
  const surface = options.surface ?? "lsp";
  const checks: DoctorCheck[] = [];

  checks.push(check("project:root", existsSync(projectRepo) ? "pass" : "fail", projectRepo));
  checks.push(
    check(
      "runtime:root",
      existsSync(join(runtimeRepo, "package.json")) ? "pass" : "fail",
      runtimeRepo,
    ),
  );
  checks.push(commandCheck("bun", "bun", ["--version"], "Bun runtime is required"));
  // Renderer binaries honor the VEAN_MELT/VEAN_FFMPEG/VEAN_FFPROBE overrides (via
  // resolveBin), so doctor reports the bundled-sidecar path inside the Mac app and
  // the system binary on the CLI/Homebrew path.
  checks.push(
    commandCheck(
      "ffmpeg",
      resolveBin("ffmpeg"),
      ["-version"],
      "ffmpeg is required for render/still (set VEAN_FFMPEG to override)",
    ),
  );
  checks.push(
    commandCheck(
      "ffprobe",
      resolveBin("ffprobe"),
      ["-version"],
      "ffprobe is required for media probe/contact-sheet (set VEAN_FFPROBE to override)",
    ),
  );
  checks.push(
    commandCheck(
      "melt",
      resolveBin("melt"),
      ["-version"],
      "melt (MLT) is required for render/still (set VEAN_MELT to override)",
    ),
  );
  checks.push(
    check(
      "dependencies",
      existsSync(join(runtimeRepo, "node_modules")) ? "pass" : "warn",
      "run bun install if missing",
    ),
  );

  checks.push(
    skillResolutionCheck(
      runtimeRepo,
      ".claude/skills/editing/SKILL.md",
      ".agents/skills/editing/SKILL.md",
    ),
  );
  checks.push(
    skillResolutionCheck(runtimeRepo, "skills/editing/SKILL.md", ".agents/skills/editing/SKILL.md"),
  );
  checks.push(
    skillResolutionCheck(
      runtimeRepo,
      ".claude/skills/setup/SKILL.md",
      ".agents/skills/setup/SKILL.md",
    ),
  );
  checks.push(
    skillResolutionCheck(runtimeRepo, "skills/setup/SKILL.md", ".agents/skills/setup/SKILL.md"),
  );
  checks.push(...validateRemotionParity(runtimeRepo));
  checks.push(...(await validateState(projectRepo)));
  checks.push(...validateWorktree(runtimeRepo));

  if (host === "all" || host === "claude-code") {
    checks.push(...validateClaudeFiles(runtimeRepo, surface));
  }
  if (host === "all" || host === "codex") checks.push(...validateCodex(runtimeRepo));
  if (surfaceIncludes(surface, "cli")) checks.push(...validateCli(runtimeRepo));

  if (probe && surfaceIncludes(surface, "lsp")) {
    const rootUri = pathToFileURL(`${projectRepo}/`).href;
    checks.push(
      await probeStdioServer(
        "lsp:initialize",
        "bun",
        ["--cwd", runtimeRepo, "src/bridge/lsp/server.ts"],
        {
          processId: process.pid,
          rootUri,
          capabilities: {},
          clientInfo: { name: "vean-doctor", version: "0.1.0" },
          workspaceFolders: [{ uri: rootUri, name: basename(projectRepo) }],
        },
        [
          lspMessage({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null }),
          lspMessage({ jsonrpc: "2.0", method: "exit", params: null }),
        ],
      ),
    );
  }
  if (probe && surfaceIncludes(surface, "mcp")) {
    checks.push(await probeMcpServer(runtimeRepo));
  }

  return { ok: checks.every((c) => c.status !== "fail"), checks };
}

export function formatDoctorReport(report: DoctorReport): string {
  const glyph = { pass: "OK", warn: "WARN", fail: "FAIL" } as const;
  return report.checks.map((c) => `${glyph[c.status]} ${c.name}: ${c.detail}`).join("\n");
}
