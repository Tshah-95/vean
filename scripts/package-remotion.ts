#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "./harness/package-json";

const repo = realpathSync(join(import.meta.dirname, ".."));
export const NODE_VERSION = "24.15.0";
export const NODE_ARCHIVE_SHA256 =
  "372331b969779ab5d15b949884fc6eaf88d5afe87bde8ba881d6400b9100ffc4";
export const CHROME_VERSION = "149.0.7790.0";
export const CHROME_ARCHIVE_SHA256 =
  "17ef152eba8ffcfebc42e25ab295eb040d8e62455cff7dfcc735b652456d6899";

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function command(program: string, args: string[]): void {
  const result = spawnSync(program, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `E_PACKAGE_REMOTION_COMMAND: ${program} ${args.join(" ")}\n${result.stderr ?? ""}`,
    );
  }
}

function output(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `E_PACKAGE_REMOTION_COMMAND: ${program} ${args.join(" ")}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim();
}

function relocateCompositor(directory: string): void {
  const names = new Set(readdirSync(directory));
  const files = [...names]
    .map((name) => join(directory, name))
    .filter((path) => output("file", ["-b", path]).includes("Mach-O"));
  for (const path of files) {
    const fileName = path.split("/").at(-1) ?? path;
    if (path.endsWith(".dylib")) {
      command("install_name_tool", ["-id", `@rpath/${fileName}`, path]);
    }
    const dependencies = output("otool", ["-L", path])
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0] ?? "")
      .filter(Boolean);
    for (const dependency of dependencies) {
      const name = dependency.split("/").at(-1) ?? dependency;
      if (names.has(name) && !dependency.startsWith("@loader_path/")) {
        command("install_name_tool", ["-change", dependency, `@loader_path/${name}`, path]);
      }
    }
  }
  for (const path of files) {
    command("codesign", ["--force", "--sign", "-", "--timestamp=none", path]);
  }
}

function download(url: string, path: string, expected: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  if (!existsSync(path)) command("curl", ["-fL", "--retry", "3", "-o", path, url]);
  const observed = hash(path);
  if (observed !== expected)
    throw new Error(`E_PACKAGE_DOWNLOAD_HASH: ${path} expected ${expected} got ${observed}`);
}

export type PackageRemotionOptions = {
  runtimeRoot: string;
  cacheRoot?: string;
};

export function packageRemotion(options: PackageRemotionOptions) {
  const runtimeRoot = resolve(options.runtimeRoot);
  const cacheRoot = resolve(options.cacheRoot ?? join(repo, ".vean", "package-cache"));
  const nodeArchive = join(cacheRoot, `node-v${NODE_VERSION}-darwin-arm64.tar.gz`);
  const chromeArchive = join(cacheRoot, `chrome-headless-shell-${CHROME_VERSION}-mac-arm64.zip`);
  download(
    `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    nodeArchive,
    NODE_ARCHIVE_SHA256,
  );
  download(
    `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/mac-arm64/chrome-headless-shell-mac-arm64.zip`,
    chromeArchive,
    CHROME_ARCHIVE_SHA256,
  );

  const nodeRoot = join(runtimeRoot, "node");
  const browserRoot = join(runtimeRoot, "browser");
  const remotionRoot = join(runtimeRoot, "remotion");
  rmSync(nodeRoot, { recursive: true, force: true });
  rmSync(browserRoot, { recursive: true, force: true });
  rmSync(remotionRoot, { recursive: true, force: true });
  mkdirSync(nodeRoot, { recursive: true });
  mkdirSync(browserRoot, { recursive: true });
  mkdirSync(remotionRoot, { recursive: true });
  command("tar", ["-xzf", nodeArchive, "--strip-components=1", "-C", nodeRoot]);
  const browserExtract = join(cacheRoot, `chrome-${CHROME_VERSION}-extract`);
  rmSync(browserExtract, { recursive: true, force: true });
  mkdirSync(browserExtract, { recursive: true });
  command("unzip", ["-q", chromeArchive, "-d", browserExtract]);
  cpSync(join(browserExtract, "chrome-headless-shell-mac-arm64"), browserRoot, {
    recursive: true,
    dereference: true,
  });
  rmSync(browserExtract, { recursive: true, force: true });

  command(realpathSync(process.env.VEAN_PACKAGE_BUN ?? process.execPath), [
    "install",
    "--cwd",
    join(repo, "remotion"),
    "--frozen-lockfile",
  ]);
  for (const path of [
    "package.json",
    "bun.lock",
    "remotion.config.ts",
    "tsconfig.json",
    "src",
    "node_modules",
  ]) {
    cpSync(join(repo, "remotion", path), join(remotionRoot, path), {
      recursive: true,
      dereference: true,
    });
  }

  const binaries = join(remotionRoot, "binaries");
  const compositor = join(repo, "remotion", "node_modules", "@remotion", "compositor-darwin-arm64");
  if (!existsSync(compositor)) throw new Error(`E_PACKAGE_REMOTION_HELPERS: ${compositor}`);
  cpSync(compositor, binaries, { recursive: true, dereference: true });
  relocateCompositor(binaries);
  for (const name of ["remotion", "ffmpeg", "ffprobe"] as const)
    chmodSync(join(binaries, name), 0o755);
  chmodSync(join(nodeRoot, "bin", "node"), 0o755);
  chmodSync(join(browserRoot, "chrome-headless-shell"), 0o755);

  const descriptor = {
    schema_version: "vean.packaged-remotion/1",
    node: {
      version: NODE_VERSION,
      archive_sha256: NODE_ARCHIVE_SHA256,
      executable: "node/bin/node",
      executable_sha256: hash(join(nodeRoot, "bin", "node")),
    },
    remotion: {
      version: "4.0.484",
      react_version: "19.2.7",
      lock_sha256: hash(join(repo, "remotion", "bun.lock")),
      cli: "remotion/node_modules/@remotion/cli/remotion-cli.js",
      entry: "remotion/src/index.ts",
    },
    browser: {
      version: CHROME_VERSION,
      archive_sha256: CHROME_ARCHIVE_SHA256,
      executable: "browser/chrome-headless-shell",
      executable_sha256: hash(join(browserRoot, "chrome-headless-shell")),
    },
    binaries_directory: "remotion/binaries",
    network_downloads_allowed: false,
  };
  writeFileSync(join(remotionRoot, "runtime.json"), `${canonicalJson(descriptor)}\n`);
  return descriptor;
}

export function buildPackagedRemotionArgv(
  runtimeRoot: string,
  entry: string,
  compositionId: string,
  outPath: string,
  renderArgs: string[],
): string[] {
  const root = resolve(runtimeRoot);
  return [
    join(root, "node", "bin", "node"),
    join(root, "remotion", "node_modules", "@remotion", "cli", "remotion-cli.js"),
    "render",
    entry,
    compositionId,
    outPath,
    ...renderArgs,
    `--browser-executable=${join(root, "browser", "chrome-headless-shell")}`,
    `--binaries-directory=${join(root, "remotion", "binaries")}`,
    "--chrome-mode=headless-shell",
    "--log=error",
  ];
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const runtimeRoot = option("--runtime") ?? join(repo, ".vean", "package-stage", "runtime");
  console.log(JSON.stringify(packageRemotion({ runtimeRoot }), null, 2));
}
