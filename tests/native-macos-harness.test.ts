import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GO_TO_FOLDER_KEYSTROKE,
  NATIVE_ELEMENT_TYPE,
  NATIVE_PANEL_ROOT_TYPES,
  OPEN_PANEL_IDENTIFIER,
  type PreviewSidecarObservation,
  PreviewSidecarWaitError,
  countNativeElements,
  enabledTextFieldPredicate,
  nativePredicate,
  observePreviewSidecars,
  waitForPreviewSidecar,
} from "../e2e/macos/runtime";
import { createFixture, hashFile } from "../scripts/harness/fixture";
import {
  type MacosShellTruthInput,
  evaluateMacosShellTruth,
  evaluateResidualDialogControl,
} from "../scripts/harness/macos-domain-truth";
import {
  type TimedCommand,
  buildMacosBlockedEvidence,
  classifyXcodeFirstLaunch,
} from "../scripts/harness/macos-driver";
import { nativeMacosOracleImplementationPaths } from "../scripts/harness/macos-evidence-contract";
import {
  dedicatedMacosRunnerGuidance,
  evaluateMacosRunnerPolicy,
} from "../scripts/harness/macos-runner-policy";
import { prepareNativeMacosControl } from "../scripts/harness/native-macos-control";

function macosPolicySubprocess(
  script: string,
  options: {
    optIn?: boolean;
    policyOnly?: boolean;
    args?: string[];
    allowSafeGit?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "vean-macos-policy-"));
  const home = join(root, "home");
  const isolatedTmp = join(root, "tmp");
  const bin = join(root, "bin");
  const launchSentinel = join(root, "launch-attempts.txt");
  mkdirSync(home);
  mkdirSync(isolatedTmp);
  mkdirSync(bin);
  const commands = [
    "bun",
    "codesign",
    "mise",
    "node",
    "open",
    "xcode-select",
    "xcodebuild",
    "xcrun",
  ];
  if (!options.allowSafeGit) commands.push("git");
  for (const command of commands) {
    const shim = join(bin, command);
    writeFileSync(shim, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$VEAN_LAUNCH_SENTINEL"\nexit 97\n');
    chmodSync(shim, 0o700);
  }
  const {
    VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION: _allow,
    VEAN_MACOS_RUNNER_CLASS: _runner,
    ...baseEnv
  } = process.env;
  const bun = spawnSync("which", ["bun"], { encoding: "utf8" }).stdout.trim();
  if (!bun) throw new Error("Bun executable is unavailable");
  const result = spawnSync(
    bun,
    [script, ...(options.args ?? []), ...(options.policyOnly ? ["--policy-only"] : [])],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...baseEnv,
        HOME: home,
        TMPDIR: isolatedTmp,
        PATH: `${bin}:${baseEnv.PATH ?? ""}`,
        VEAN_LAUNCH_SENTINEL: launchSentinel,
        ...(options.optIn
          ? {
              VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION: "1",
              VEAN_MACOS_RUNNER_CLASS: "dedicated",
            }
          : {}),
      },
    },
  );
  return { root, home, isolatedTmp, launchSentinel, result };
}

