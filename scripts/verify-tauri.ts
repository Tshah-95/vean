#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fromMlt } from "../src/ir/parse";
import type { Timeline } from "../src/ir/types";
import {
  controlRoot,
  ensureControlPlan,
  scanSecret,
  writeControlFailure,
  writeVerifiedEvidence,
} from "./harness/evidence";
import { createFixture, hashFile } from "./harness/fixture";
import { runSelfUnderSupervisor } from "./harness/supervisor";
import { evaluateSplitPersistence } from "./harness/tauri-domain-truth";
import { evaluateTauriIdentity } from "./harness/tauri-identity";

const repo = resolve(import.meta.dirname, "..");
if (process.platform !== "darwin") throw new Error("H05 embedded WKWebView proof requires macOS");
if (process.env.VEAN_HARNESS_SUPERVISED !== "1") {
  await runSelfUnderSupervisor(import.meta.path, process.argv.slice(2));
}

const controlId = "nc-tauri-wkwebview";
const controlPlan = ensureControlPlan(repo, controlId, {
  before:
    '{"binaryHashOverride":null,"bundleIdOverride":null,"webdriverPortOffset":0,"previewPortOffset":0,"finalUrlOverride":null}\n',
  mutated:
    '{"binaryHashOverride":"substituted","bundleIdOverride":"studio.vean.substituted","webdriverPortOffset":1,"previewPortOffset":1,"finalUrlOverride":"tauri://localhost/"}\n',
});
const controlConfig = JSON.parse(
  readFileSync(join(controlRoot(repo, controlId), "target.txt"), "utf8"),
) as {
  binaryHashOverride: string | null;
  bundleIdOverride: string | null;
  webdriverPortOffset: number;
  previewPortOffset: number;
  finalUrlOverride: string | null;
};
const negativePhase = process.env.VEAN_HARNESS_PHASE === "negative-control";
const cleanupFailureProbe = process.argv.includes("--simulate-session-failure");
const sourceSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
  .stdout.toString()
  .trim();
const canary = join(repo, ".vean/harness/developer-state-canary");
mkdirSync(dirname(canary), { recursive: true });
if (!Bun.file(canary).size) writeFileSync(canary, "poisoned-developer-state\n", { mode: 0o600 });
const fixture = await createFixture({ sourceSha, developerCanary: canary });
const developerHash = hashFile(canary);
const timelinePath = join(fixture.descriptor.projectRoot, "timeline.mlt");
const sourceTimeline = join(repo, "corpus/shotcut-single.mlt");
copyFileSync(sourceTimeline, timelinePath);
const beforeTimelineHash = hashFile(timelinePath);
rmSync(fixture.descriptor.database, { force: true });

function run(command: string[], env: Record<string, string> = {}): string {
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
  return result.stdout.toString();
}

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

run(["bun", "run", "--cwd", "viewer", "build"]);
const bundleId = `studio.vean.desktop.harness.s${sourceSha.slice(0, 12)}`;
const buildRoot = join(
  repo,
  ".vean/harness/builds",
  `h05-${sourceSha}-${fixture.descriptor.runId}`,
);
const tauriOverlay = JSON.stringify({
  identifier: bundleId,
  bundle: { active: true, targets: ["app"], externalBin: [], resources: [] },
});
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
    tauriOverlay,
  ],
  { CARGO_TARGET_DIR: buildRoot },
);
const bundlePath = join(buildRoot, "debug/bundle/macos/vean.app");
const macosDir = join(bundlePath, "Contents/MacOS");
const executableName = readdirSync(macosDir).find((entry) => !entry.startsWith("."));
if (!executableName) throw new Error(`instrumented app bundle has no executable: ${bundlePath}`);
const binaryPath = realpathSync(join(macosDir, executableName));
const binaryHash = hashFile(binaryPath);
const invocationId = (process.env.VEAN_HARNESS_CLAIM_RUN_ID ?? fixture.descriptor.runId).replace(
  /[^A-Za-z0-9_.-]/g,
  "_",
);
const evidenceBase = process.env.VEAN_HARNESS_EVIDENCE_PATH
  ? dirname(process.env.VEAN_HARNESS_EVIDENCE_PATH)
  : join(repo, ".vean/harness/native-runs");
