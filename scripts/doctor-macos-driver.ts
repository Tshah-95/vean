#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { remote } from "webdriverio";
import { hashPath } from "./harness/evidence";
import { createFixture } from "./harness/fixture";
import {
  APPIUM_VERSION,
  MAC2_VERSION,
  MACOS_NODE_VERSION,
  classifyXcodeFirstLaunch,
  ensureMac2Installed,
  pinnedNodeCommand,
  runTimed,
  waitForAppium,
} from "./harness/macos-driver";
import { recordProcess } from "./harness/process-ledger";

const repo = resolve(import.meta.dirname, "..");
const json = process.argv.includes("--json");
const checks: Record<string, unknown> = {};
const failures: Array<{ code: string; detail: string; userAction?: string }> = [];
const developerAppiumHome = join(homedir(), ".appium");
const developerAppiumBefore = existsSync(developerAppiumHome)
  ? hashPath(developerAppiumHome)
  : null;
const canary = join(repo, ".vean/harness/developer-state-canary");
mkdirSync(join(repo, ".vean/harness"), { recursive: true });
const fixture = await createFixture({
  sourceSha: Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo }).stdout.toString().trim(),
  developerCanary: canary,
});
const fixtureAppiumHome = join(fixture.root, "appium-home");
const localMac2Path = join(repo, "node_modules/appium-mac2-driver");
checks.localDriverSource = {
  path: localMac2Path,
  hash: hashPath(localMac2Path),
  manifestHash: hashPath(join(localMac2Path, "package.json")),
};

function fail(code: string, detail: string, userAction?: string): void {
  failures.push({ code, detail, ...(userAction ? { userAction } : {}) });
}

if (process.platform !== "darwin") fail("E_MACOS_REQUIRED", process.platform);

const packageJson = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
};
checks.packagePins = {
  appium: packageJson.devDependencies?.appium,
  mac2: packageJson.devDependencies?.["appium-mac2-driver"],
  webdriverio: packageJson.devDependencies?.webdriverio,
};
if (packageJson.devDependencies?.appium !== APPIUM_VERSION)
  fail("E_APPIUM_PIN", String(packageJson.devDependencies?.appium));
if (packageJson.devDependencies?.["appium-mac2-driver"] !== MAC2_VERSION)
  fail("E_MAC2_PIN", String(packageJson.devDependencies?.["appium-mac2-driver"]));

const node = await runTimed(["mise", "exec", `node@${MACOS_NODE_VERSION}`, "--", "node", "-v"], {
  cwd: repo,
});
checks.node = node;
if (node.exitCode !== 0 || node.stdout !== `v${MACOS_NODE_VERSION}`)
  fail("E_NODE_LTS", node.stderr || node.stdout || "pinned Node unavailable");

const xcode = await runTimed(["xcodebuild", "-version"], { cwd: repo });
const developerDir = await runTimed(["xcode-select", "-p"], { cwd: repo });
const firstLaunch = await runTimed(["xcodebuild", "-checkFirstLaunchStatus"], {
  cwd: repo,
  timeoutMs: 15_000,
});
checks.xcode = { version: xcode, developerDir, firstLaunch };
if (xcode.exitCode !== 0 || !/^Xcode\s+\d+/m.test(xcode.stdout))
  fail("E_XCODE", xcode.stderr || xcode.stdout);
if (!developerDir.stdout.endsWith("/Contents/Developer"))
  fail("E_XCODE_SELECT", developerDir.stderr || developerDir.stdout);
const firstLaunchFailure = classifyXcodeFirstLaunch(firstLaunch);
if (firstLaunchFailure)
  fail(firstLaunchFailure.code, firstLaunchFailure.detail, firstLaunchFailure.userAction);

const xcodeHelper = join(
  developerDir.stdout,
  "Platforms/MacOSX.platform/Developer/Library/Xcode/Agents/Xcode Helper.app",
);
const helperSignature = existsSync(xcodeHelper)
  ? await runTimed(["codesign", "--verify", "--deep", "--strict", xcodeHelper], { cwd: repo })
  : null;
checks.xcodeHelper = {
  path: xcodeHelper,
  exists: existsSync(xcodeHelper),
  signature: helperSignature,
};
if (!existsSync(xcodeHelper) || helperSignature?.exitCode !== 0)
  fail("E_XCODE_HELPER", helperSignature?.stderr ?? "signed Xcode Helper is absent");

