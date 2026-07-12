export const MACOS_AUTOMATION_OPT_IN = "VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION";
export const MACOS_RUNNER_CLASS = "VEAN_MACOS_RUNNER_CLASS";
export const MACOS_RUNNER_POLICY_ERROR = "E_INTERACTIVE_DESKTOP_OPT_IN";

export const dedicatedMacosRunnerGuidance =
  "Run H06/H08R Mac2 only inside a dedicated macOS GUI login session/runner with no human desktop activity; set VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION=1 and VEAN_MACOS_RUNNER_CLASS=dedicated there, then rerun.";

export type MacosRunnerPolicy = {
  ok: boolean;
  status: "blocked_with_user_decision" | "policy_gate_passed";
  predicate_met: false;
  policy_predicate_met: boolean;
  session_verified: false;
  reasonCode: "E_INTERACTIVE_DESKTOP_OPT_IN" | "MACOS_INTERACTIVE_POLICY_READY";
  observed: {
    interactiveAutomationOptIn: boolean;
    runnerClass: string | null;
  };
  required: {
    VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION: "1";
    VEAN_MACOS_RUNNER_CLASS: "dedicated";
  };
  guidance: string;
};

export function evaluateMacosRunnerPolicy(env: NodeJS.ProcessEnv = process.env): MacosRunnerPolicy {
  const optIn = env[MACOS_AUTOMATION_OPT_IN] === "1";
  const runnerClass = env[MACOS_RUNNER_CLASS] ?? null;
  const allowed = optIn && runnerClass === "dedicated";
  const common = {
    predicate_met: false as const,
    session_verified: false as const,
    observed: {
      interactiveAutomationOptIn: optIn,
      runnerClass,
    },
    required: {
      VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION: "1" as const,
      VEAN_MACOS_RUNNER_CLASS: "dedicated" as const,
    },
    guidance: dedicatedMacosRunnerGuidance,
  };
  return allowed
    ? {
        ...common,
        ok: true,
        status: "policy_gate_passed",
        policy_predicate_met: true,
        reasonCode: "MACOS_INTERACTIVE_POLICY_READY",
      }
    : {
        ...common,
        ok: false,
        status: "blocked_with_user_decision",
        policy_predicate_met: false,
        reasonCode: MACOS_RUNNER_POLICY_ERROR,
      };
}

/**
 * Refuse before any fixture, driver, build, or app work. A successful
 * --policy-only response proves only the runner policy, never a Mac2 session.
 */
export function enforceMacosRunnerPolicy(argv = process.argv.slice(2)): void {
  const policy = evaluateMacosRunnerPolicy();
  if (!policy.ok || argv.includes("--policy-only")) {
    console.log(JSON.stringify(policy, null, 2));
    process.exit(policy.ok ? 0 : 1);
  }
}