const durableDir = join(evidenceBase, "claim-tauri-wkwebview-artifacts", invocationId);
mkdirSync(durableDir, { recursive: true });
const contextPath = join(durableDir, "context.json");
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
      artifactDir: durableDir,
      processLedger: fixture.descriptor.processLedger,
      previewPort: fixture.descriptor.previewPort,
      webdriverPort: fixture.descriptor.webdriverPort,
      bundlePath,
      binaryPath,
      binaryHash,
      bundleId,
      expectedFinalUrl,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);

const monitor = Bun.spawn(["bun", "scripts/harness/tauri-ledger-monitor.ts"], {
  cwd: repo,
  env: { ...process.env, VEAN_H05_CONTEXT: contextPath },
  stdout: "pipe",
  stderr: "pipe",
});
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
      ...(cleanupFailureProbe ? { VEAN_H05_SIMULATE_SESSION_FAILURE: "1" } : {}),
    },
    stdout: "pipe",
    stderr: "pipe",
  },
);
const [wdioExitCode, wdioStdout, wdioStderr, monitorExitCode, monitorStdout, monitorStderr] =
  await Promise.all([
    wdio.exited,
    new Response(wdio.stdout).text(),
    new Response(wdio.stderr).text(),
    monitor.exited,
    new Response(monitor.stdout).text(),
    new Response(monitor.stderr).text(),
  ]);
process.stdout.write(wdioStdout);
process.stderr.write(wdioStderr);
writeFileSync(join(durableDir, "wdio.stdout.log"), wdioStdout);
writeFileSync(join(durableDir, "wdio.stderr.log"), wdioStderr);
writeFileSync(join(durableDir, "ledger-monitor.stdout.log"), monitorStdout);
writeFileSync(join(durableDir, "ledger-monitor.stderr.log"), monitorStderr);
const nativeResultPath = join(durableDir, "native-session.json");
if (cleanupFailureProbe) {
  if (wdioExitCode === 0 || monitorExitCode !== 0) {
    throw new Error(
      `session-failure control did not reach the expected boundary (wdio=${wdioExitCode}, monitor=${monitorExitCode})`,
    );
  }
  if (!wdioStderr.includes("SYNTHETIC_SESSION_CREATION_FAILURE")) {
    throw new Error("session-failure control failed for the wrong reason");
  }
  const cleanup = await fixture.close();
  console.log(
    JSON.stringify({
      ok: true,
      reasonCode: "SESSION_CREATION_FAILURE_CLEANUP_VERIFIED",
      monitor: JSON.parse(monitorStdout),
      cleanup,
    }),
  );
  process.exit(0);
}
if (wdioExitCode !== 0 || monitorExitCode !== 0 || !Bun.file(nativeResultPath).size) {
  throw new Error(
    `native WDIO session failed (wdio=${wdioExitCode}, ledger-monitor=${monitorExitCode})`,
  );
}

