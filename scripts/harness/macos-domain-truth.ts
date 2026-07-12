export type MacosShellTruthInput = {
  expected: {
    sourceSha: string;
    fixtureRunId: string;
    binaryPath: string;
    binaryHash: string;
    bundlePath: string;
    bundleId: string;
    projectRoot: string;
    scenarioIds: string[];
  };
  observed: {
    ok?: boolean;
    sourceSha?: string;
    fixtureRunId?: string;
    binary?: { path?: string; hash?: string; bundlePath?: string };
    process?: { pid?: number; executable?: string; executableHash?: string };
    quitProcess?: {
      pid?: number;
      executable?: string;
      executableHash?: string;
      bundleId?: string;
      aliveAfterQuit?: boolean;
    };
    bundleId?: string;
    session?: { id?: string };
    scenarios?: Array<Record<string, unknown> & { id?: string }>;
  };
  cleanupDetected: unknown[];
  developerStateUnchanged: boolean;
};

function truthy(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function scenario(input: MacosShellTruthInput, id: string): Record<string, unknown> | undefined {
  return input.observed.scenarios?.find((candidate) => candidate.id === id);
}

export function evaluateMacosShellTruth(input: MacosShellTruthInput): Record<string, boolean> {
  const role = scenario(input, "macos-shell-role-name-focus");
  const cancel = scenario(input, "macos-open-project-cancel-focus-restore");
  const select = scenario(input, "macos-open-project-real-folder");
  const close = scenario(input, "macos-window-close-reopen-classification");
  const quit = scenario(input, "macos-native-quit");
  const sidecar = select?.sidecar as
    | { parentPid?: number; command?: string; executable?: string }
    | undefined;
  const process = input.observed.process;
  const quitProcess = input.observed.quitProcess;
  const ids = input.observed.scenarios?.map((candidate) => candidate.id).filter(Boolean) ?? [];
  return {
    nativeResult: input.observed.ok === true,
    sourceAndFixture:
      input.observed.sourceSha === input.expected.sourceSha &&
      input.observed.fixtureRunId === input.expected.fixtureRunId,
    exactReportedArtifact:
      input.observed.binary?.path === input.expected.binaryPath &&
      input.observed.binary?.hash === input.expected.binaryHash &&
      input.observed.binary?.bundlePath === input.expected.bundlePath,
    independentlyObservedInitialProcess:
      process?.executable === input.expected.binaryPath &&
      process?.executableHash === input.expected.binaryHash &&
      Number.isInteger(process.pid) &&
      input.observed.bundleId === input.expected.bundleId,
    independentlyObservedQuitProcess:
      quitProcess?.executable === input.expected.binaryPath &&
      quitProcess?.executableHash === input.expected.binaryHash &&
      Number.isInteger(quitProcess.pid) &&
      quitProcess?.bundleId === input.expected.bundleId &&
      quitProcess.aliveAfterQuit === false,
    driverSession: Boolean(input.observed.session?.id),
    exactScenarioLedger:
      ids.length === input.expected.scenarioIds.length &&
      input.expected.scenarioIds.every((id) => ids.includes(id)),
    windowRoleNameFocus:
      role?.role === "XCUIElementTypeWindow" &&
      (role.title === "vean" || role.label === "vean") &&
      truthy(role.focused),
    cancelFocusAndDialogCleanup:
      cancel?.focusRestored === true &&
      (cancel.residual as { dialogs?: number } | undefined)?.dialogs === 0 &&
      (cancel.residual as { sheets?: number } | undefined)?.sheets === 0,
    selectedFolderAndSidecar:
      select?.selectedFolder === input.expected.projectRoot &&
      select?.focusRestored === true &&
      sidecar?.parentPid === process?.pid &&
      Boolean(sidecar?.command?.includes("src/cli.ts preview")) &&
      Boolean(sidecar?.command?.includes(`--repo ${input.expected.projectRoot}`)),
    honestWindowLifecycle:
      close?.windowsAfterClose === 0 &&
      close?.reopenSupportedByProduct === false &&
      close?.automationTerminateAfterClose === true &&
      close?.automationRelaunchForQuit === true,
    semanticQuit:
      typeof quit?.accessibleName === "string" && quit.accessibleName.startsWith("Quit"),
    noResidualHarnessResources: input.cleanupDetected.length === 0,
    developerStateUnchanged: input.developerStateUnchanged,
  };
}
