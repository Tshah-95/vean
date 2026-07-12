#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { RuntimeLayout, RuntimeResource } from "../src/runtime/layout-schema";
import { canonicalJson, canonicalSha256 } from "./harness/package-json";

const root = realpathSync(join(import.meta.dirname, ".."));

function bunExecutable(): string {
  if (process.env.VEAN_PACKAGE_BUN) return realpathSync(process.env.VEAN_PACKAGE_BUN);
  if (process.versions.bun) return realpathSync(process.execPath);
  const found = spawnSync("which", ["bun"], { encoding: "utf8" });
  if (found.status !== 0 || !found.stdout.trim()) {
    throw new Error("E_PACKAGE_CORE_COMPILER: Bun 1.3.14 not found");
  }
  return realpathSync(found.stdout.trim());
}

export type PackageCoreOptions = {
  outputRoot: string;
  projectRoot: string;
  sourceRoot?: string;
  buildEnvironment?: NodeJS.ProcessEnv;
};

function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function filesUnder(dir: string): string[] {
  const result: string[] = [];
  const visit = (current: string) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result.push(path);
    }
  };
  visit(dir);
  return result;
}

function run(argv: string[], cwd = root, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(argv[0] ?? "", argv.slice(1), { cwd, encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(`E_PACKAGE_CORE_COMMAND: ${argv.join(" ")}\n${result.stderr ?? ""}`);
  }
  return (result.stdout ?? "").trim();
}

function resourceClass(path: string): RuntimeResource["class"] {
  if (path === "core-build-manifest.json") return "compliance";
  if (path === "core/vean-core") return "core";
  if (path.startsWith("viewer/")) return "viewer";
  if (path.startsWith("drizzle/")) return "migration";
  if (path.startsWith("skills/")) return "skill";
  throw new Error(`E_RUNTIME_RESOURCE_UNCLASSIFIED: ${path}`);
}

function inventory(outputRoot: string): RuntimeResource[] {
  return filesUnder(outputRoot)
    .map((path) => relative(outputRoot, path).replaceAll("\\", "/"))
    .filter((path) => path !== "runtime-layout.json" && path !== "runtime-manifest.json")
    .map((path) => {
      const stat = statSync(join(outputRoot, path));
      const cls = resourceClass(path);
      return {
        id:
          path === "core/vean-core"
            ? "core.executable"
            : `${cls}.${path
                .replaceAll(/[^a-zA-Z0-9]+/g, ".")
                .replace(/^\.|\.$/g, "")
                .toLowerCase()}`,
        class: cls,
        relative_path: path,
        sha256: hashFile(join(outputRoot, path)),
        mode: stat.mode & 0o777,
        executable: path === "core/vean-core",
        requirement:
          cls === "compliance" ? ("distribution-only" as const) : ("startup-required" as const),
      };
    });
}

export function packageCore(options: PackageCoreOptions) {
  const sourceRoot = realpathSync(options.sourceRoot ?? root);
  const outputRoot = resolve(options.outputRoot);
  const projectRoot = resolve(options.projectRoot);
  const buildEnvironment = options.buildEnvironment ?? process.env;
  const bun = bunExecutable();
  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(join(outputRoot, "core"), { recursive: true });

  run([bun, "install", "--cwd", "viewer", "--frozen-lockfile"], sourceRoot, buildEnvironment);
  run([bun, "run", "viewer:build"], sourceRoot, buildEnvironment);

  const executable = join(outputRoot, "core", "vean-core");
  const compileArgv = [
    bun,
    "build",
    "--compile",
    "--target=bun-darwin-arm64",
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--no-compile-autoload-tsconfig",
    "--no-compile-autoload-package-json",
    "src/package-entry.ts",
    "--outfile",
    executable,
  ];
  run(compileArgv, sourceRoot, buildEnvironment);
  chmodSync(executable, 0o755);
  cpSync(join(sourceRoot, "viewer", "dist"), join(outputRoot, "viewer", "dist"), {
    recursive: true,
  });
  cpSync(join(sourceRoot, "drizzle"), join(outputRoot, "drizzle"), { recursive: true });
  cpSync(join(sourceRoot, ".agents", "skills"), join(outputRoot, "skills"), { recursive: true });

  const sourceInputs = [
    ...filesUnder(join(sourceRoot, "src")),
    join(sourceRoot, "package.json"),
    join(sourceRoot, "bun.lock"),
    join(sourceRoot, "viewer", "package.json"),
    join(sourceRoot, "viewer", "bun.lock"),
  ].map((path) => ({ path: relative(sourceRoot, path), sha256: hashFile(path) }));
  const sourceSha = run(["git", "rev-parse", "HEAD"], sourceRoot, buildEnvironment);
  const compilerVersion = run([bun, "--version"], sourceRoot, buildEnvironment);
  const inputManifest = {
    schema_version: "vean.core-build-input/1",
    source_sha: sourceSha,
    source_inputs: sourceInputs,
    compiler: {
      name: basename(bun),
      version: compilerVersion,
      sha256: hashFile(bun),
    },
    compile_argv: compileArgv.map((arg) =>
      arg === executable ? "$OUTPUT/core/vean-core" : arg === bun ? "$BUN" : arg,
    ),
    platform: "darwin",
    architecture: "arm64",
    deployment_target: "26.0",
    runtime_mode: "package",
  };
  const coreBuild = {
    schema_version: "vean.core-build/1",
    input_manifest: inputManifest,
    input_manifest_sha256: canonicalSha256(inputManifest),
    observed_executable_sha256: hashFile(executable),
    byte_reproducible: "requires-two-build-comparison",
  };
  writeFileSync(join(outputRoot, "core-build-manifest.json"), `${canonicalJson(coreBuild)}\n`);
  // The build receipt is lineage metadata, not a runtime resource.

  const resources = inventory(outputRoot);
  const runtimeManifest = {
    schema_version: "vean.runtime-manifest/1",
    runtime_mode: "package",
    source_sha: sourceSha,
    core_build: coreBuild,
    resources,
  };
  writeFileSync(join(outputRoot, "runtime-manifest.json"), `${canonicalJson(runtimeManifest)}\n`);
  const layout: RuntimeLayout = {
    schema_version: "vean.runtime-layout/1",
    mode: "package",
    package_root: outputRoot,
    project_root: projectRoot,
    development_checkout_root: null,
    manifest_relative_path: "runtime-manifest.json",
    resources,
  };
  writeFileSync(join(outputRoot, "runtime-layout.json"), `${canonicalJson(layout)}\n`);
  return {
    outputRoot,
    executable,
    layoutPath: join(outputRoot, "runtime-layout.json"),
    runtimeManifestPath: join(outputRoot, "runtime-manifest.json"),
    coreBuildPath: join(outputRoot, "core-build-manifest.json"),
    coreBuild,
    runtimeManifest,
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const result = packageCore({
    outputRoot: option("--out") ?? join(root, ".vean", "package-stage", "runtime"),
    projectRoot: option("--project") ?? join(root, ".vean", "package-project"),
  });
  console.log(JSON.stringify(result, null, 2));
}
