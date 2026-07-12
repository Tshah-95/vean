#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { processIdentity, recordNativeProcess } from "../e2e/tauri/runtime";
import {
  controlRoot,
  ensureControlPlan,
  scanSecret,
  writeControlFailure,
} from "./harness/evidence";
import { createFixture, hashFile } from "./harness/fixture";
import { runSelfUnderSupervisor } from "./harness/supervisor";

const repo = resolve(import.meta.dirname, "..");
if (process.platform !== "darwin") throw new Error("H05 release listener probe requires macOS");
if (process.env.VEAN_HARNESS_SUPERVISED !== "1") {
  await runSelfUnderSupervisor(import.meta.path, process.argv.slice(2));
}
const controlId = "nc-test-instrumentation-absent";
const controlPlan = ensureControlPlan(repo, controlId, {
  before: '{"simulateBundledInstrumentation":false}\n',
  mutated: '{"simulateBundledInstrumentation":true}\n',
});
const controlConfig = JSON.parse(
  readFileSync(join(controlRoot(repo, controlId), "target.txt"), "utf8"),
) as { simulateBundledInstrumentation: boolean };
const negativePhase = process.env.VEAN_HARNESS_PHASE === "negative-control";
const sourceSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
  .stdout.toString()
  .trim();
const canary = join(repo, ".vean/harness/developer-state-canary");
mkdirSync(dirname(canary), { recursive: true });
if (!Bun.file(canary).size) writeFileSync(canary, "poisoned-developer-state\n", { mode: 0o600 });
const fixture = await createFixture({ sourceSha, developerCanary: canary });
const developerHash = hashFile(canary);