type NativeResult = {
  provider?: string;
  fixtureRunId?: string;
  sourceSha?: string;
  binary?: { observedPath?: string; observedHash?: string };
  process?: { pid?: number; observedBundleId?: string };
  sidecar?: {
    pid?: number;
    parentPid?: number;
    processGroup?: number;
    processMarker?: string;
    command?: string;
  };
  preview?: { port?: number; listenerPid?: number };
  window?: { finalUrl?: string };
  runtime?: { webkitVersion?: string };
  driver?: { port?: number; listenerPid?: number; sessionId?: string };
  action?: { id?: string; input?: { uuid?: string; frame?: number } };
  actionEnvelope?: {
    ok?: boolean;
    value?: {
      ok?: boolean;
      revision?: number;
      ir?: Timeline;
      consequences?: {
        clipsAdded?: Array<{ uuid?: string; track?: string; position?: number; playtime?: number }>;
        clipsTrimmed?: Array<{
          uuid?: string;
          inDelta?: number;
          outDelta?: number;
          playtimeDelta?: number;
        }>;
      };
    };
  };
  saveEnvelope?: { path?: string };
};
const native = JSON.parse(readFileSync(nativeResultPath, "utf8")) as NativeResult;
const persistedXml = readFileSync(timelinePath, "utf8");
const parsed = fromMlt(persistedXml);
const clips = [...parsed.tracks.video, ...parsed.tracks.audio].flatMap((track) =>
  track.items.filter((item) => item.kind === "clip"),
);
const afterTimelineHash = hashFile(timelinePath);
const savePath = native.saveEnvelope?.path;
const appPid = native.process?.pid;
if (!Number.isInteger(appPid)) throw new Error("native evidence omitted the app PID");
const sidecarCommandFragments = [
  "src/cli.ts preview",
  "--no-open --prod",
  `--port ${fixture.descriptor.previewPort}`,
  `--repo ${fixture.descriptor.projectRoot}`,
];
const identityPredicate = evaluateTauriIdentity({
  expectedBinaryPath: binaryPath,
  expectedBinaryHash: controlConfig.binaryHashOverride ?? binaryHash,
  observedBinaryPath: native.binary?.observedPath,
  observedBinaryHash: native.binary?.observedHash,
  expectedBundleId: controlConfig.bundleIdOverride ?? bundleId,
  observedBundleId: native.process?.observedBundleId,
  expectedWebdriverPort: fixture.descriptor.webdriverPort + controlConfig.webdriverPortOffset,
  observedWebdriverPort: native.driver?.port,
  webdriverListenerPid: native.driver?.listenerPid,
  appPid: native.process?.pid,
  expectedPreviewPort: fixture.descriptor.previewPort + controlConfig.previewPortOffset,
  observedPreviewPort: fixture.descriptor.previewPort,
  previewListenerPid: native.preview?.listenerPid,
  sidecarPid: native.sidecar?.pid,
  sidecarParentPid: native.sidecar?.parentPid,
  sidecarProcessGroup: native.sidecar?.processGroup,
  sidecarProcessMarker: native.sidecar?.processMarker,
  expectedSidecarProcessMarker: `vean-sidecar-${appPid}-${fixture.descriptor.previewPort}`,
  sidecarCommand: native.sidecar?.command,
  expectedSidecarCommandFragments: sidecarCommandFragments,
  expectedFinalUrl: controlConfig.finalUrlOverride ?? expectedFinalUrl,
  observedFinalUrl: native.window?.finalUrl,
});
const documentPredicate = evaluateSplitPersistence({
  actionId: native.action?.id,
  input: native.action?.input,
  envelope: native.actionEnvelope,
  parsed,
  originalUuid: "{7c1a0e2a-0001-4abc-9d00-000000000001}",
  splitFrame: 40,
  timelinePath,
  savePath,
  beforeHash: beforeTimelineHash,
  afterHash: afterTimelineHash,
});
const predicate = {
  ...identityPredicate,
  ...documentPredicate,
  nativeProvider: native.provider === "embedded-safe",
  finalWkwebview: Boolean(native.runtime?.webkitVersion),
  driverSession:
    native.driver?.port === fixture.descriptor.webdriverPort && Boolean(native.driver?.sessionId),
  sourceAndFixture:
    native.sourceSha === sourceSha && native.fixtureRunId === fixture.descriptor.runId,
  developerStateUnchanged: hashFile(canary) === developerHash,
};
const os = {
  productVersion: run(["sw_vers", "-productVersion"]).trim(),
  buildVersion: run(["sw_vers", "-buildVersion"]).trim(),
};
const oracle = {
  ok: Object.values(predicate).every(Boolean),
  providerDecision: "embedded_basic_safe",
  predicate,
  fixtureRunId: fixture.descriptor.runId,
  sourceSha,
  binary: {
    bundlePath,
    path: binaryPath,
    hash: binaryHash,
    mode: statSync(binaryPath).mode & 0o777,
  },
  bundleId,
  os,
  finalUrl: native.window?.finalUrl,
  webkitVersion: native.runtime?.webkitVersion,
  driver: native.driver,
  actionEnvelope: native.actionEnvelope,
  touchedUri: savePath,
  persisted: {
    path: timelinePath,
    beforeHash: beforeTimelineHash,
    afterHash: afterTimelineHash,
    parsedClipIds: clips.map((clip) => clip.id),
  },
};
const oraclePath = join(durableDir, "oracle.json");
if (!oracle.ok) {
  if (negativePhase) writeControlFailure("SENSITIVITY_TAURI_WKWEBVIEW", controlId);
  throw new Error(`native WKWebView predicate failed: ${JSON.stringify(predicate)}`);
}
if (negativePhase) throw new Error("native WKWebView mutant unexpectedly satisfied the oracle");
const leaked = scanSecret(durableDir, fixture.authorityToken);
if (leaked.length > 0) throw new Error(`authority leaked into H05 artifacts: ${leaked.join(",")}`);
const durableFixturePath = join(durableDir, "fixture.json");
const durableTimelinePath = join(durableDir, "persisted-timeline.mlt");
copyFileSync(join(fixture.descriptor.artifactDir, "fixture.json"), durableFixturePath);
copyFileSync(timelinePath, durableTimelinePath);
const cleanup = await fixture.close();
const completedOracle = { ...oracle, cleanup };
writeFileSync(oraclePath, `${JSON.stringify(completedOracle, null, 2)}\n`);

