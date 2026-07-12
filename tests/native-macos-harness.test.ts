import { describe, expect, it } from "vitest";
import {
  type MacosShellTruthInput,
  evaluateMacosShellTruth,
} from "../scripts/harness/macos-domain-truth";
import {
  type TimedCommand,
  buildMacosBlockedEvidence,
  classifyXcodeFirstLaunch,
} from "../scripts/harness/macos-driver";
import { prepareNativeMacosControl } from "../scripts/harness/native-macos-control";

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

describe("native macOS doctor classification", () => {
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
        executable: "/tmp/vean.app/Contents/MacOS/vean",
        executableHash: "binary-hash",
      },
      quitProcess: {
        pid: 101,
        executable: "/tmp/vean.app/Contents/MacOS/vean",
        executableHash: "binary-hash",
        bundleId: "studio.vean.h06.fixture",
        aliveAfterQuit: false,
      },
      bundleId: "studio.vean.h06.fixture",
      session: { id: "mac2-session" },
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
          windowsAfterClose: 0,
          reopenSupportedByProduct: false,
          automationTerminateAfterClose: true,
          automationRelaunchForQuit: true,
        },
        { id: scenarioIds[4], accessibleName: "Quit vean" },
      ],
    },
    cleanupDetected: [],
    developerStateUnchanged: true,
  };
}

describe("native macOS domain truth", () => {
  it("accepts a fully bound semantic shell result", () => {
    expect(Object.values(evaluateMacosShellTruth(validTruth())).every(Boolean)).toBe(true);
  });

  for (const [name, mutate, failedPredicate] of [
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
});