function firstLaunch(overrides: Partial<TimedCommand> = {}): TimedCommand {
  return {
    command: ["xcodebuild", "-checkFirstLaunchStatus"],
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 20,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

function nativeProcessIdentity(
  pid: number,
  parentPid: number,
  command: string,
): PreviewSidecarObservation["observed"][number] {
  return {
    pid,
    parentPid,
    processGroup: pid,
    processMarker: `process-${pid}`,
    executable: "/opt/homebrew/bin/bun",
    command,
    startedAt: `start-${pid}`,
    executableHash: `${pid}`.padStart(64, "0"),
  };
}

describe("native macOS doctor classification", () => {
  it("binds the native app to the exact Bun executable instead of LaunchServices PATH", () => {
    const source = readFileSync(join(process.cwd(), "scripts/verify-macos.ts"), "utf8");
    expect(source).toContain("VEAN_BIN: realpathSync(process.execPath)");
    expect(source).not.toContain('VEAN_BIN: "bun"');
  });

  it.each(["scripts/doctor-macos-driver.ts", "scripts/verify-macos.ts"])(
    "%s refuses a shared desktop before fixture, driver, build, or app launch",
    (script) => {
      const run = macosPolicySubprocess(script);
      try {
        expect(run.result.status).toBe(1);
        const output = JSON.parse(run.result.stdout) as Record<string, unknown>;
        expect(output).toMatchObject({
          ok: false,
          status: "blocked_with_user_decision",
          predicate_met: false,
          policy_predicate_met: false,
          session_verified: false,
          reasonCode: "E_INTERACTIVE_DESKTOP_OPT_IN",
          guidance: dedicatedMacosRunnerGuidance,
        });
        expect(run.result.stderr).toBe("");
        expect(existsSync(join(run.home, ".appium"))).toBe(false);
        expect(readdirSync(run.isolatedTmp)).toEqual([]);
        expect(existsSync(run.launchSentinel)).toBe(false);
      } finally {
        rmSync(run.root, { recursive: true, force: true });
      }
    },
  );

  it.each(["scripts/doctor-macos-driver.ts", "scripts/verify-macos.ts"])(
    "%s policy-only accepts the exact dedicated-runner opt-in without claiming a session",
    (script) => {
      const run = macosPolicySubprocess(script, { optIn: true, policyOnly: true });
      try {
        expect(run.result.status).toBe(0);
        expect(JSON.parse(run.result.stdout)).toMatchObject({
          ok: true,
          status: "policy_gate_passed",
          predicate_met: false,
          policy_predicate_met: true,
          session_verified: false,
          reasonCode: "MACOS_INTERACTIVE_POLICY_READY",
        });
        expect(run.result.stderr).toBe("");
        expect(existsSync(join(run.home, ".appium"))).toBe(false);
        expect(readdirSync(run.isolatedTmp)).toEqual([]);
        expect(existsSync(run.launchSentinel)).toBe(false);
      } finally {
        rmSync(run.root, { recursive: true, force: true });
      }
    },
  );

  it("requires both exact opt-in values", () => {
    expect(evaluateMacosRunnerPolicy({})).toMatchObject({ ok: false });
    expect(
      evaluateMacosRunnerPolicy({
        VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION: "1",
      }),
    ).toMatchObject({ ok: false });
    expect(evaluateMacosRunnerPolicy({ VEAN_MACOS_RUNNER_CLASS: "dedicated" })).toMatchObject({
      ok: false,
    });
    expect(
      evaluateMacosRunnerPolicy({
        VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION: "true",
        VEAN_MACOS_RUNNER_CLASS: "dedicated",
      }),
    ).toMatchObject({ ok: false });
    expect(
      evaluateMacosRunnerPolicy({
        VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION: "1",
        VEAN_MACOS_RUNNER_CLASS: "shared",
      }),
    ).toMatchObject({ ok: false });
  });

  it("closes its fixture after a synthetic post-fixture error without native launch", () => {
    const run = macosPolicySubprocess("scripts/doctor-macos-driver.ts", {
      optIn: true,
      allowSafeGit: true,
      args: ["--json", "--simulate-internal-error-after-fixture"],
    });
    try {
      expect(run.result.status).toBe(1);
      const output = JSON.parse(run.result.stdout) as {
        reasonCode?: string;
        failures?: Array<{ detail?: string }>;
        checks?: { cleanup?: { detected?: unknown[] } };
      };
      expect(output.reasonCode).toBe("E_MACOS_DOCTOR_INTERNAL");
      expect(output.failures?.[0]?.detail).toContain("SYNTHETIC_DOCTOR_INTERNAL_ERROR");
      expect(output.checks?.cleanup?.detected).toEqual([]);
      expect(run.result.stderr).toBe("");
      expect(existsSync(join(run.home, ".appium"))).toBe(false);
      expect(readdirSync(run.isolatedTmp)).toEqual(["vean-harness-port-leases"]);
      expect(readdirSync(join(run.isolatedTmp, "vean-harness-port-leases"))).toEqual([]);
      expect(existsSync(run.launchSentinel)).toBe(false);
    } finally {
      rmSync(run.root, { recursive: true, force: true });
    }
  });

  it("replaces only the poisoned fixture DB before isolated project initialization", async () => {
    const base = mkdtempSync(join(tmpdir(), "vean-h06-db-regression-"));
    const canary = join(base, "developer-state-canary");
    const fixture = await createFixture({
      sourceSha: "h06-db-regression",
      developerCanary: canary,
      baseDir: base,
    });
    const developerHash = hashFile(canary);
    const command = [
      "src/cli.ts",
      "project",
      "init",
      "--repo",
      fixture.descriptor.projectRoot,
      "--json",
    ];
    const options = {
      cwd: process.cwd(),
      encoding: "utf8" as const,
      env: {
        ...process.env,
        HOME: fixture.descriptor.home,
        VEAN_CONFIG_HOME: join(fixture.descriptor.home, ".vean"),
      },
    };
    try {
      expect(readFileSync(fixture.descriptor.database, "utf8")).toMatch(/^fixture-db:/);
      const poisoned = spawnSync("bun", command, options);
      expect(poisoned.status).not.toBe(0);
      expect(`${poisoned.stdout}\n${poisoned.stderr}`).toContain("file is not a database");

      rmSync(fixture.descriptor.database, { force: true });
      const initialized = spawnSync("bun", command, options);
      expect(initialized.status).toBe(0);
      expect(readFileSync(fixture.descriptor.database).subarray(0, 16).toString()).toBe(
        "SQLite format 3\u0000",
      );
      expect(hashFile(canary)).toBe(developerHash);
    } finally {
      await fixture.close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("prepares a real non-no-op Rust menu label mutation", () => {
    const control = prepareNativeMacosControl();
    expect(control.beforeHash).not.toBe(control.mutatedHash);
    expect(control.target).toMatch(/app\/src-tauri\/src\/lib\.rs$/);
  });

  it("accepts only a completed Xcode first-launch check", () => {
    expect(classifyXcodeFirstLaunch(firstLaunch())).toBeNull();
  });

  it("preserves exit 69 as an external first-launch gate", () => {
    expect(classifyXcodeFirstLaunch(firstLaunch({ exitCode: 69 }))).toEqual({
      code: "E_XCODE_FIRST_LAUNCH",
      detail: "xcodebuild -checkFirstLaunchStatus exited 69",
      userAction:
        "Complete Xcode first-launch setup interactively; the harness never runs the privileged repair.",
    });
  });

  it("preserves a timeout without attempting the privileged repair", () => {
    expect(
      classifyXcodeFirstLaunch(
        firstLaunch({ exitCode: null, signal: "SIGTERM", timedOut: true, durationMs: 15_001 }),
      ),
    ).toEqual({
      code: "E_XCODE_FIRST_LAUNCH",
      detail: "xcodebuild -checkFirstLaunchStatus timed out after 15001ms",
      userAction:
        "Complete Xcode first-launch setup interactively; the harness never runs the privileged repair.",
    });
  });

  it("emits structured blocked evidence without claiming a Mac2 session", () => {
    const observed = firstLaunch({ exitCode: 69 });
    const finding = classifyXcodeFirstLaunch(observed);
    if (!finding) throw new Error("expected a blocked finding");
    const evidence = buildMacosBlockedEvidence({
      finding,
      versions: { xcode: "26.6", appium: "3.5.2", mac2: "4.0.3" },
      observedCheck: observed,
      sourceSha: "abc123",
      fixtureRunId: "fixture-1",
      timestamp: "2026-07-12T00:00:00.000Z",
    });
    expect(evidence).toMatchObject({
      claim_id: "claim-native-macos-shell",
      status: "blocked_with_user_decision",
      predicate_met: false,
      blocked_command: ["xcodebuild", "-checkFirstLaunchStatus"],
      detail: "xcodebuild -checkFirstLaunchStatus exited 69",
      source_sha: "abc123",
    });
    expect(evidence).not.toHaveProperty("session");
  });
});

describe("Mac2 accessibility XML inventory", () => {
  it("builds numeric Mac2 predicates rather than symbolic enum operands", () => {
    expect(nativePredicate(NATIVE_ELEMENT_TYPE.Window, "title == 'vean'")).toBe(
      "-ios predicate string:elementType == 4 AND (title == 'vean')",
    );
    expect(nativePredicate(NATIVE_ELEMENT_TYPE.TextField)).toBe(
      "-ios predicate string:elementType == 49",
    );
    expect(nativePredicate(NATIVE_ELEMENT_TYPE.MenuBarItem)).not.toContain("XCUIElementType");
  });

  it("scopes the Go-to-folder field to a distinct native panel root and enabled semantics", () => {
    expect(NATIVE_PANEL_ROOT_TYPES).toEqual([
      NATIVE_ELEMENT_TYPE.Sheet,
      NATIVE_ELEMENT_TYPE.Dialog,
    ]);
    expect(OPEN_PANEL_IDENTIFIER).toBe("open-panel");
    expect(enabledTextFieldPredicate()).toBe(
      "-ios predicate string:elementType == 49 AND (enabled == true)",
    );
    expect(NATIVE_ELEMENT_TYPE.SearchField).toBe(45);
  });

  it("uses Mac2's explicit Shift-Command-G key payload", () => {
    expect(GO_TO_FOLDER_KEYSTROKE).toEqual({ key: "g", modifierFlags: 18 });
  });

  it("rejects focused as an unsupported Mac2 search-predicate key", () => {
    expect(() =>
      nativePredicate(NATIVE_ELEMENT_TYPE.TextField, "focused == true AND enabled == true"),
    ).toThrow(/does not expose 'focused' as an XCTest predicate key/);
    expect(nativePredicate(NATIVE_ELEMENT_TYPE.TextField, "enabled == true")).toContain(
      "enabled == true",
    );
  });

  it("wires focus as a post-selection attribute and never as the shortcut predicate", () => {
    const source = readFileSync(join(process.cwd(), "e2e/macos/native-shell.spec.ts"), "utf8");
    expect(source).toContain('browser.execute("macos: keys", { keys: [GO_TO_FOLDER_KEYSTROKE] })');
    expect(source).not.toContain(
      'browser.execute("macos: keys", [{ keys: [GO_TO_FOLDER_KEYSTROKE] }])',
    );
    expect(source).toContain('location.getAttribute("focused")');
    expect(source).toContain("excludedAsOpenPanel");
    expect(source).not.toContain('browser.keys(["Shift", "Command", "g"])');
    expect(source).not.toContain('nativePredicate(NATIVE_ELEMENT_TYPE.TextField, "focused');
  });

  it("counts Window, Dialog, and Sheet opening tags with attributes and newlines", () => {
    const source = `
      <XCUIElementTypeWindow title="vean">
        <XCUIElementTypeDialog
          title="Confirm">
          <XCUIElementTypeSheet enabled="true"></XCUIElementTypeSheet>
        </XCUIElementTypeDialog>
      </XCUIElementTypeWindow>
    `;
    expect(countNativeElements(source, "XCUIElementTypeWindow")).toBe(1);
    expect(countNativeElements(source, "XCUIElementTypeDialog")).toBe(1);
    expect(countNativeElements(source, "XCUIElementTypeSheet")).toBe(1);
  });

  it("counts multiple elements and ignores closing tags", () => {
    const source =
      "<XCUIElementTypeWindow></XCUIElementTypeWindow>" +
      "<XCUIElementTypeWindow title='second'></XCUIElementTypeWindow>";
    expect(countNativeElements(source, "XCUIElementTypeWindow")).toBe(2);
  });

  it("returns zero when the requested element is absent", () => {
    expect(
      countNativeElements(
        "<XCUIElementTypeApplication></XCUIElementTypeApplication>",
        "XCUIElementTypeSheet",
      ),
    ).toBe(0);
  });

  it("rejects substring collisions and attribute-name imitations", () => {
    const source = `
      <XCUIElementTypeWindowDecoration></XCUIElementTypeWindowDecoration>
      <node type="XCUIElementTypeWindow"></node>
      text &lt;XCUIElementTypeWindow&gt;
    `;
    expect(countNativeElements(source, "XCUIElementTypeWindow")).toBe(0);
  });
});

describe("native preview sidecar polling", () => {
  it("accepts macOS canonical /private path aliases without accepting prefix collisions", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vean-sidecar-alias-"));
    const canonical = realpathSync(projectRoot);
    const exact = nativeProcessIdentity(206, 101, `bun src/cli.ts preview --repo ${canonical}`);
    const prefixDecoy = nativeProcessIdentity(
      207,
      101,
      `bun src/cli.ts preview --repo ${canonical}-other`,
    );
    try {
      const observed = observePreviewSidecars(101, projectRoot, {
        listChildPids: () => [206, 207],
        observeProcess: (pid) => (pid === 206 ? exact : prefixDecoy),
      });
      expect(observed.matching).toEqual([exact]);
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("waits through a no-child observation for one exact delayed preview sidecar", async () => {
    let polls = 0;
    let clock = 0;
    const sidecar = nativeProcessIdentity(
      202,
      101,
      "bun src/cli.ts preview --no-open --prod --repo /tmp/project",
    );
    const observed = await waitForPreviewSidecar(101, "/tmp/project", {
      timeoutMs: 1_000,
      intervalMs: 25,
      dependencies: {
        listChildPids: () => (++polls === 1 ? [] : [202]),
        observeProcess: () => sidecar,
        now: () => clock,
        sleep: async (durationMs) => {
          clock += durationMs;
        },
      },
    });
    expect(observed).toEqual(sidecar);
    expect(polls).toBe(2);
  });

  it("times out with wrong-child identity retained as evidence", async () => {
    let clock = 0;
    const wrong = nativeProcessIdentity(203, 101, "bun unrelated.ts --repo /tmp/project");
    const run = waitForPreviewSidecar(101, "/tmp/project", {
      timeoutMs: 5,
      intervalMs: 5,
      dependencies: {
        listChildPids: () => [203],
        observeProcess: () => wrong,
        now: () => clock,
        sleep: async (durationMs) => {
          clock += durationMs;
        },
      },
    });
    await expect(run).rejects.toMatchObject({
      reasonCode: "E_H06_PREVIEW_SIDECAR_TIMEOUT",
      observation: { childPids: [203], observed: [wrong], matching: [] },
    });
  });

  it("rejects multiple exact preview children immediately", async () => {
    const first = nativeProcessIdentity(204, 101, "bun src/cli.ts preview --repo /tmp/project");
    const second = nativeProcessIdentity(205, 101, "bun src/cli.ts preview --repo /tmp/project");
    const run = waitForPreviewSidecar(101, "/tmp/project", {
      dependencies: {
        listChildPids: () => [204, 205],
        observeProcess: (pid) => (pid === 204 ? first : second),
      },
    });
    const error = await run.catch((caught) => caught);
    expect(error).toBeInstanceOf(PreviewSidecarWaitError);
    expect(error).toMatchObject({
      reasonCode: "E_H06_PREVIEW_SIDECAR_AMBIGUOUS",
    });
  });
});

const scenarioIds = [
  "macos-shell-role-name-focus",
  "macos-open-project-cancel-focus-restore",
  "macos-open-project-real-folder",
  "macos-window-close-reopen-classification",
  "macos-native-quit",
];

function validTruth(): MacosShellTruthInput {
  return {
    expected: {
      sourceSha: "sha",
      fixtureRunId: "fixture",
      binaryPath: "/tmp/vean.app/Contents/MacOS/vean",
      binaryHash: "binary-hash",
      bundlePath: "/tmp/vean.app",
      bundleId: "studio.vean.h06.fixture",
      projectRoot: "/tmp/project",
      systemPort: 10123,
      scenarioIds,
    },
    observed: {
      ok: true,
      sourceSha: "sha",
      fixtureRunId: "fixture",
      binary: {
        path: "/tmp/vean.app/Contents/MacOS/vean",
        hash: "binary-hash",
        bundlePath: "/tmp/vean.app",
      },
      process: {
        pid: 100,
        startedAt: "start-one",
        executable: "/tmp/vean.app/Contents/MacOS/vean",
        executableHash: "binary-hash",
      },
      quitProcess: {
        pid: 101,
        startedAt: "start-two",
        executable: "/tmp/vean.app/Contents/MacOS/vean",
        executableHash: "binary-hash",
        bundleId: "studio.vean.h06.fixture",
        aliveAfterQuit: false,
      },
      bundleId: "studio.vean.h06.fixture",
      session: {
        id: "mac2-session",
        capabilities: {
          platformName: "mac",
          "appium:automationName": "Mac2",
          "appium:systemPort": 10123,
          "appium:bundleId": "studio.vean.h06.fixture",
          "appium:appPath": "/tmp/vean.app",
        },
      },
      scenarios: [
        {
          id: scenarioIds[0],
          role: "XCUIElementTypeWindow",
          title: "vean",
          label: "",
          focused: "true",
        },
        {
          id: scenarioIds[1],
          focusRestored: true,
          residual: { dialogs: 0, sheets: 0 },
        },
        {
          id: scenarioIds[2],
          selectedFolder: "/tmp/project",
          focusRestored: true,
          sidecar: {
            parentPid: 100,
            command: "bun src/cli.ts preview --no-open --prod --repo /tmp/project",
          },
        },
        {
          id: scenarioIds[3],
          closeAccessibleName: "_XCUI:CloseWindow",
          windowsAfterClose: 0,
          reopenSupportedByProduct: false,
          appExitedAfterClose: false,
          automationTerminateAfterClose: true,
          automationRelaunchForQuit: true,
        },
        { id: scenarioIds[4], accessibleName: "Quit vean" },
      ],
    },
    cleanupDetected: [],
    developerStateUnchanged: true,
    runnerPolicy: evaluateMacosRunnerPolicy({
      VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION: "1",
      VEAN_MACOS_RUNNER_CLASS: "dedicated",
    }),
  };
}

describe("native macOS domain truth", () => {
  it("accepts a fully bound semantic shell result", () => {
    expect(Object.values(evaluateMacosShellTruth(validTruth())).every(Boolean)).toBe(true);
  });

  it("accepts the observed last-window lifecycle when close exits the app itself", () => {
    const input = validTruth();
    const close = input.observed.scenarios?.find(
      (candidate) => candidate.id === "macos-window-close-reopen-classification",
    );
    if (!close) throw new Error("close scenario missing from valid fixture");
    close.appExitedAfterClose = true;
    close.automationTerminateAfterClose = false;
    expect(evaluateMacosShellTruth(input).honestWindowLifecycle).toBe(true);
  });

  for (const [name, mutate, failedPredicate] of [
    [
      "missing dedicated-runner opt-in",
      (input: MacosShellTruthInput) => {
        input.runnerPolicy = evaluateMacosRunnerPolicy({});
      },
      "dedicatedRunnerPolicy",
    ],
    [
      "replayed initial process as relaunch",
      (input: MacosShellTruthInput) => {
        if (input.observed.process && input.observed.quitProcess) {
          input.observed.quitProcess.pid = input.observed.process.pid;
          input.observed.quitProcess.startedAt = input.observed.process.startedAt;
        }
      },
      "independentlyObservedQuitProcess",
    ],
    [
      "substituted Mac2 session capability",
      (input: MacosShellTruthInput) => {
        const capabilities = input.observed.session?.capabilities;
        if (capabilities) capabilities["appium:systemPort"] = 9999;
      },
      "driverSession",
    ],
    [
      "substituted executable",
      (input: MacosShellTruthInput) => {
        if (input.observed.process) input.observed.process.executableHash = "substituted";
      },
      "independentlyObservedInitialProcess",
    ],
    [
      "unfocused shell",
      (input: MacosShellTruthInput) => {
        const role = input.observed.scenarios?.[0];
        if (role) role.focused = "false";
      },
      "windowRoleNameFocus",
    ],
    [
      "residual cancel dialog",
      (input: MacosShellTruthInput) => {
        const cancel = input.observed.scenarios?.[1];
        if (cancel) cancel.residual = { dialogs: 1, sheets: 0 };
      },
      "cancelFocusAndDialogCleanup",
    ],
    [
      "wrong selected-folder sidecar",
      (input: MacosShellTruthInput) => {
        const select = input.observed.scenarios?.[2];
        if (select) select.sidecar = { parentPid: 999, command: "preview --repo /tmp/other" };
      },
      "selectedFolderAndSidecar",
    ],
    [
      "window still open",
      (input: MacosShellTruthInput) => {
        const close = input.observed.scenarios?.[3];
        if (close) close.windowsAfterClose = 1;
      },
      "honestWindowLifecycle",
    ],
    [
      "nonsemantic quit",
      (input: MacosShellTruthInput) => {
        const quit = input.observed.scenarios?.[4];
        if (quit) quit.accessibleName = "";
      },
      "semanticQuit",
    ],
    [
      "post-quit app leak",
      (input: MacosShellTruthInput) => {
        if (input.observed.quitProcess) input.observed.quitProcess.aliveAfterQuit = true;
      },
      "independentlyObservedQuitProcess",
    ],
    [
      "watchdog residual",
      (input: MacosShellTruthInput) => {
        input.cleanupDetected.push("app:100");
      },
      "noResidualHarnessResources",
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      const input = validTruth();
      mutate(input);
      expect(evaluateMacosShellTruth(input)[failedPredicate]).toBe(false);
    });
  }

  it("rejects a residual marker without an actual native dialog inventory", () => {
    expect(
      evaluateResidualDialogControl({
        markerSeen: true,
        record: { residualDialogControl: true, residual: { dialogs: 0, sheets: 0 } },
        cleanupDetected: [],
      }),
    ).toMatchObject({ nativeDialogObserved: false });
  });

  it("accepts residual-dialog detection only after clean forced teardown", () => {
    expect(
      Object.values(
        evaluateResidualDialogControl({
          markerSeen: true,
          record: { residualDialogControl: true, residual: { dialogs: 1, sheets: 0 } },
          cleanupDetected: [],
        }),
      ).every(Boolean),
    ).toBe(true);
  });
});

describe("native macOS evidence authority", () => {
  it("keeps the evidence writer's exact implementation set aligned with the manifest", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(process.cwd(), "artifacts/specs/tauri-react-remotion-harness-truth-manifest.json"),
        "utf8",
      ),
    ) as {
      claims: Array<{ claim_id: string; oracle_implementation_paths: string[] }>;
    };
    const claim = manifest.claims.find(
      (candidate) => candidate.claim_id === "claim-native-macos-shell",
    );
    expect(claim?.oracle_implementation_paths).toEqual([...nativeMacosOracleImplementationPaths]);
    for (const path of nativeMacosOracleImplementationPaths) {
      expect(existsSync(join(process.cwd(), path)), path).toBe(true);
    }
  });
});
