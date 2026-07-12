// The Remotion driver — vean's arm's-length bridge to the Remotion CLI, the
// SAME process-boundary pattern as `src/driver/melt.ts`. It shells out to the
// `remotion` BINARY (and `ffprobe`) as separate processes; vean never links
// Remotion, React, or any of its deps. The Remotion workspace (`remotion/`) has
// its own `package.json` and is treated exactly like `melt`/`ffmpeg`: a system
// dependency vean DRIVES, not a library it imports.
//
// It renders a composition to an ALPHA ProRes 4444 clip with the proven flags
// (every one load-bearing — see below), then ffprobes the produced file's
// pixel format and asserts the alpha plane survived.
//
// The exact command:
//   remotion render <entry> <compositionId> <out.mov> \
//     --codec=prores --prores-profile=4444 --image-format=png \
//     --pixel-format=yuva444p10le [--props='<json>'] [--frames=<start>-<end>]
//
// *** --image-format=png is REQUIRED. *** Without it Remotion uses jpeg
// intermediate frames, which CANNOT carry an alpha plane, and you silently get a
// pix_fmt with NO alpha (yuv422p…) — a bug invisible until the qtblend composite
// shows only the graphic and the footage underneath vanishes. The produced
// pix_fmt is yuva444p12le (ProRes 4444 is 12-bit native; the 10le request
// coerces to 12le) — it HAS an alpha plane, which is the thing that matters.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { runtimeChildEnvironment } from "../runtime/environment";
import { packageMode, resolveRuntimeResourcePath, runtimeResourceRoot } from "../runtime/layout";
import { resolveBin } from "./melt";

/** The repo root (two levels up from `src/driver/`). */
function repoRoot(): string {
  // import.meta.dir is `<repo>/src/driver`.
  return resolve(dirname(new URL(import.meta.url).pathname), "..", "..");
}

/** The default Remotion entry — `<repo>/remotion/src/index.ts`. */
export function defaultRemotionEntry(): string {
  const packaged = runtimeResourceRoot("remotion");
  return packaged
    ? resolveRuntimeResourcePath("remotion/src/index.ts")
    : join(repoRoot(), "remotion", "src", "index.ts");
}

/** Resolve the Remotion binary: the env override, then the workspace's pinned
 *  `.bin/remotion`. We deliberately do NOT fall back to a global `remotion` —
 *  the workspace pin is the license-/version-correct one. Returns `null` if no
 *  binary is found, so the caller can return a typed remediation. */
export function resolveRemotionBin(override?: string): string | null {
  if (packageMode()) return resolveRuntimeResourcePath("node/bin/node");
  if (override) return override;
  const env = process.env.VEAN_REMOTION_BIN;
  if (env) return env;
  const local = join(repoRoot(), "remotion", "node_modules", ".bin", "remotion");
  return existsSync(local) ? local : null;
}

/** Resolve the Remotion workspace (entry + binary) for a PROJECT repo. Prefers
 *  the project's OWN `<repo>/remotion/` workspace — so per-project compositions
 *  and brand tokens (e.g. carlo) stay OUT of public vean — falling back to vean's
 *  bundled workspace when the project has none. The binary is the resolved
 *  workspace's own pinned install (or the env override). */
export function remotionWorkspaceForRepo(repo: string): { entry: string; bin: string | null } {
  if (packageMode()) {
    const manifest = join(repo, "vean.remotion-workspace.json");
    if (existsSync(manifest)) {
      return { entry: validateRemotionWorkspace(repo), bin: resolveRemotionBin() };
    }
    return { entry: defaultRemotionEntry(), bin: resolveRemotionBin() };
  }
  const projectEntry = join(repo, "remotion", "src", "index.ts");
  if (existsSync(projectEntry)) {
    const projectBin = join(repo, "remotion", "node_modules", ".bin", "remotion");
    return {
      entry: projectEntry,
      bin: process.env.VEAN_REMOTION_BIN ?? (existsSync(projectBin) ? projectBin : null),
    };
  }
  return { entry: defaultRemotionEntry(), bin: resolveRemotionBin() };
}

function workspaceFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === ".git" || name === "out") continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const resolved = realpathSync(path);
        if (!resolved.startsWith(`${root}/`)) throw new Error(`escaping link: ${path}`);
      } else if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result.push(path);
    }
  };
  visit(root);
  return result;
}