let driverInstalled = false;
if (
  packageJson.devDependencies?.appium === APPIUM_VERSION &&
  packageJson.devDependencies?.["appium-mac2-driver"] === MAC2_VERSION &&
  node.exitCode === 0
) {
  const install = await ensureMac2Installed(repo, fixtureAppiumHome);
  checks.driverInstall = install;
  if (install.exitCode !== 0 || install.timedOut) {
    fail("E_MAC2_INSTALL", install.stderr || install.stdout);
  } else {
    const driverList = await runTimed(
      pinnedNodeCommand(repo, ["driver", "list", "--installed", "--json"]),
      {
        cwd: repo,
        env: { APPIUM_HOME: fixtureAppiumHome },
      },
    );
    checks.driverList = driverList;
    let installed = false;
    try {
      const parsed = JSON.parse(driverList.stdout) as {
        mac2?: { version?: string; installed?: boolean };
      };
      installed = parsed.mac2?.version === MAC2_VERSION && parsed.mac2.installed === true;
    } catch {}
    driverInstalled = installed;
    if (!installed) fail("E_MAC2_NOT_INSTALLED", driverList.stderr || driverList.stdout);
  }
}

if (failures.length === 0 && driverInstalled) {
  const port = fixture.descriptor.webdriverPort;
  const systemPort = fixture.descriptor.vitePort;
  const [serverCommand, ...serverArgs] = pinnedNodeCommand(repo, [
    "--address",
    "127.0.0.1",
    "--port",
    String(port),
  ]);
  if (!serverCommand) throw new Error("pinned Appium server command is empty");
  const server = spawn(serverCommand, serverArgs, {
    cwd: repo,
    env: { ...process.env, APPIUM_HOME: fixtureAppiumHome },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverStdout = "";
  let serverStderr = "";
  server.stdout?.on("data", (chunk) => {
    serverStdout += String(chunk);
  });
  server.stderr?.on("data", (chunk) => {
    serverStderr += String(chunk);
  });
  if (!server.pid) throw new Error("Appium doctor server has no PID");
  const startedAt = Bun.spawnSync(["ps", "-p", String(server.pid), "-o", "lstart="], {
    cwd: repo,
  })
    .stdout.toString()
    .trim();
  recordProcess(fixture.descriptor.processLedger, {
    pid: server.pid,
    marker: `vean-h06-doctor-${fixture.descriptor.runId}`,
    executable: "appium/index.js",
    startedAt,
  });
  let session: Awaited<ReturnType<typeof remote>> | null = null;
  try {
    await waitForAppium(port);
    session = await Promise.race([
      remote({
        hostname: "127.0.0.1",
        port,
        path: "/",
        logLevel: "error",
        connectionRetryTimeout: 150_000,
        capabilities: {
          platformName: "mac",
          "appium:automationName": "Mac2",
          "appium:systemPort": systemPort,
          "appium:showServerLogs": true,
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Mac2 probe session timed out after 180s")), 180_000),
      ),
    ]);
    const source = await session.getPageSource();
    const active = await session.getActiveElement().catch(() => null);
    checks.sessionProbe = {
      sessionId: session.sessionId,
      capabilities: session.capabilities,
      accessibilityTreeBytes: Buffer.byteLength(source),
      activeElementObserved: active !== null,
    };
    if (!source.includes("XCUIElementType"))
      fail("E_ACCESSIBILITY_TREE", "Mac2 returned no native accessibility tree");
  } catch (error) {
    fail(
      "E_MAC2_SESSION_PERMISSION",
      String(error),
      `Grant Accessibility to ${xcodeHelper}, allow Xcode Automation when prompted, then rerun bun run doctor:macos-driver.`,
    );
  } finally {
    if (session) await session.deleteSession().catch(() => undefined);
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {}
    await Promise.race([
      new Promise((done) => server.once("close", done)),
      new Promise((done) => setTimeout(done, 5_000)),
    ]);
    try {
      process.kill(-server.pid, "SIGKILL");
    } catch {}
    checks.serverLogs = { stdout: serverStdout, stderr: serverStderr };
  }
}

const developerAppiumAfter = existsSync(developerAppiumHome) ? hashPath(developerAppiumHome) : null;
checks.appiumIsolation = {
  fixtureOwnedHome: fixtureAppiumHome,
  developerHome: developerAppiumHome,
  developerHashBefore: developerAppiumBefore,
  developerHashAfter: developerAppiumAfter,
};
if (developerAppiumBefore !== developerAppiumAfter) {
  fail("E_DEVELOPER_APPIUM_MUTATED", "the doctor changed ~/.appium");
}
checks.cleanup = await fixture.close();

const result = {
  ok: failures.length === 0,
  reasonCode: failures.length === 0 ? "MACOS_DRIVER_READY" : failures[0]?.code,
  versions: { node: MACOS_NODE_VERSION, appium: APPIUM_VERSION, mac2: MAC2_VERSION },
  checks,
  failures,
};
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(result.ok ? "macOS native driver is ready" : JSON.stringify(result, null, 2));
}
process.exit(result.ok ? 0 : 1);