writeVerifiedEvidence({
  repo,
  claimId: "claim-tauri-wkwebview",
  oracleCommand: "bun run verify:tauri --provider auto",
  expectedPredicate:
    "one approved provider branch binds exact binary hash, PID/bundle/window, final URL, WebKit identity, run nonce, canonical action/document result, and cleanup",
  controlId,
  fixturePath: durableFixturePath,
  commandPath: join(repo, "scripts/verify-tauri.ts"),
  implementationPaths: [
    join(repo, "package.json"),
    join(repo, "vitest.config.ts"),
    join(repo, "scripts/verify-tauri.ts"),
    join(repo, "scripts/doctor-tauri-driver.ts"),
    join(repo, "scripts/harness/tauri-domain-truth.ts"),
    join(repo, "scripts/harness/tauri-identity.ts"),
    join(repo, "scripts/harness/tauri-ledger-monitor.ts"),
    join(repo, "wdio.tauri.conf.ts"),
    join(repo, "e2e/tauri/editor.spec.ts"),
    join(repo, "e2e/tauri/runtime.ts"),
    join(repo, "app/src-tauri/Cargo.toml"),
    join(repo, "app/src-tauri/src/lib.rs"),
    join(repo, "artifacts/specs/harness-scenarios/tauri.json"),
    join(repo, "tests/tauri-harness-contract.test.ts"),
    join(repo, "tests/tauri-domain-truth.test.ts"),
  ],
  generatedPaths: [
    nativeResultPath,
    join(durableDir, "final-wkwebview.png"),
    join(durableDir, "wdio.stdout.log"),
    join(durableDir, "wdio.stderr.log"),
    join(durableDir, "ledger-monitor.stdout.log"),
    join(durableDir, "ledger-monitor.stderr.log"),
    oraclePath,
  ],
  artifactPaths: [bundlePath, binaryPath, durableTimelinePath],
  result: completedOracle,
  controlPlan,
  scenarioPath: join(repo, "artifacts/specs/harness-scenarios/tauri.json"),
  executedScenarioIds: ["tauri-final-viewer-split-save"],
});
if (hashFile(canary) !== developerHash) throw new Error("developer canary changed after cleanup");
if (!process.env.VEAN_HARNESS_EVIDENCE_PATH) {
  console.log(JSON.stringify({ ...completedOracle, artifactDir: durableDir }));
}