function run(command: string[], env: Record<string, string> = {}): string {
  const result = Bun.spawnSync(command, {
    cwd: repo,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.toString();
}

const cargoToml = readFileSync(join(repo, "app/src-tauri/Cargo.toml"), "utf8");
const rustBootstrap = readFileSync(join(repo, "app/src-tauri/src/lib.rs"), "utf8");
const capability = readFileSync(join(repo, "app/src-tauri/capabilities/default.json"), "utf8");
const tauriConfig = readFileSync(join(repo, "app/src-tauri/tauri.conf.json"), "utf8");
const appPackage = readFileSync(join(repo, "app/package.json"), "utf8");
const rootPackage = readFileSync(join(repo, "package.json"), "utf8");
const syntheticCandidate = controlConfig.simulateBundledInstrumentation
  ? `${cargoToml}\ndefault = ["harness-wdio"]\n@wdio/tauri-plugin\nwdio:default\nwithGlobalTauri: true\n`
  : `${cargoToml}\n${capability}\n${tauriConfig}\n${appPackage}`;
const cargoTree = run([
  "rustup",
  "run",
  "1.95.0",
  "cargo",
  "tree",
  "--locked",
  "--manifest-path",
  "app/src-tauri/Cargo.toml",
  "--no-default-features",
]);
const staticChecks = {
  defaultFeaturesEmpty: /\[features\][\s\S]*?default\s*=\s*\[\]/.test(cargoToml),
  webdriverDependencyOptional: /tauri-plugin-wdio-webdriver\s*=\s*\{[^}]*optional\s*=\s*true/.test(
    cargoToml,
  ),
  compileAndRuntimeGated:
    rustBootstrap.includes('#[cfg(feature = "harness-wdio")]') &&
    rustBootstrap.includes('std::env::var("VEAN_HARNESS_WDIO")') &&
    rustBootstrap.includes('std::env::var("WDIO_EMBEDDED_SERVER")'),
  productionCargoTreeExcludesDriver: !cargoTree.includes("tauri-plugin-wdio-webdriver"),
  noFrontendPlugin:
    !rootPackage.includes("@wdio/tauri-plugin") &&
    !appPackage.includes("@wdio/tauri-plugin") &&
    !appPackage.includes("wdioTauri"),
  noWdioCapability: !capability.includes("wdio:") && !capability.includes("wdio-webdriver:"),
  noGlobalTauri: !tauriConfig.includes('"withGlobalTauri": true'),
  detectorRejectsSyntheticMutant:
    !syntheticCandidate.includes('default = ["harness-wdio"]') &&
    !syntheticCandidate.includes("@wdio/tauri-plugin") &&
    !syntheticCandidate.includes("wdio:default") &&
    !syntheticCandidate.includes("withGlobalTauri: true"),
};

const buildRoot = join(repo, ".vean/harness/builds", `h05-release-negative-${sourceSha}`);
run(
  [
    "rustup",
    "run",
    "1.95.0",
    "cargo",
    "build",
    "--locked",
    "--release",
    "--no-default-features",
    "--manifest-path",
    "app/src-tauri/Cargo.toml",
    "--target-dir",
    buildRoot,
  ],
  { TAURI_CONFIG: JSON.stringify({ bundle: { active: false, externalBin: [], resources: [] } }) },
);
const binaryPath = join(buildRoot, "release/vean-app");
const binaryStrings = run(["strings", binaryPath]);
const binaryExcludesDriverSymbols =
  !binaryStrings.includes("WDIO WebDriver plugin initialized") &&
  !binaryStrings.includes("wdio-webdriver");

const app = spawn(binaryPath, [], {
  cwd: fixture.descriptor.projectRoot,
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    HOME: fixture.descriptor.home,
    VEAN_CONFIG_HOME: join(fixture.descriptor.home, ".vean"),
    VEAN_REPO: repo,
    VEAN_BIN: "bun",
    VEAN_PREVIEW_MODE: "prod",
    VEAN_HARNESS_WDIO: "1",
    WDIO_EMBEDDED_SERVER: "true",
    TAURI_WEBDRIVER_PORT: String(fixture.descriptor.webdriverPort),
    VEAN_PROCESS_MARKER: `vean-h05-release-negative-${fixture.descriptor.runId}`,
  },
});
if (!app.pid) throw new Error("release-negative app did not spawn");
await new Promise((done) => setTimeout(done, 2_000));
const appIdentity = processIdentity(app.pid);
recordNativeProcess(
  {
    runId: fixture.descriptor.runId,
    sourceSha,
    repo,
    projectRoot: fixture.descriptor.projectRoot,
    timelinePath: "",
    artifactDir: fixture.descriptor.artifactDir,
    processLedger: fixture.descriptor.processLedger,
    previewPort: fixture.descriptor.previewPort,
    webdriverPort: fixture.descriptor.webdriverPort,
    bundlePath: "development-candidate-no-bundle",
    binaryPath,
    binaryHash: hashFile(binaryPath),
    bundleId: "studio.vean.desktop",
    expectedFinalUrl: "development-candidate-no-viewer-claim",
  },
  app.pid,
  `vean-h05-release-negative-${fixture.descriptor.runId}`,
);
const children = Bun.spawnSync(["pgrep", "-P", String(app.pid)])
  .stdout.toString()
  .trim()
  .split("\n")
  .map((value) => Number.parseInt(value, 10))
  .filter(Number.isInteger);
for (const child of children) {
  const identity = processIdentity(child);
  recordNativeProcess(
    {
      runId: fixture.descriptor.runId,
      sourceSha,
      repo,
      projectRoot: fixture.descriptor.projectRoot,
      timelinePath: "",
      artifactDir: fixture.descriptor.artifactDir,
      processLedger: fixture.descriptor.processLedger,
      previewPort: fixture.descriptor.previewPort,
      webdriverPort: fixture.descriptor.webdriverPort,
      bundlePath: "development-candidate-no-bundle",
      binaryPath,
      binaryHash: hashFile(binaryPath),
      bundleId: "studio.vean.desktop",
      expectedFinalUrl: "development-candidate-no-viewer-claim",
    },
    child,
    `vean-sidecar-${app.pid}`,
  );
  if (!identity.command.includes("preview")) throw new Error("unexpected release app child");
}
let statusRejected = false;
try {
  await fetch(`http://127.0.0.1:${fixture.descriptor.webdriverPort}/status`, {
    signal: AbortSignal.timeout(500),
  });
} catch {
  statusRejected = true;
}
const candidate = {
  status: "development_candidate",
  finalizer: "H08R exact signed/installed lineage",
  sourceSha,
  binary: { path: binaryPath, hash: hashFile(binaryPath) },
  appProcess: appIdentity,
  staticChecks,
  binaryExcludesDriverSymbols,
  dynamic: {
    hostileHarnessEnvironmentSupplied: true,
    webdriverPort: fixture.descriptor.webdriverPort,
    statusRejected,
    sessionRejected: statusRejected,
  },
  control: {
    id: controlId,
    mutationManifest: controlPlan.manifestPath,
    mutationManifestHash: controlPlan.manifestHash,
  },
};
const ok =
  Object.values(staticChecks).every(Boolean) && binaryExcludesDriverSymbols && statusRejected;
if (!ok) {
  if (negativePhase) writeControlFailure("SENSITIVITY_TEST_INSTRUMENTATION_ABSENT", controlId);
  throw new Error(
    `development instrumentation-absence candidate failed: ${JSON.stringify(candidate)}`,
  );
}
if (negativePhase)
  throw new Error("instrumentation-absence mutant unexpectedly satisfied the candidate oracle");
const evidenceBase = process.env.VEAN_HARNESS_EVIDENCE_PATH
  ? dirname(process.env.VEAN_HARNESS_EVIDENCE_PATH)
  : join(repo, ".vean/harness/native-runs");
const invocationId = (process.env.VEAN_HARNESS_CLAIM_RUN_ID ?? fixture.descriptor.runId).replace(
  /[^A-Za-z0-9_.-]/g,
  "_",
);
const artifactDir = join(evidenceBase, "claim-test-instrumentation-absent-candidate", invocationId);
mkdirSync(artifactDir, { recursive: true });
const candidatePath = join(artifactDir, "candidate.json");
writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
if (scanSecret(artifactDir, fixture.authorityToken).length > 0)
  throw new Error("authority leaked into instrumentation candidate");
const cleanup = await fixture.close();
if (hashFile(canary) !== developerHash) throw new Error("developer canary changed");
console.log(JSON.stringify({ ok, ...candidate, cleanup, artifactPath: candidatePath }));