export function remotionWorkspaceDependencyHash(workspace: string): string {
  const root = realpathSync(workspace);
  const hash = createHash("sha256");
  for (const path of workspaceFiles(root)) {
    if (path.endsWith("vean.remotion-workspace.json")) continue;
    hash.update(path.slice(root.length + 1));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function validateRemotionWorkspace(projectRoot: string): string {
  try {
    const root = realpathSync(projectRoot);
    const manifestPath = join(root, "vean.remotion-workspace.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    if (manifest.schema_version !== "vean.remotion-workspace/1") throw new Error("schema");
    if (
      manifest.node !== "24.15.0" ||
      manifest.remotion !== "4.0.484" ||
      manifest.react !== "19.2.7"
    ) {
      throw new Error("version");
    }
    if (typeof manifest.entry !== "string" || !manifest.entry) throw new Error("entry");
    const entry = realpathSync(join(root, manifest.entry));
    if (!entry.startsWith(`${root}/`) || !statSync(entry).isFile())
      throw new Error("entry containment");
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
    };
    if (
      packageJson.dependencies?.remotion !== "4.0.484" ||
      packageJson.dependencies?.react !== "19.2.7"
    ) {
      throw new Error("dependency versions");
    }
    for (const key of ["preinstall", "install", "postinstall", "prepare", "prepublish"]) {
      if (packageJson.scripts?.[key]) throw new Error(`lifecycle script ${key}`);
    }
    if (existsSync(join(root, "node_modules", ".bin")))
      throw new Error("project-local executable directory");
    for (const path of workspaceFiles(root).filter((path) => /\.[cm]?[jt]sx?$/.test(path))) {
      const source = readFileSync(path, "utf8");
      if (/\b(?:import|export)\s*(?:\(|[^;]*?from\s*)["']https?:\/\//.test(source)) {
        throw new Error(`network import ${path}`);
      }
    }
    const dependencyHash = remotionWorkspaceDependencyHash(root);
    if (manifest.dependency_tree_sha256 !== dependencyHash) throw new Error("dependency hash");
    return entry;
  } catch (error) {
    throw new RemotionError(
      "remotion-workspace",
      [],
      2,
      `E_REMOTION_WORKSPACE_UNSUPPORTED: ${String(error)}`,
    );
  }
}

export type RemotionRenderOpts = {
  /** Path to the remotion entry (default: <repo>/remotion/src/index.ts). */
  entry?: string;
  /** Resolved props object (already merged with defaults by the caller). */
  props?: Record<string, unknown>;
  /** Inclusive [start, end] frame range; omit for the whole composition. */
  frameRange?: [number, number];
  /** Override the remotion binary (default: the workspace's pinned binary). */
  bin?: string;
};

export type RemotionRenderResult = {
  /** Absolute path to the produced .mov. */
  outPath: string;
  /** ffprobe-read pixel format of the produced file (e.g. "yuva444p12le"). */
  pixFmt: string;
  /** True iff `pixFmt` contains "yuva" (the alpha plane survived). */
  hasAlpha: boolean;
  /** Subprocess exit code (0 = success). */
  code: number;
  /** Captured stderr (Remotion is chatty; surfaced for debugging). */
  stderr: string;
};

/** Thrown when the remotion (or ffprobe) binary exits nonzero. Carries the full
 *  command line + captured stderr so a failed render is debuggable from the
 *  message alone — the same shape as `MeltError`. */
export class RemotionError extends Error {
  constructor(
    readonly bin: string,
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(
      `${bin} exited ${code}\n  command: ${bin} ${args.join(" ")}\n${
        stderr.trim() ? `  stderr:\n${indent(stderr.trim())}` : "  stderr: <empty>"
      }`,
    );
    this.name = "RemotionError";
  }
}

function indent(s: string): string {
  return s
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

async function spawnCapture(
  bin: string,
  args: string[],
  cwd?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([bin, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(cwd ? { cwd } : {}),
    env: runtimeChildEnvironment(),
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Build the EXACT argv for a Remotion render. Pure — no I/O — so it can be
 *  unit-tested without spawning a subprocess. Every flag here is load-bearing
 *  (see the file header on --image-format=png in particular). */
export function buildRenderArgs(
  entry: string,
  compositionId: string,
  outPath: string,
  opts: { props?: Record<string, unknown>; frameRange?: [number, number] } = {},
): string[] {
  const args = [
    "render",
    entry,
    compositionId,
    outPath,
    "--codec=prores",
    "--prores-profile=4444",
    // REQUIRED for alpha — see the header. Do not remove.
    "--image-format=png",
    "--pixel-format=yuva444p10le",
  ];
  if (opts.props && Object.keys(opts.props).length > 0) {
    args.push(`--props=${JSON.stringify(opts.props)}`);
  }
  if (opts.frameRange) {
    const [start, end] = opts.frameRange;
    args.push(`--frames=${start}-${end}`);
  }
  return args;
}

export function buildPackagedRenderCommand(
  entry: string,
  compositionId: string,
  outPath: string,
  opts: { props?: Record<string, unknown>; frameRange?: [number, number] } = {},
): { bin: string; args: string[]; cwd: string } {
  const root = runtimeResourceRoot("remotion");
  if (!root)
    throw new RemotionError(
      "remotion",
      [],
      2,
      "E_RUNTIME_RESOURCE_MISSING: packaged Remotion root",
    );
  const runtimeRoot = resolve(root, "..");
  const bin = resolveRuntimeResourcePath("node/bin/node");
  const cli = resolveRuntimeResourcePath("remotion/node_modules/@remotion/cli/remotion-cli.js");
  const browser = resolveRuntimeResourcePath("browser/chrome-headless-shell");
  const ffmpeg = resolveRuntimeResourcePath("remotion/binaries/ffmpeg");
  resolveRuntimeResourcePath("remotion/binaries/ffprobe");
  const args = [
    cli,
    ...buildRenderArgs(entry, compositionId, resolve(outPath), opts),
    `--browser-executable=${browser}`,
    `--binaries-directory=${dirname(ffmpeg)}`,
    "--chrome-mode=headless-shell",
    "--log=error",
  ];
  return { bin, args, cwd: join(runtimeRoot, "remotion") };
}

/** ffprobe the pixel format of a produced clip — the alpha check. Reuses the
 *  same ffprobe call shape as the melt driver. Throws `RemotionError` on a
 *  nonzero ffprobe exit. */
export async function probePixFmt(path: string): Promise<string> {
  const args = [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=pix_fmt",
    "-of",
    "default=nw=1",
    path,
  ];
  const bin = resolveBin("ffprobe");
  const { code, stdout, stderr } = await spawnCapture(bin, args);
  if (code !== 0) throw new RemotionError(bin, args, code, stderr);
  return stdout.trim().replace(/^pix_fmt=/, "");
}

/** Render a Remotion composition to an alpha ProRes 4444 clip, then ffprobe its
 *  pixel format and report whether the alpha plane survived. The caller (the
 *  export-only `bakeOverlaysForExport`, invoked by the `render.video` action)
 *  decides whether `hasAlpha === false` is a hard failure — the driver always
 *  returns the probed truth, never hides it.
 *
 *  A missing Remotion binary or a nonzero render exit throws `RemotionError`. */
export async function renderComposition(
  compositionId: string,
  outPath: string,
  opts: RemotionRenderOpts = {},
): Promise<RemotionRenderResult> {
  // Absolute path: the render subprocess runs with cwd = the workspace root
  // (below), so a caller-relative binary path must be pinned before spawn.
  const rawBin = resolveRemotionBin(opts.bin);
  const bin = rawBin ? resolve(rawBin) : null;
  if (!bin) {
    throw new RemotionError(
      "remotion",
      [],
      127,
      "remotion binary not found; run `bun install` in remotion/ (or set VEAN_REMOTION_BIN)",
    );
  }
  // Absolute paths: the render subprocess runs with cwd = the workspace root
  // (below), so caller-relative paths must be pinned before the cwd changes.
  const entry = resolve(opts.entry ?? defaultRemotionEntry());
  if (!existsSync(entry)) {
    throw new RemotionError("remotion", [entry], 2, `remotion entry not found: ${entry}`);
  }
  const renderOpts = {
    props: opts.props,
    frameRange: opts.frameRange,
  };
  const packagedCommand = packageMode()
    ? buildPackagedRenderCommand(entry, compositionId, resolve(outPath), renderOpts)
    : null;
  const args =
    packagedCommand?.args ?? buildRenderArgs(entry, compositionId, resolve(outPath), renderOpts);
  // Run from the workspace root (entry is <workspace>/src/index.ts) so Remotion
  // resolves its root — and therefore public/ (staticFile) — against the
  // workspace, not wherever vean happened to be invoked.
  const commandBin = packagedCommand?.bin ?? bin;
  const workspaceDir = packagedCommand?.cwd ?? resolve(dirname(entry), "..");
  const { code, stderr } = await spawnCapture(commandBin, args, workspaceDir);
  if (code !== 0) throw new RemotionError(commandBin, args, code, stderr);

  const pixFmt = await probePixFmt(outPath);
  return {
    outPath,
    pixFmt,
    hasAlpha: /yuva/.test(pixFmt),
    code,
    stderr,
  };
}
