#!/usr/bin/env bun
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  hashPath,
  scanSecret,
  writeControlFailure,
  writeVerifiedEvidence,
} from "./harness/evidence";
import { createFixture, hashFile } from "./harness/fixture";
import {
  evaluateMacosShellTruth,
  evaluateResidualDialogControl,
} from "./harness/macos-domain-truth";
import {
  buildMacosBlockedEvidence,
  ensureMac2Installed,
  pinnedNodeCommand,
  runTimed,
  waitForAppium,
} from "./harness/macos-driver";
import { enforceMacosRunnerPolicy } from "./harness/macos-runner-policy";
import { nativeMacosControlId, prepareNativeMacosControl } from "./harness/native-macos-control";
import { recordProcess } from "./harness/process-ledger";
import { runSelfUnderSupervisor } from "./harness/supervisor";

enforceMacosRunnerPolicy();

const repo = resolve(import.meta.dirname, "..");
if (process.platform !== "darwin") throw new Error("H06 native shell proof requires macOS");
if (process.env.VEAN_HARNESS_SUPERVISED !== "1") {
  process.env.VEAN_HARNESS_TIMEOUT_MS ??= "900000";
  await runSelfUnderSupervisor(import.meta.path, process.argv.slice(2));
}

const phase = process.env.VEAN_HARNESS_PHASE;
const negativePhase = phase === "negative-control";
const residualControl = process.argv.includes("--simulate-residual-dialog");
const control = prepareNativeMacosControl(!negativePhase);
if (negativePhase && hashFile(control.target) !== control.mutatedHash) {
  throw new Error("native semantic label control was not applied to the real Rust menu source");
}

const sourceSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
  .stdout.toString()
  .trim();
const canary = join(repo, ".vean/harness/developer-state-canary");
mkdirSync(dirname(canary), { recursive: true });
if (!Bun.file(canary).size) writeFileSync(canary, "poisoned-developer-state\n", { mode: 0o600 });
const developerHash = hashFile(canary);
const fixture = await createFixture({ sourceSha, developerCanary: canary });
rmSync(fixture.descriptor.database, { force: true });
const fixtureAppiumHome = join(fixture.root, "appium-home");
const invocationId = (process.env.VEAN_HARNESS_CLAIM_RUN_ID ?? fixture.descriptor.runId).replace(
  /[^A-Za-z0-9_.-]/g,
  "_",
);
const evidenceBase = process.env.VEAN_HARNESS_EVIDENCE_PATH
  ? dirname(process.env.VEAN_HARNESS_EVIDENCE_PATH)
  : join(repo, ".vean/harness/native-runs");
const durableDir = join(evidenceBase, "claim-native-macos-shell-artifacts", invocationId);
mkdirSync(durableDir, { recursive: true });
const contextPath = join(durableDir, "context.json");
const nativeResultPath = join(durableDir, "macos-session.json");
let appium: ReturnType<typeof spawn> | null = null;
let monitor: ReturnType<typeof Bun.spawn> | null = null;
let monitorStdoutPromise: Promise<string> | null = null;
let monitorStderrPromise: Promise<string> | null = null;
let cleanup: Awaited<ReturnType<typeof fixture.close>> | null = null;
let wdioExit = -1;
let wdioStdout = "";
let wdioStderr = "";
let appiumStdout = "";
let appiumStderr = "";
let developerAppiumMutated = false;
const monitorStop = join(fixture.root, "macos-ledger-monitor.stop");
const developerAppiumHome = join(homedir(), ".appium");
const developerAppiumBefore = existsSync(developerAppiumHome)
  ? hashPath(developerAppiumHome)
  : null;

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
  return result.stdout.toString().trim();
}

