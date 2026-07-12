#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
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
import {
  type OwnedListener,
  type WebdriverProbe,
  evaluateProductionListeners,
  isWebdriverProtocolResponse,
  parseOwnedListeners,
} from "./harness/tauri-instrumentation-policy";

const repo = resolve(import.meta.dirname, "..");
if (process.platform !== "darwin") throw new Error("H05 release listener probe requires macOS");
if (process.env.VEAN_HARNESS_SUPERVISED !== "1") {
  await runSelfUnderSupervisor(import.meta.path, process.argv.slice(2));
}
const cargoToml = readFileSync(join(repo, "app/src-tauri/Cargo.toml"), "utf8");
const mutatedCargoToml = cargoToml.replace("default = []", 'default = ["harness-wdio"]');
if (mutatedCargoToml === cargoToml)
  throw new Error("could not construct real Cargo feature mutant");
const controlId = "nc-test-instrumentation-absent";
const controlPlan = ensureControlPlan(repo, controlId, {
  before: cargoToml,
  mutated: mutatedCargoToml,
});
const scannedCargoToml = readFileSync(join(controlRoot(repo, controlId), "target.txt"), "utf8");
const negativePhase = process.env.VEAN_HARNESS_PHASE === "negative-control";
const sourceSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
  .stdout.toString()
  .trim();
const invocationId = (
  process.env.VEAN_HARNESS_CLAIM_RUN_ID ??
  `${process.env.VEAN_HARNESS_PHASE ?? "standalone"}-${randomUUID()}`
).replace(/[^A-Za-z0-9_.-]/g, "_");
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

const rustBootstrap = readFileSync(join(repo, "app/src-tauri/src/lib.rs"), "utf8");
const capability = readFileSync(join(repo, "app/src-tauri/capabilities/default.json"), "utf8");
const tauriConfig = readFileSync(join(repo, "app/src-tauri/tauri.conf.json"), "utf8");
const appPackage = readFileSync(join(repo, "app/package.json"), "utf8");
const rootPackage = readFileSync(join(repo, "package.json"), "utf8");
const cargoFeatureArgs = scannedCargoToml.includes('default = ["harness-wdio"]')
  ? ["--features", "harness-wdio"]
  : ["--no-default-features"];
const cargoTree = run([
  "rustup",
  "run",
  "1.95.0",
  "cargo",
  "tree",
  "--locked",
  "--manifest-path",
  "app/src-tauri/Cargo.toml",
  ...cargoFeatureArgs,
]);
const staticChecks = {
  scannerInputMatchesSource: scannedCargoToml === cargoToml,
  defaultFeaturesEmpty: /\[features\][\s\S]*?default\s*=\s*\[\]/.test(scannedCargoToml),
  webdriverDependencyOptional: /tauri-plugin-wdio-webdriver\s*=\s*\{[^}]*optional\s*=\s*true/.test(
    scannedCargoToml,
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
  scannerRejectsRealConfigMutant: !scannedCargoToml.includes('default = ["harness-wdio"]'),
};

const buildRoot = join(
  repo,
  ".vean/harness/builds",
  `h05-release-negative-${sourceSha}-${invocationId}`,
);
run(
  [
    "rustup",
    "run",
    "1.95.0",
    "cargo",
    "build",
    "--locked",
    "--release",
    ...cargoFeatureArgs,
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
function descendants(rootPid: number): number[] {
  const found: number[] = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.shift();
    if (parent === undefined) continue;
    const children = Bun.spawnSync(["pgrep", "-P", String(parent)])
      .stdout.toString()
      .trim()
      .split("\n")
      .map((value) => Number.parseInt(value, 10))
      .filter(Number.isInteger);
    found.push(...children);
    pending.push(...children);
  }
  return found;
}
const children = descendants(app.pid);
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
const processTreePids = [app.pid, ...children];
const ownedListeners: OwnedListener[] = processTreePids.flatMap((pid) => {
  const result = Bun.spawnSync([
    "lsof",
    "-nP",
    "-a",
    "-p",
    String(pid),
    "-iTCP",
    "-sTCP:LISTEN",
    "-Fn",
  ]);
  return parseOwnedListeners(pid, result.stdout.toString());
});
async function probeWebdriver(port: number): Promise<WebdriverProbe> {
  const request = async (path: string, init?: RequestInit): Promise<boolean> => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        ...init,
        signal: AbortSignal.timeout(750),
      });
      const body = await response.text();
      return isWebdriverProtocolResponse(response.headers.get("content-type"), body);
    } catch {
      return false;
    }
  };
  return {
    port,
    statusProtocolAccepted: await request("/status"),
    sessionProtocolAccepted: await request("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capabilities: { alwaysMatch: {}, firstMatch: [{}] } }),
    }),
  };
}
const probedPorts = [
  ...new Set([
    fixture.descriptor.webdriverPort,
    4445,
    ...ownedListeners.map((listener) => listener.port),
  ]),
];
const webdriverProbes = await Promise.all(probedPorts.map(probeWebdriver));
const requestedProbe = webdriverProbes.find(
  (probe) => probe.port === fixture.descriptor.webdriverPort,
);
const defaultProbe = webdriverProbes.find((probe) => probe.port === 4445);
if (!requestedProbe || !defaultProbe)
  throw new Error("required WebDriver probes were not recorded");
const listenerPolicy = evaluateProductionListeners(
  ownedListeners,
  webdriverProbes,
  fixture.descriptor.webdriverPort,
);
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
    statusRejected: !requestedProbe.statusProtocolAccepted,
    sessionRejected: !requestedProbe.sessionProtocolAccepted,
    defaultPort: 4445,
    defaultPortProbes: defaultProbe,
    processTreePids,
    ownedListeners,
    webdriverProbes,
    listenerPolicy,
  },
  control: {
    id: controlId,
    mutationManifest: controlPlan.manifestPath,
    mutationManifestHash: controlPlan.manifestHash,
  },
};
const evidenceBase = process.env.VEAN_HARNESS_EVIDENCE_PATH
  ? dirname(process.env.VEAN_HARNESS_EVIDENCE_PATH)
  : join(repo, ".vean/harness/native-runs");
const artifactDir = join(evidenceBase, "claim-test-instrumentation-absent-candidate", invocationId);
mkdirSync(artifactDir, { recursive: true });
const candidatePath = join(artifactDir, "candidate.json");
writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
if (scanSecret(artifactDir, fixture.authorityToken).length > 0)
  throw new Error("authority leaked into instrumentation candidate");
const ok =
  Object.values(staticChecks).every(Boolean) &&
  binaryExcludesDriverSymbols &&
  !requestedProbe.statusProtocolAccepted &&
  !requestedProbe.sessionProtocolAccepted &&
  !defaultProbe.statusProtocolAccepted &&
  !defaultProbe.sessionProtocolAccepted &&
  listenerPolicy.allOwnedListenersRejectAutomation;
if (!ok) {
  if (negativePhase) writeControlFailure("SENSITIVITY_TEST_INSTRUMENTATION_ABSENT", controlId);
  throw new Error(
    `development instrumentation-absence candidate failed: ${JSON.stringify(candidate)}`,
  );
}
if (negativePhase)
  throw new Error("instrumentation-absence mutant unexpectedly satisfied the candidate oracle");
const cleanup = await fixture.close();
if (hashFile(canary) !== developerHash) throw new Error("developer canary changed");
console.log(JSON.stringify({ ok, ...candidate, cleanup, artifactPath: candidatePath }));
