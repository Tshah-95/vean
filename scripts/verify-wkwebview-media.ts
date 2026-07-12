#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createFixture, hashFile } from "./harness/fixture";
import { verifyExternalMediaEvidence } from "./harness/media-domain-truth";
import { runSelfUnderSupervisor } from "./harness/supervisor";

const repo = resolve(import.meta.dirname, "..");
const expectedManifestSha = "7e8a9684ccd86de9af5564636401f424e5c3709be4eca9ad305e57987aa81cd5";
if (process.platform !== "darwin") throw new Error("E_H07_WKWEBVIEW_REQUIRES_MACOS_GUEST");
if (process.env.VEAN_MACOS_RUNNER_CLASS !== "dedicated") {
  throw new Error("E_H07_WKWEBVIEW_REQUIRES_DEDICATED_RUNNER");
}
if (process.env.VEAN_HARNESS_SUPERVISED !== "1") {
  await runSelfUnderSupervisor(import.meta.path, process.argv.slice(2));
}

const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const run = (command: string[], env: Record<string, string> = {}) => {
  const result = Bun.spawnSync(command, {
    cwd: repo,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed (${result.exitCode})\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.toString().trim();
};
const runMaybe = (command: string[]) => {
  const result = Bun.spawnSync(command, { cwd: repo, stdout: "pipe", stderr: "pipe" });
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
};
const valueAfter = (flag: string) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const manifestPath = join(repo, "corpus/harness/media/manifest.json");
if (hash(manifestPath) !== expectedManifestSha)
  throw new Error("E_H07_WK_FIXTURE_MANIFEST_LINEAGE");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  entries: Array<{ id: string; file: string; relative_path: string; source_sha256: string }>;
};
for (const entry of manifest.entries) {
  const path = resolve(dirname(manifestPath), entry.relative_path);
  if (hash(path) !== entry.source_sha256) throw new Error(`E_H07_WK_FIXTURE_DRIFT:${entry.id}`);
}
const policyPaths = [
  "artifacts/specs/media-runtime-matrix.json",
  "artifacts/specs/media-golden-policy.json",
  "artifacts/specs/media-performance-policy.json",
];
const policies = policyPaths.map((path) => JSON.parse(readFileSync(join(repo, path), "utf8")));
const policySha256s = Object.fromEntries(
  policies.map((policy, index) => [
    policy.policy_id,
    hash(join(repo, policyPaths[index] as string)),
  ]),
);
const matrix = policies[0] as {
  required_cells: Array<{ id: string; wkwebview: string; source: string; derived: string }>;
};

const sourceSha =
  runMaybe(["git", "config", "--get", "vean.sourceCommit"]) ?? run(["git", "rev-parse", "HEAD"]);
const treeHash = run(["git", "rev-parse", "HEAD^{tree}"]);
if (run(["git", "status", "--porcelain"]) !== "") throw new Error("E_H07_WK_SOURCE_DIRTY");
const developerCanary = join(repo, ".vean/harness/developer-state-canary");
mkdirSync(dirname(developerCanary), { recursive: true });
if (!Bun.file(developerCanary).size) writeFileSync(developerCanary, "h07-developer-canary\n");
const developerCanaryHash = hashFile(developerCanary);
const fixture = await createFixture({ sourceSha, developerCanary });
const outputRoot = resolve(
  valueAfter("--output") ?? join(repo, ".vean/harness/wkwebview-media", fixture.descriptor.runId),
);
mkdirSync(outputRoot, { recursive: true });
const timelinePath = join(fixture.descriptor.projectRoot, "timeline.mlt");
copyFileSync(join(repo, "corpus/shotcut-single.mlt"), timelinePath);
rmSync(fixture.descriptor.database, { force: true });
const fixtureEnv = {
  HOME: fixture.descriptor.home,
  VEAN_CONFIG_HOME: join(fixture.descriptor.home, ".vean"),
};
run(
  ["bun", "src/cli.ts", "project", "init", "--repo", fixture.descriptor.projectRoot, "--json"],
  fixtureEnv,
);
run(["bun", "src/cli.ts", "project", "use", fixture.descriptor.projectRoot, "--json"], fixtureEnv);
run(
  [
    "bun",
    "src/cli.ts",
    "timeline",
    "use",
    timelinePath,
    "--repo",
    fixture.descriptor.projectRoot,
    "--json",
  ],
  fixtureEnv,
);

run(["bun", "run", "viewer:build"]);
const staticDir = join(repo, "viewer/dist/__h07_media");
rmSync(staticDir, { recursive: true, force: true });
mkdirSync(staticDir, { recursive: true });
for (const entry of manifest.entries) {
  copyFileSync(resolve(dirname(manifestPath), entry.relative_path), join(staticDir, entry.file));
}
copyFileSync(
  join(repo, "corpus/harness/media/candidate-goldens/mlt-master-30.png"),
  join(staticDir, "fallback-mlt-still.png"),
);
copyFileSync(manifestPath, join(staticDir, "manifest.json"));

const bundleId = `studio.vean.desktop.harness.h07.${sourceSha.slice(0, 10)}`;
const buildRoot = join(
  repo,
  ".vean/harness/builds",
  `h07-wk-${sourceSha}-${fixture.descriptor.runId}`,
);
run(
  [
    "bun",
    "run",
    "--cwd",
    "app",
    "tauri:build",
    "--",
    "--debug",
    "--features",
    "harness-wdio",
    "--bundles",
    "app",
    "--config",
    JSON.stringify({
      identifier: bundleId,
      bundle: { active: true, targets: ["app"], externalBin: [], resources: [] },
    }),
  ],
  { CARGO_TARGET_DIR: buildRoot },
);
const bundlePath = join(buildRoot, "debug/bundle/macos/vean.app");
const executableName = readdirSync(join(bundlePath, "Contents/MacOS")).find(
  (entry) => !entry.startsWith("."),
);
if (!executableName) throw new Error("E_H07_WK_APP_EXECUTABLE");
const binaryPath = realpathSync(join(bundlePath, "Contents/MacOS", executableName));
const binaryHash = hash(binaryPath);
const contextPath = join(outputRoot, "context.json");
const expectedFinalUrl = `http://127.0.0.1:${fixture.descriptor.previewPort}/?route=timeline%3Amain`;
writeFileSync(
  contextPath,
  `${JSON.stringify(
    {
      runId: fixture.descriptor.runId,
      sourceSha,
      repo,
      projectRoot: fixture.descriptor.projectRoot,
      timelinePath,
      artifactDir: outputRoot,
      processLedger: fixture.descriptor.processLedger,
      previewPort: fixture.descriptor.previewPort,
      webdriverPort: fixture.descriptor.webdriverPort,
      bundlePath,
      binaryPath,
      binaryHash,
      bundleId,
      expectedFinalUrl,
      mediaManifestPath: manifestPath,
      mediaStaticPrefix: "/__h07_media",
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const wdio = Bun.spawn(
  [
    "mise",
    "exec",
    "node@24.15.0",
    "--",
    "node_modules/@wdio/cli/bin/wdio.js",
    "run",
    "wdio.tauri.conf.ts",
  ],
  {
    cwd: repo,
    env: {
      ...process.env,
      VEAN_H05_CONTEXT: contextPath,
      VEAN_H05_HOME: fixture.descriptor.home,
      VEAN_H05_CONFIG_HOME: join(fixture.descriptor.home, ".vean"),
      VEAN_H05_MEDIA: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
const [exitCode, stdout, stderr] = await Promise.all([
  wdio.exited,
  new Response(wdio.stdout).text(),
  new Response(wdio.stderr).text(),
]);
writeFileSync(join(outputRoot, "wdio.stdout.log"), stdout);
writeFileSync(join(outputRoot, "wdio.stderr.log"), stderr);
if (exitCode !== 0) throw new Error(`E_H07_WK_WDIO:${exitCode}\n${stdout}\n${stderr}`);

const nativePath = join(outputRoot, "native-session.json");
const native = JSON.parse(readFileSync(nativePath, "utf8")) as {
  provider: string;
  sourceSha: string;
  fixtureRunId: string;
  cells: Array<{ id: string; outcome: string; observations: Record<string, unknown> }>;
  runtime: { webkitVersion: string; userAgent: string; finalUrl: string };
  process: { pid: number; executableHash: string; observedBundleId: string };
  driver: { sessionId: string; capabilities: unknown };
  screenshotPath: string;
};
if (
  native.provider !== "embedded-safe-wkwebview-media" ||
  native.sourceSha !== sourceSha ||
  native.fixtureRunId !== fixture.descriptor.runId ||
  native.process.executableHash !== binaryHash ||
  native.process.observedBundleId !== bundleId ||
  native.runtime.finalUrl !== expectedFinalUrl ||
  !native.driver.sessionId
)
  throw new Error("E_H07_WK_NATIVE_IDENTITY");

const entriesByFile = new Map(manifest.entries.map((entry) => [entry.file, entry]));
const artifactFiles: Record<string, string> = {
  "runtime:screenshot": native.screenshotPath,
  "runtime:wdio-stdout": join(outputRoot, "wdio.stdout.log"),
  "runtime:wdio-stderr": join(outputRoot, "wdio.stderr.log"),
};
const cells = native.cells.map((cell) => {
  const declaration = matrix.required_cells.find((candidate) => candidate.id === cell.id);
  if (!declaration) throw new Error(`E_H07_WK_UNDECLARED_CELL:${cell.id}`);
  const fixtureFile = cell.observations.fixture_file;
  const decodedFile = cell.observations.decoded_file;
  const fixtureEntry = typeof fixtureFile === "string" ? entriesByFile.get(fixtureFile) : undefined;
  const decodedEntry = typeof decodedFile === "string" ? entriesByFile.get(decodedFile) : undefined;
  const observations = {
    ...cell.observations,
    ...(fixtureEntry ? { fixture_sha256: fixtureEntry.source_sha256 } : {}),
    ...(decodedEntry ? { decoded_sha256: decodedEntry.source_sha256 } : {}),
    ...(declaration.wkwebview === "required_supported_via_proxy" && decodedEntry
      ? { derived_proxy_sha256: decodedEntry.source_sha256 }
      : {}),
  };
  const artifactId = `cell:${cell.id}`;
  const rawPath = join(outputRoot, `cell-${cell.id.replaceAll(/[^a-z0-9.-]/gi, "_")}.json`);
  writeFileSync(
    rawPath,
    `${JSON.stringify({ id: cell.id, outcome: cell.outcome, observations }, null, 2)}\n`,
  );
  artifactFiles[artifactId] = rawPath;
  return {
    ...cell,
    observations,
    observation_artifact_id: artifactId,
    artifact_ids: [artifactId, "runtime:screenshot"],
  };
});
const macosBuild = run(["sw_vers", "-buildVersion"]);
const evidencePath = join(outputRoot, "wkwebview-media-evidence.json");
const observationPath = join(outputRoot, "wkwebview-media-observation.json");
const pendingPath = join(outputRoot, ".wkwebview-media-evidence.pending.json");
const relativeArtifact = (path: string) => relative(outputRoot, path);
const evidence = {
  schema_version: "1.0.0",
  evidence_kind: "wkwebview-media-runtime",
  status: "verified",
  fixture_manifest_sha256: expectedManifestSha,
  policy_sha256s: policySha256s,
  source: { git_sha: sourceSha, git_tree_hash: treeHash, git_status_clean: true },
  runtime: {
    runner: "tauri/wkwebview",
    macos_build: macosBuild,
    webkit_version: native.runtime.webkitVersion,
    app_sha256: binaryHash,
    app_bundle_id: bundleId,
    app_pid: native.process.pid,
    webdriver_session_id: native.driver.sessionId,
    final_url: native.runtime.finalUrl,
    user_agent: native.runtime.userAgent,
    codec_capabilities: Object.fromEntries(cells.map((cell) => [cell.id, cell.outcome])),
  },
  artifacts: Object.fromEntries(
    Object.entries(artifactFiles).map(([id, path]) => [
      id,
      { path: relativeArtifact(path), sha256: hash(path) },
    ]),
  ),
  cells,
};
writeFileSync(
  observationPath,
  `${JSON.stringify({ ...evidence, status: "observed_unverified" }, null, 2)}\n`,
  { mode: 0o600 },
);
writeFileSync(pendingPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
try {
  verifyExternalMediaEvidence({
    evidencePath: pendingPath,
    kind: "wkwebview-media-runtime",
    fixtureManifestSha256: expectedManifestSha,
    policySha256s,
    requiredCellOutcomes: Object.fromEntries(
      matrix.required_cells.map((cell) => [cell.id, cell.wkwebview]),
    ),
  });
  renameSync(pendingPath, evidencePath);
} catch (error) {
  rmSync(pendingPath, { force: true });
  throw error;
}
const cleanup = await fixture.close();
if (hashFile(developerCanary) !== developerCanaryHash) throw new Error("E_H07_WK_DEVELOPER_STATE");
rmSync(staticDir, { recursive: true, force: true });
console.log(
  JSON.stringify({
    status: "verified",
    evidencePath,
    evidenceSha256: hash(evidencePath),
    cells: cells.length,
    cleanup,
  }),
);