try {
  const doctor = await runTimed(["bun", "scripts/doctor-macos-driver.ts", "--json"], {
    cwd: repo,
    timeoutMs: 300_000,
  });
  writeFileSync(join(durableDir, "doctor.json"), doctor.stdout || doctor.stderr);
  if (doctor.exitCode !== 0 || doctor.timedOut) {
    let parsedDoctor: {
      reasonCode?: string;
      versions?: unknown;
      checks?: { xcode?: { firstLaunch?: unknown } };
      failures?: Array<{ code?: string; detail?: string; userAction?: string }>;
    } = {};
    try {
      parsedDoctor = JSON.parse(doctor.stdout) as typeof parsedDoctor;
    } catch {}
    const finding = parsedDoctor.failures?.[0];
    const observed = parsedDoctor.checks?.xcode?.firstLaunch;
    const observedCheck =
      observed && typeof observed === "object"
        ? (observed as Parameters<typeof buildMacosBlockedEvidence>[0]["observedCheck"])
        : doctor;
    const blocked = buildMacosBlockedEvidence({
      finding: {
        code: finding?.code ?? "MACOS_DRIVER_EXTERNAL_GATE",
        detail: finding?.detail ?? doctor.stderr,
        userAction:
          finding?.userAction ?? "Complete the prepared Mac driver prerequisites, then rerun.",
      },
      versions: parsedDoctor.versions,
      observedCheck,
      sourceSha,
      fixtureRunId: fixture.descriptor.runId,
    });
    writeFileSync(join(durableDir, "blocked.json"), `${JSON.stringify(blocked, null, 2)}\n`);
    throw new Error(`MACOS_DRIVER_EXTERNAL_GATE\n${doctor.stdout}\n${doctor.stderr}`);
  }

  run(
    ["bun", "src/cli.ts", "project", "init", "--repo", fixture.descriptor.projectRoot, "--json"],
    { HOME: fixture.descriptor.home, VEAN_CONFIG_HOME: join(fixture.descriptor.home, ".vean") },
  );
  run(["bun", "src/cli.ts", "project", "use", fixture.descriptor.projectRoot, "--json"], {
    HOME: fixture.descriptor.home,
    VEAN_CONFIG_HOME: join(fixture.descriptor.home, ".vean"),
  });
  run(["bun", "run", "--cwd", "viewer", "build"]);

  const bundleId = `studio.vean.desktop.h06.s${sourceSha.slice(0, 12)}.${fixture.descriptor.runId.replaceAll("-", "")}`;
  const buildRoot = join(
    repo,
    ".vean/harness/builds",
    `h06-${sourceSha}-${fixture.descriptor.runId}`,
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
      "--bundles",
      "app",
      "--config",
      tauriOverlay,
    ],
    { CARGO_TARGET_DIR: buildRoot },
  );
  const bundlePath = join(buildRoot, "debug/bundle/macos/vean.app");
  const macosDir = join(bundlePath, "Contents/MacOS");
  const executable = readdirSync(macosDir).find((entry) => !entry.startsWith("."));
  if (!executable) throw new Error(`built bundle has no executable: ${bundlePath}`);
  const binaryPath = realpathSync(join(macosDir, executable));
  const binaryHash = hashFile(binaryPath);

  writeFileSync(
    contextPath,
    `${JSON.stringify(
      {
        runId: fixture.descriptor.runId,
        sourceSha,
        repo,
        projectRoot: fixture.descriptor.projectRoot,
        artifactDir: durableDir,
        processLedger: fixture.descriptor.processLedger,
        appiumPort: fixture.descriptor.webdriverPort,
        systemPort: fixture.descriptor.vitePort,
        bundlePath,
        binaryPath,
        binaryHash,
        bundleId,
        expectedMenuLabel: "Open Project Folder…",
        residualDialogControl: residualControl,
        appEnvironment: {
          HOME: fixture.descriptor.home,
          VEAN_CONFIG_HOME: join(fixture.descriptor.home, ".vean"),
          VEAN_REPO: repo,
          VEAN_BIN: "bun",
          VEAN_PREVIEW_MODE: "prod",
          VEAN_PROCESS_MARKER: `vean-h06-${fixture.descriptor.runId}`,
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );

  const install = await ensureMac2Installed(repo, fixtureAppiumHome);
  if (install.exitCode !== 0 || install.timedOut) {
    throw new Error(`fixture-owned Mac2 registration failed: ${install.stderr || install.stdout}`);
  }
  const driverList = await runTimed(
    pinnedNodeCommand(repo, ["driver", "list", "--installed", "--json"]),
    { cwd: repo, env: { APPIUM_HOME: fixtureAppiumHome } },
  );
  const installedDriver = JSON.parse(driverList.stdout) as {
    mac2?: { version?: string; installed?: boolean; installPath?: string };
  };
  if (
    driverList.exitCode !== 0 ||
    installedDriver.mac2?.version !== "4.0.3" ||
    installedDriver.mac2.installed !== true ||
    !installedDriver.mac2.installPath?.startsWith(fixtureAppiumHome)
  ) {
    throw new Error(`fixture-owned Mac2 registration is not exact: ${driverList.stdout}`);
  }

  const [appiumCommand, ...appiumArgs] = pinnedNodeCommand(repo, [
    "--address",
    "127.0.0.1",
    "--port",
    String(fixture.descriptor.webdriverPort),
  ]);
  if (!appiumCommand) throw new Error("pinned Appium command is empty");
  const appiumProcess = spawn(appiumCommand, appiumArgs, {
    cwd: repo,
    env: { ...process.env, APPIUM_HOME: fixtureAppiumHome },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  appium = appiumProcess;
  appiumProcess.stdout?.on("data", (chunk) => {
    appiumStdout += String(chunk);
  });
  appiumProcess.stderr?.on("data", (chunk) => {
    appiumStderr += String(chunk);
  });
  if (!appiumProcess.pid) throw new Error("Appium server has no PID");
  const startedAt = run(["ps", "-p", String(appiumProcess.pid), "-o", "lstart="]);
  recordProcess(fixture.descriptor.processLedger, {
    pid: appiumProcess.pid,
    marker: `vean-h06-appium-${fixture.descriptor.runId}`,
    executable: "appium/index.js",
    startedAt,
  });
  await waitForAppium(fixture.descriptor.webdriverPort);

  monitor = Bun.spawn(["bun", "scripts/harness/macos-ledger-monitor.ts"], {
    cwd: repo,
    env: {
      ...process.env,
      VEAN_H06_CONTEXT: contextPath,
      VEAN_H06_MONITOR_STOP: monitorStop,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  monitorStdoutPromise =
    monitor.stdout instanceof ReadableStream
      ? new Response(monitor.stdout).text()
      : Promise.resolve("");
  monitorStderrPromise =
    monitor.stderr instanceof ReadableStream
      ? new Response(monitor.stderr).text()
      : Promise.resolve("");

  const wdio = Bun.spawn(
    [
      "mise",
      "exec",
      "node@24.15.0",
      "--",
      "node_modules/@wdio/cli/bin/wdio.js",
      "run",
      "wdio.macos.conf.ts",
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        APPIUM_HOME: fixtureAppiumHome,
        VEAN_H06_CONTEXT: contextPath,
        VEAN_H06_HOME: fixture.descriptor.home,
        VEAN_H06_CONFIG_HOME: join(fixture.descriptor.home, ".vean"),
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  [wdioExit, wdioStdout, wdioStderr] = await Promise.all([
    wdio.exited,
    new Response(wdio.stdout).text(),
    new Response(wdio.stderr).text(),
  ]);
} finally {
  writeFileSync(monitorStop, "stop\n");
  if (monitor) {
    await Promise.race([monitor.exited, new Promise((done) => setTimeout(done, 5_000))]);
    if (monitor.exitCode === null) monitor.kill("SIGKILL");
  }
  const monitorStdout = monitorStdoutPromise ? await monitorStdoutPromise : "";
  const monitorStderr = monitorStderrPromise ? await monitorStderrPromise : "";
  writeFileSync(join(durableDir, "ledger-monitor.stdout.log"), monitorStdout);
  writeFileSync(join(durableDir, "ledger-monitor.stderr.log"), monitorStderr);
  writeFileSync(join(durableDir, "wdio.stdout.log"), wdioStdout);
  writeFileSync(join(durableDir, "wdio.stderr.log"), wdioStderr);
  writeFileSync(join(durableDir, "appium.stdout.log"), appiumStdout);
  writeFileSync(join(durableDir, "appium.stderr.log"), appiumStderr);
  if (appium?.pid) {
    try {
      process.kill(-appium.pid, "SIGTERM");
    } catch {}
    await Promise.race([
      new Promise((done) => appium?.once("close", done)),
      new Promise((done) => setTimeout(done, 5_000)),
    ]);
    try {
      process.kill(-appium.pid, "SIGKILL");
    } catch {}
  }
  const developerAppiumAfter = existsSync(developerAppiumHome)
    ? hashPath(developerAppiumHome)
    : null;
  developerAppiumMutated = developerAppiumBefore !== developerAppiumAfter;
  cleanup = await fixture.close();
}

if (developerAppiumMutated) {
  throw new Error("H06 mutated developer ~/.appium outside the fixture");
}

if (negativePhase || residualControl) {
  const marker = residualControl
    ? "SENSITIVITY_NATIVE_MACOS_RESIDUAL_DIALOG"
    : "SENSITIVITY_NATIVE_MACOS_SHELL";
  if (wdioExit === 0 || !`${wdioStdout}\n${wdioStderr}`.includes(marker)) {
    throw new Error(`native negative control failed at the wrong boundary (wdio=${wdioExit})`);
  }
  if (residualControl) {
    const record = Bun.file(nativeResultPath).size
      ? (JSON.parse(readFileSync(nativeResultPath, "utf8")) as {
          residualDialogControl?: boolean;
          residual?: { dialogs?: number; sheets?: number };
        })
      : undefined;
    const residualPredicate = evaluateResidualDialogControl({
      markerSeen: `${wdioStdout}\n${wdioStderr}`.includes(marker),
      record,
      cleanupDetected: cleanup?.detected ?? ["cleanup missing"],
    });
    if (!Object.values(residualPredicate).every(Boolean)) {
      throw new Error(
        `residual-dialog control did not prove detection and cleanup: ${JSON.stringify(residualPredicate)}`,
      );
    }
  }
  if (negativePhase) writeControlFailure("SENSITIVITY_NATIVE_MACOS_SHELL", nativeMacosControlId);
  console.log(JSON.stringify({ ok: true, reasonCode: marker, cleanup, artifactDir: durableDir }));
  process.exit(0);
}

if (wdioExit !== 0 || !Bun.file(nativeResultPath).size) {
  throw new Error(`native Mac2 session failed (wdio=${wdioExit})\n${wdioStderr || wdioStdout}`);
}
const native = JSON.parse(readFileSync(nativeResultPath, "utf8")) as {
  ok?: boolean;
  sourceSha?: string;
  fixtureRunId?: string;
  binary?: { path?: string; hash?: string; bundlePath?: string };
  bundleId?: string;
  session?: { id?: string; capabilities?: Record<string, unknown> };
  process?: { pid?: number; startedAt?: string; executable?: string; executableHash?: string };
  quitProcess?: {
    pid?: number;
    startedAt?: string;
    executable?: string;
    executableHash?: string;
    bundleId?: string;
    aliveAfterQuit?: boolean;
  };
  scenarios?: Array<{ id?: string }>;
};
const context = JSON.parse(readFileSync(contextPath, "utf8")) as {
  bundlePath: string;
  binaryPath: string;
  binaryHash: string;
  bundleId: string;
};
const expectedScenarios = [
  "macos-shell-role-name-focus",
  "macos-open-project-cancel-focus-restore",
  "macos-open-project-real-folder",
  "macos-window-close-reopen-classification",
  "macos-native-quit",
];
const predicate = evaluateMacosShellTruth({
  expected: {
    sourceSha,
    fixtureRunId: fixture.descriptor.runId,
    binaryPath: context.binaryPath,
    binaryHash: context.binaryHash,
    bundlePath: context.bundlePath,
    bundleId: context.bundleId,
    projectRoot: fixture.descriptor.projectRoot,
    systemPort: fixture.descriptor.vitePort,
    scenarioIds: expectedScenarios,
  },
  observed: native,
  cleanupDetected: cleanup?.detected ?? ["cleanup missing"],
  developerStateUnchanged: hashFile(canary) === developerHash,
});
if (!Object.values(predicate).every(Boolean)) {
  throw new Error(`native macOS predicate failed: ${JSON.stringify(predicate)}`);
}
const leaked = scanSecret(durableDir, fixture.authorityToken);
if (leaked.length > 0)
  throw new Error(`fixture authority leaked into H06 evidence: ${leaked.join(",")}`);
const environment = {
  macosVersion: run(["sw_vers", "-productVersion"]),
  macosBuild: run(["sw_vers", "-buildVersion"]),
  machineClass: run(["sysctl", "-n", "hw.model"]),
  xcode: run(["xcodebuild", "-version"]),
  appium: "3.5.2",
  mac2: "4.0.3",
  node: "24.15.0",
  consoleUser: run(["stat", "-f", "%Su", "/dev/console"]),
  displaySession: Boolean(
    process.env.DISPLAY || process.env.TERM_PROGRAM || process.env.SSH_TTY === undefined,
  ),
};
const oracle = { ok: true, predicate, environment, cleanup, native, artifactDir: durableDir };
const oraclePath = join(durableDir, "oracle.json");
writeFileSync(oraclePath, `${JSON.stringify(oracle, null, 2)}\n`);
writeVerifiedEvidence({
  repo,
  claimId: "claim-native-macos-shell",
  oracleCommand: "bun run verify:macos",
  expectedPredicate:
    "the H06 development Mac2 ledger passes with exact source/app hash, bundle ID, driver session, semantic accessibility locators, focus restoration, and cleanup",
  controlId: nativeMacosControlId,
  fixturePath: contextPath,
  commandPath: join(repo, "scripts/verify-macos.ts"),
  implementationPaths: [
    join(repo, "package.json"),
    join(repo, "bun.lock"),
    join(repo, "scripts/verify-macos.ts"),
    join(repo, "scripts/doctor-macos-driver.ts"),
    join(repo, "scripts/harness/macos-driver.ts"),
    join(repo, "scripts/harness/macos-domain-truth.ts"),
    join(repo, "scripts/harness/macos-ledger-monitor.ts"),
    join(repo, "scripts/harness/native-macos-control.ts"),
    join(repo, "wdio.macos.conf.ts"),
    join(repo, "e2e/macos/runtime.ts"),
    join(repo, "e2e/macos/native-shell.spec.ts"),
    join(repo, "artifacts/specs/harness-scenarios/macos.json"),
    join(repo, "app/src-tauri/src/lib.rs"),
  ],
  generatedPaths: [
    nativeResultPath,
    join(durableDir, "native-shell.png"),
    join(durableDir, "doctor.json"),
    join(durableDir, "wdio.stdout.log"),
    join(durableDir, "wdio.stderr.log"),
    join(durableDir, "appium.stdout.log"),
    join(durableDir, "appium.stderr.log"),
    join(durableDir, "ledger-monitor.stdout.log"),
    join(durableDir, "ledger-monitor.stderr.log"),
    oraclePath,
  ],
  artifactPaths: [context.bundlePath, context.binaryPath],
  result: oracle,
  controlPlan: {
    control_id: nativeMacosControlId,
    before_hash: control.beforeHash,
    mutated_hash: control.mutatedHash,
    manifestPath: control.manifestPath,
    manifestHash: hashFile(control.manifestPath),
  },
  scenarioPath: join(repo, "artifacts/specs/harness-scenarios/macos.json"),
  executedScenarioIds: expectedScenarios,
});
console.log(JSON.stringify(oracle));
