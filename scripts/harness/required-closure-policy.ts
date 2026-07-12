import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { canonicalJson, canonicalSha256 } from "./package-json";

export type Requirement = "startup-required" | "operation-lazy" | "distribution-only";
export type H07Lineage = {
  fixture_manifest_sha256: string;
  semantic_oracle_version: string;
  semantic_oracle_sha256: string;
  runtime_matrix_sha256: string;
  expected_output_set_sha256: string;
};

function hashBytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function command(program: string, args: string[], allowFailure = false): string {
  const result = spawnSync(program, args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure)
    throw new Error(`E_CLOSURE_TOOL: ${program} ${args.join(" ")}\n${result.stderr ?? ""}`);
  return result.status === 0 ? result.stdout.trim() : "";
}

function allPaths(root: string): string[] {
  const paths: string[] = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      paths.push(path);
      if (lstatSync(path).isDirectory()) visit(path);
    }
  };
  visit(root);
  return paths;
}

export function classifyRequirement(path: string): Requirement {
  if (path.startsWith("compliance/") || path === "core-build-manifest.json")
    return "distribution-only";
  if (
    path.startsWith("core/") ||
    path.startsWith("viewer/") ||
    path.startsWith("drizzle/") ||
    path.startsWith("skills/")
  )
    return "startup-required";
  return "operation-lazy";
}

export function isAppleSystemDependency(path: string): boolean {
  return path.startsWith("/System/Library/") || path.startsWith("/usr/lib/");
}

export function expandDyldToken(
  dependency: string,
  loader: string,
  executable: string,
  rpaths: string[],
): string[] {
  const expandBase = (value: string) =>
    value
      .replaceAll("@loader_path", dirname(loader))
      .replaceAll("@executable_path", dirname(executable));
  if (dependency.startsWith("@loader_path") || dependency.startsWith("@executable_path")) {
    return [resolve(expandBase(dependency))];
  }
  if (dependency.startsWith("@rpath/")) {
    const suffix = dependency.slice("@rpath/".length);
    return rpaths.map((rpath) => resolve(expandBase(rpath), suffix));
  }
  if (dependency.startsWith("./") || !dependency.includes("/")) {
    return [resolve(dirname(loader), dependency)];
  }
  return [dependency];
}

function macho(path: string): boolean {
  const magic = readFileSync(path).subarray(0, 4).toString("hex");
  return new Set(["cffaedfe", "feedfacf", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]).has(
    magic,
  );
}

function machoDetails(path: string, runtimeRoot: string, inventoryPaths: Set<string>) {
  const architectures = command("lipo", ["-archs", path]).split(/\s+/).filter(Boolean);
  if (!architectures.includes("arm64"))
    throw new Error(`E_CLOSURE_ARCH: ${relative(runtimeRoot, path)}`);
  const details = command("otool", ["-l", path]);
  const hasInstallId = details.includes("cmd LC_ID_DYLIB");
  const load = command("otool", ["-L", path]);
  const dependencies = load
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean)
    .filter((_dependency, index) => !(hasInstallId && index === 0));
  const rpaths = [...details.matchAll(/cmd LC_RPATH[\s\S]*?path (\S+) \(offset/g)].map(
    (match) => match[1] ?? "",
  );
  const build = command("vtool", ["-show-build", path], true);
  const minos = build.match(/minos (\S+)/)?.[1] ?? "unknown";
  const deploymentMajor = Number.parseInt(minos.split(".")[0] ?? "", 10);
  if (!Number.isFinite(deploymentMajor) || deploymentMajor > 26) {
    throw new Error(`E_CLOSURE_DEPLOYMENT_TARGET: ${relative(runtimeRoot, path)} -> ${minos}`);
  }
  if (
    relative(runtimeRoot, path) === "core/vean-core" &&
    dependencies.some((dependency) =>
      /(?:libmlt|libavcodec|libavformat|libavutil)/i.test(dependency),
    )
  ) {
    throw new Error("E_CLOSURE_FORBIDDEN_LINK: core/vean-core");
  }
  const executable = path.includes("/browser/")
    ? join(runtimeRoot, "browser", "chrome-headless-shell")
    : path.includes("/sidecars/")
      ? join(runtimeRoot, "sidecars", "bin", "melt-aarch64-apple-darwin")
      : path;
  for (const dependency of dependencies) {
    if (isAppleSystemDependency(dependency)) continue;
    if (isAbsolute(dependency))
      throw new Error(`E_CLOSURE_ABSOLUTE_LOAD: ${relative(runtimeRoot, path)} -> ${dependency}`);
    const candidates = [
      ...new Set(
        expandDyldToken(dependency, path, executable, rpaths).filter((candidate) =>
          inventoryPaths.has(candidate),
        ),
      ),
    ];
    if (candidates.length === 0)
      throw new Error(`E_CLOSURE_UNRESOLVED: ${relative(runtimeRoot, path)} -> ${dependency}`);
    if (candidates.length > 1)
      throw new Error(`E_CLOSURE_AMBIGUOUS: ${relative(runtimeRoot, path)} -> ${dependency}`);
    if (!candidates[0]?.startsWith(runtimeRoot)) throw new Error(`E_CLOSURE_ESCAPE: ${dependency}`);
  }
  return { architectures, deployment_target: minos, linked_dylibs: dependencies, rpaths };
}

