#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { RuntimeLayout, RuntimeResource } from "../src/runtime/layout-schema";
import { canonicalJson, canonicalSha256 } from "./harness/package-json";
import { type AppReceipt, type DistributionReceipt, candidateId } from "./harness/package-lineage";
import { hashFile, treeManifest } from "./harness/package-manifest";
import {
  generateRequiredClosurePolicy,
  loadApprovedH07Lineage,
} from "./harness/required-closure-policy";
import { packageCompliance } from "./package-compliance";
import { packageCore } from "./package-core";
import { packageRemotion } from "./package-remotion";

const repo = realpathSync(join(import.meta.dirname, ".."));
const stage = join(repo, ".vean", "package-stage", "runtime");
const buildInput = join(repo, "app", "src-tauri", "package-runtime");
const pending = join(repo, ".vean", "package-evidence", ".pending-h08");

function run(
  program: string,
  args: string[],
  cwd = repo,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(program, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `E_PACKAGE_CANDIDATE_COMMAND: ${program} ${args.join(" ")}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout.trim();
}

function capture(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(
      `E_PACKAGE_CANDIDATE_COMMAND: ${program} ${args.join(" ")}\n${result.stderr ?? ""}`,
    );
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function bun(): string {
  return process.versions.bun
    ? realpathSync(process.execPath)
    : realpathSync(run("which", ["bun"]));
}

function classFor(path: string): RuntimeResource["class"] {
  if (path.startsWith("core/")) return "core";
  if (path.startsWith("viewer/")) return "viewer";
  if (path.startsWith("drizzle/")) return "migration";
  if (path.startsWith("skills/")) return "skill";
  if (path.startsWith("sidecars/bin/")) return "renderer-executable";
  if (path.startsWith("sidecars/lib/"))
    return path.includes("/mlt/") ? "renderer-data" : "renderer-library";
  if (path.startsWith("sidecars/")) return "renderer-data";
  if (path.startsWith("node/")) return "node";
  if (path.startsWith("browser/")) return "browser";
  if (path.startsWith("remotion/src/")) return "composition";
  if (path.startsWith("remotion/")) return "remotion";
  if (path.startsWith("compliance/") || path === "core-build-manifest.json") return "compliance";
  throw new Error(`E_RUNTIME_RESOURCE_UNCLASSIFIED: ${path}`);
}

const fixedIds: Record<string, string> = {
  "core/vean-core": "core.executable",
  "sidecars/bin/melt-aarch64-apple-darwin": "renderer.melt",
  "sidecars/bin/ffmpeg-aarch64-apple-darwin": "renderer.ffmpeg",
  "sidecars/bin/ffprobe-aarch64-apple-darwin": "renderer.ffprobe",
  "sidecars/lib/mlt/.vean-runtime": "renderer.mlt-modules",
  "sidecars/share/mlt/.vean-runtime": "renderer.mlt-data",
  "sidecars/share/mlt/profiles/.vean-runtime": "renderer.mlt-profiles",
  "sidecars/share/mlt/presets/.vean-runtime": "renderer.mlt-presets",
};

function layoutResources(
  entries: ReturnType<typeof generateRequiredClosurePolicy>["policy"]["entries"],
): RuntimeResource[] {
  return entries
    .filter((entry) => entry.type === "file" && entry.sha256)
    .map((entry) => ({
      id:
        fixedIds[entry.relative_path] ??
        `runtime.${createHash("sha256").update(entry.relative_path).digest("hex").slice(0, 32)}`,
      class: classFor(entry.relative_path),
      relative_path: entry.relative_path,
      sha256: entry.sha256 ?? "",
      mode: entry.mode,
      executable: (entry.mode & 0o111) !== 0,
      requirement: entry.requirement,
    }));
}

function sign(path: string): void {
  run("codesign", ["--force", "--sign", "-", "--timestamp=none", path]);
  run("codesign", ["--verify", "--strict", path]);
}

function signature(path: string) {
  const detail = capture("codesign", ["-d", "--verbose=4", "-r-", path]);
  if (!/Signature=adhoc/.test(detail)) throw new Error(`E_SIGNATURE_NOT_ADHOC: ${path}`);
  if (/TeamIdentifier=(?!not set)/.test(detail)) throw new Error(`E_SIGNATURE_TEAM_ID: ${path}`);
  return {
    path,
    cdhash: detail.match(/CDHash=([a-fA-F0-9]+)/)?.[1] ?? null,
    designated_requirement: detail.match(/designated => (.+)/)?.[1] ?? null,
    signature: "adhoc",
    team_identifier: null,
    timestamp: null,
    notarization_ticket: null,
  };
}

function assertCleanSource(): string {
  const status = run("git", ["status", "--porcelain"]);
  if (status) throw new Error(`E_PACKAGE_SOURCE_DIRTY:\n${status}`);
  return run("git", ["rev-parse", "HEAD"]);
}

async function main() {
  const sourceSha = assertCleanSource();
  const h07 = loadApprovedH07Lineage(repo);
  rmSync(pending, { recursive: true, force: true });
  mkdirSync(pending, { recursive: true });
  packageCore({ outputRoot: stage, projectRoot: join(repo, ".vean", "package-project") });
  rmSync(join(stage, "runtime-layout.json"), { force: true });
  rmSync(join(stage, "runtime-manifest.json"), { force: true });
  run(bun(), ["scripts/bundle-sidecars.ts", "--stage", stage]);
  packageRemotion({ runtimeRoot: stage });
  await packageCompliance(stage);

  // Sign the exact nested runtime closure before freezing its hashes.
  const preliminary = generateRequiredClosurePolicy(stage, sourceSha, h07);
  for (const entry of preliminary.policy.entries.filter((entry) => entry.signable)) {
    sign(join(stage, entry.relative_path));
  }
  const closure = generateRequiredClosurePolicy(stage, sourceSha, h07);
  const closurePath = join(pending, "required-closure-policy.json");
  writeFileSync(closurePath, `${canonicalJson(closure.policy)}\n`);

  const resources = layoutResources(closure.policy.entries);
  const runtimeManifest = {
    schema_version: "vean.runtime-manifest/1" as const,
    source_sha: sourceSha,
    runtime_mode: "package" as const,
    h07,
    required_closure_policy_sha256: hashFile(closurePath),
    resources: closure.policy.entries,
  };
  const runtimeManifestPath = join(stage, "runtime-manifest.json");
  writeFileSync(runtimeManifestPath, `${canonicalJson(runtimeManifest)}\n`);
  const layout: RuntimeLayout = {
    schema_version: "vean.runtime-layout/1",
    mode: "package",
    package_root: stage,
    project_root: join(repo, ".vean", "package-project"),
    development_checkout_root: null,
    manifest_relative_path: "runtime-manifest.json",
    resources,
  };
  writeFileSync(join(stage, "runtime-layout.json"), `${canonicalJson(layout)}\n`);

  rmSync(buildInput, { recursive: true, force: true });
  cpSync(stage, buildInput, { recursive: true });
  const tauriOverlay = {
    bundle: {
      targets: ["app"],
      externalBin: [],
      resources: ["package-runtime/"],
      macOS: { minimumSystemVersion: "26.0" },
    },
  };
  run(
    bun(),
    [
      "run",
      "--cwd",
      "app",
      "tauri:build",
      "--",
      "--bundles",
      "app",
      "--features",
      "package-runtime",
      "--no-sign",
      "--ci",
      "--config",
      JSON.stringify(tauriOverlay),
    ],
    repo,
    { ...process.env, VEAN_HARNESS_WDIO: "1", WDIO_EMBEDDED_SERVER: "true" },
  );
  const app = join(repo, "app", "src-tauri", "target", "release", "bundle", "macos", "vean.app");
  if (!existsSync(app)) throw new Error(`E_PACKAGE_APP_MISSING: ${app}`);
  const packagedRuntime = join(app, "Contents", "Resources", "package-runtime");
  if (treeManifest(packagedRuntime).tree_sha256 !== treeManifest(stage).tree_sha256) {
    throw new Error("E_PACKAGE_RUNTIME_COPY_MISMATCH");
  }
  const appBinary = join(app, "Contents", "MacOS", "vean-app");
  const strings = run("strings", [appBinary]);
  if (/tauri_plugin_wdio|WDIO_EMBEDDED_SERVER/.test(strings)) {
    throw new Error("E_PACKAGE_RELEASE_INSTRUMENTATION");
  }
  sign(appBinary);
  run("codesign", ["--force", "--sign", "-", "--timestamp=none", app]);
  run("codesign", ["--verify", "--deep", "--strict", app]);
  const signatures = [
    ...closure.policy.entries
      .filter((entry) => entry.signable)
      .map((entry) => signature(join(packagedRuntime, entry.relative_path))),
    signature(appBinary),
    signature(app),
  ];
  const appTree = treeManifest(app);
  const appReceipt: AppReceipt = {
    schema_version: "vean.app-receipt/1",
    app_name: "vean.app",
    app_tree_sha256: appTree.tree_sha256,
    runtime_manifest_sha256: hashFile(join(packagedRuntime, "runtime-manifest.json")),
    closure_policy_sha256: hashFile(closurePath),
    signatures: signatures.map((entry) => ({ ...entry, path: relative(app, entry.path) || "." })),
    signature_kind: "adhoc",
  };
  const appReceiptPath = join(pending, "app-receipt.json");
  writeFileSync(appReceiptPath, `${canonicalJson(appReceipt)}\n`);
  writeFileSync(join(pending, "app-tree-manifest.json"), `${canonicalJson(appTree)}\n`);

  const dmgRoot = join(repo, ".vean", "package-stage", "dmg-root");
  rmSync(dmgRoot, { recursive: true, force: true });
  mkdirSync(dmgRoot, { recursive: true });
  cpSync(app, join(dmgRoot, "vean.app"), { recursive: true });
  const dmg = join(pending, "Vean-H08.dmg");
  run("hdiutil", [
    "create",
    "-quiet",
    "-fs",
    "HFS+",
    "-format",
    "UDZO",
    "-volname",
    "Vean H08",
    "-srcfolder",
    dmgRoot,
    dmg,
  ]);
  const distribution: DistributionReceipt = {
    schema_version: "vean.distribution-receipt/1",
    dmg_name: basename(dmg),
    dmg_sha256: hashFile(dmg),
    app_receipt_sha256: hashFile(appReceiptPath),
    runtime_manifest_sha256: appReceipt.runtime_manifest_sha256,
    closure_policy_sha256: appReceipt.closure_policy_sha256,
    h07_sha256: canonicalSha256(h07),
    lineage_test_sha256: hashFile(join(repo, "tests", "package-lineage.test.ts")),
    mutation_policy_sha256: hashFile(
      join(repo, "artifacts", "specs", "harness-scenarios", "package.json"),
    ),
  };
  distribution.candidate_id = candidateId(distribution);
  const distributionPath = join(pending, "distribution-receipt.json");
  writeFileSync(distributionPath, `${canonicalJson(distribution)}\n`);
  const finalDir = join(repo, ".vean", "package-evidence", distribution.candidate_id, "build");
  rmSync(finalDir, { recursive: true, force: true });
  mkdirSync(resolve(finalDir, ".."), { recursive: true });
  renameSync(pending, finalDir);
  chmodSync(finalDir, 0o700);
  console.log(
    JSON.stringify(
      {
        candidate_id: distribution.candidate_id,
        lineage: join(finalDir, "distribution-receipt.json"),
      },
      null,
      2,
    ),
  );
}

if (import.meta.main) await main();