export function generateRequiredClosurePolicy(
  runtimeRoot: string,
  sourceSha: string,
  h07: H07Lineage,
) {
  const root = realpathSync(runtimeRoot);
  const paths = allPaths(root);
  for (const path of paths) {
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) continue;
    const target = readlinkSync(path);
    if (isAbsolute(target)) {
      throw new Error(`E_CLOSURE_SYMLINK_ABSOLUTE: ${relative(root, path)}`);
    }
    const resolved = realpathSync(path);
    if (!resolved.startsWith(`${root}/`)) {
      throw new Error(`E_CLOSURE_SYMLINK_ESCAPE: ${relative(root, path)}`);
    }
  }
  const canonicalPaths = new Set(paths.map((path) => realpathSync(path)));
  const entries = paths.map((path) => {
    const stat = lstatSync(path);
    const relativePath = relative(root, path).replaceAll("\\", "/");
    const base = {
      relative_path: relativePath,
      type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file",
      mode: stat.mode & 0o777,
      requirement: classifyRequirement(relativePath),
      symlink_target: stat.isSymbolicLink() ? readlinkSync(path) : null,
      sha256: stat.isFile()
        ? hashBytes(readFileSync(path))
        : stat.isSymbolicLink()
          ? hashBytes(readlinkSync(path))
          : null,
    };
    return stat.isFile() && macho(path)
      ? { ...base, signable: true, macho: machoDetails(path, root, canonicalPaths) }
      : { ...base, signable: false, macho: null };
  });
  const appleAllowlist = [
    "/System/Library/Frameworks/",
    "/System/Library/PrivateFrameworks/",
    "/usr/lib/",
  ];
  const policy = {
    schema_version: "vean.required-closure-policy/1",
    source_sha: sourceSha,
    h07,
    h07_sha256: canonicalSha256(h07),
    apple_system_allowlist: appleAllowlist,
    apple_system_allowlist_sha256: canonicalSha256(appleAllowlist),
    entries,
  };
  return { policy, sha256: canonicalSha256(policy) };
}

export function verifyRequiredClosurePolicy(
  runtimeRoot: string,
  policy: ReturnType<typeof generateRequiredClosurePolicy>["policy"],
): void {
  const regenerated = generateRequiredClosurePolicy(
    runtimeRoot,
    policy.source_sha,
    policy.h07,
  ).policy;
  const expected = new Map(policy.entries.map((entry) => [entry.relative_path, entry]));
  const observed = new Map(regenerated.entries.map((entry) => [entry.relative_path, entry]));
  for (const [path, entry] of expected) {
    const actual = observed.get(path);
    if (!actual) throw new Error(`E_CLOSURE_REQUIRED_MISSING: ${path}`);
    if (canonicalJson(actual) !== canonicalJson(entry)) {
      throw new Error(`E_CLOSURE_REQUIRED_MISMATCH: ${path}`);
    }
  }
  for (const path of observed.keys()) {
    if (!expected.has(path)) throw new Error(`E_CLOSURE_UNCLASSIFIED_EXTRA: ${path}`);
  }
}

export function writeRequiredClosurePolicy(
  path: string,
  runtimeRoot: string,
  sourceSha: string,
  h07: H07Lineage,
) {
  const result = generateRequiredClosurePolicy(runtimeRoot, sourceSha, h07);
  writeFileSync(path, `${canonicalJson(result.policy)}\n`);
  return result;
}

function hashFile(path: string): string {
  return hashBytes(readFileSync(path));
}

export function loadApprovedH07Lineage(repoRoot: string): H07Lineage {
  const fixture = join(repoRoot, "corpus", "harness", "media", "manifest.json");
  const oracle = join(repoRoot, "corpus", "harness", "media", "candidate-goldens", "manifest.json");
  const matrix = join(repoRoot, "artifacts", "specs", "media-runtime-matrix.json");
  const goldenPolicy = join(repoRoot, "artifacts", "specs", "media-golden-policy.json");
  for (const path of [matrix, goldenPolicy]) {
    const value = JSON.parse(readFileSync(path, "utf8")) as { status?: string };
    if (!value.status || value.status === "draft")
      throw new Error(`E_H07_LINEAGE_DRAFT: ${basename(path)}`);
  }
  const oracleJson = JSON.parse(readFileSync(oracle, "utf8")) as { schema_version?: string };
  return {
    fixture_manifest_sha256: hashFile(fixture),
    semantic_oracle_version: oracleJson.schema_version ?? "unknown",
    semantic_oracle_sha256: hashFile(oracle),
    runtime_matrix_sha256: hashFile(matrix),
    expected_output_set_sha256: hashFile(goldenPolicy),
  };
}
