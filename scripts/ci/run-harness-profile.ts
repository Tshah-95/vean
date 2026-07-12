#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";

type Policy = {
  contract_version: string;
  profile: string;
  workflow_path: string;
  required_triggers: string[];
  required_jobs: string[];
  action_pins: Record<string, string>;
  artifact: {
    name_template: string;
    path: string;
    retention_days: number;
  };
  inline_step_hashes: Record<string, string>;
  facade_script: string;
  commands: string[];
  covers: string[];
  required: boolean;
};

const root = resolve(import.meta.dirname, "../..");
const policyPath = resolve(import.meta.dirname, "harness-policy.json");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validateBootstrapPolicy(
  policy: Policy,
  workflowText: string,
  packageJson: { scripts?: Record<string, string> },
): string[] {
  const errors: string[] = [];
  if (policy.contract_version !== "1.0.0") errors.push("unsupported policy contract");
  if (policy.profile !== "bootstrap" || policy.required !== true) {
    errors.push("bootstrap profile must be required");
  }
  if (
    !policy.required_triggers.includes("push:main") ||
    !policy.required_triggers.includes("workflow_dispatch")
  ) {
    errors.push("required triggers are incomplete");
  }
  let workflow: Record<string, unknown> = {};
  try {
    const parsed = parse(workflowText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("workflow root must be a map");
    }
    workflow = parsed as Record<string, unknown>;
  } catch (error) {
    errors.push(`workflow YAML is invalid: ${String(error)}`);
    return errors;
  }
  const allowedRootKeys = ["name", "on", "permissions", "concurrency", "jobs"];
  const unknownRootKeys = Object.keys(workflow).filter((key) => !allowedRootKeys.includes(key));
  if (unknownRootKeys.length > 0) {
    errors.push(`workflow contains unknown top-level keys: ${unknownRootKeys.join(",")}`);
  }
  if (workflow.name !== "Harness") errors.push("workflow name must be Harness");
  const permissions = workflow.permissions as Record<string, unknown> | undefined;
  if (
    !permissions ||
    Object.keys(permissions).join("\0") !== "contents" ||
    permissions.contents !== "read"
  ) {
    errors.push("workflow permissions must be contents:read only");
  }
  const concurrency = workflow.concurrency as Record<string, unknown> | undefined;
  if (
    concurrency?.group !== "harness-${{ github.workflow }}-${{ github.ref }}" ||
    concurrency?.["cancel-in-progress"] !== true
  ) {
    errors.push("workflow concurrency policy is invalid");
  }
  const triggers = workflow.on;
  const triggerMap =
    typeof triggers === "object" && triggers !== null && !Array.isArray(triggers)
      ? (triggers as Record<string, unknown>)
      : {};
  const push = triggerMap.push;
  const pushMap =
    typeof push === "object" && push !== null && !Array.isArray(push)
      ? (push as Record<string, unknown>)
      : {};
  if (
    !Array.isArray(pushMap.branches) ||
    pushMap.branches.length !== 1 ||
    pushMap.branches[0] !== "main"
  ) {
    errors.push("workflow must run on push to main");
  }
  if (Object.keys(pushMap).join("\0") !== "branches") {
    errors.push("push trigger may only select the main branch");
  }
  if (
    Object.keys(triggerMap).join("\0") !== "push\0workflow_dispatch" ||
    triggerMap.workflow_dispatch !== null
  ) {
    errors.push("workflow_dispatch must be enabled without filters");
  }

  const jobs = workflow.jobs;
  const jobMap =
    typeof jobs === "object" && jobs !== null && !Array.isArray(jobs)
      ? (jobs as Record<string, unknown>)
      : {};
  if (Object.keys(jobMap).sort().join("\0") !== [...policy.required_jobs].sort().join("\0")) {
    errors.push("workflow job set does not match policy");
  }
  const bootstrap = jobMap.bootstrap;
  const bootstrapMap =
    typeof bootstrap === "object" && bootstrap !== null && !Array.isArray(bootstrap)
      ? (bootstrap as Record<string, unknown>)
      : {};
  const allowedJobKeys = ["name", "runs-on", "timeout-minutes", "steps"];
  if (Object.keys(bootstrapMap).some((key) => !allowedJobKeys.includes(key))) {
    errors.push("bootstrap job contains unapproved keys");
  }
  if (
    bootstrapMap.name !== "Harness bootstrap" ||
    bootstrapMap["runs-on"] !== "ubuntu-latest" ||
    bootstrapMap["timeout-minutes"] !== 20
  ) {
    errors.push("bootstrap runner/name/timeout policy is invalid");
  }
  if ("if" in bootstrapMap) errors.push("required bootstrap job cannot have a condition");
  if (bootstrapMap["continue-on-error"] === true) {
    errors.push("required jobs cannot continue on error");
  }
  const steps = Array.isArray(bootstrapMap.steps) ? bootstrapMap.steps : [];
  const expectedStepNames = [
    "Initialize failure evidence",
    "Check out source",
    "Set up Bun",
    "Install system dependencies",
    "Install locked dependencies",
    "Run policy-defined bootstrap",
    "Finalize structured harness evidence",
    "Upload structured harness evidence",
  ];
  const allowedStepKeys = [
    ["name", "env", "run"],
    ["name", "uses"],
    ["name", "uses", "with"],
    ["name", "run"],
    ["name", "run"],
    ["name", "env", "run"],
    ["name", "if", "env", "run"],
    ["name", "if", "uses", "with"],
  ];
  if (steps.length !== expectedStepNames.length)
    errors.push("workflow step count does not match policy");
  for (const [index, rawStep] of steps.entries()) {
    const step =
      typeof rawStep === "object" && rawStep !== null && !Array.isArray(rawStep)
        ? (rawStep as Record<string, unknown>)
        : {};
    if (step.name !== expectedStepNames[index])
      errors.push(`workflow step order mismatch at ${index}`);
    if (Object.keys(step).some((key) => !allowedStepKeys[index]?.includes(key))) {
      errors.push(`workflow step ${index} contains unapproved keys`);
    }
  }
  const runSteps: string[] = [];
  const seenActions = new Map<string, string>();
  const actionOrder: string[] = [];
  for (const rawStep of steps) {
    if (typeof rawStep !== "object" || rawStep === null || Array.isArray(rawStep)) continue;
    const step = rawStep as Record<string, unknown>;
    if (typeof step.run === "string") {
      const command = step.run.trim();
      runSteps.push(command);
      const expectedHash =
        typeof step.name === "string" ? policy.inline_step_hashes[step.name] : undefined;
      if (expectedHash && sha256Text(command) !== expectedHash) {
        errors.push(`inline step implementation mismatch: ${step.name}`);
      }
    }
    if (typeof step.uses === "string") {
      const match = /^([^@]+)@([0-9a-f]{40})$/.exec(step.uses);
      if (!match?.[1] || !match[2]) {
        errors.push(`action is not pinned to a full SHA: ${step.uses}`);
      } else {
        seenActions.set(match[1], match[2]);
        actionOrder.push(match[1]);
      }
    }
    if ("continue-on-error" in step) errors.push("required steps cannot continue on error");
    const isUpload =
      typeof step.uses === "string" && step.uses.startsWith("actions/upload-artifact@");
    const isFinalizer = step.name === "Finalize structured harness evidence";
    if ("if" in step && (!(isUpload || isFinalizer) || step.if !== "always()")) {
      errors.push("only evidence finalization/upload may have the exact always() condition");
    }
  }
  const initializer = steps[0] as Record<string, unknown> | undefined;
  const facadeStep = steps[5] as Record<string, unknown> | undefined;
  const finalizer = steps[6] as Record<string, unknown> | undefined;
  const facadeEnvironment = facadeStep?.env as Record<string, unknown> | undefined;
  if (
    !facadeEnvironment ||
    Object.keys(facadeEnvironment).join("\0") !== "VEAN_CI_EVIDENCE_PATH" ||
    facadeEnvironment.VEAN_CI_EVIDENCE_PATH !== policy.artifact.path
  ) {
    errors.push("facade stable runner-temp evidence path is missing");
  }
  if (
    typeof initializer?.run !== "string" ||
    !initializer.run.includes("CI_BOOTSTRAP_NOT_REACHED")
  ) {
    errors.push("failure evidence must be initialized before setup work");
  }
  const expectedInitializerEnvironment = {
    VEAN_CI_EVIDENCE_PATH: policy.artifact.path,
    VEAN_CI_ARTIFACT_NAME: policy.artifact.name_template,
    VEAN_CI_SOURCE_SHA: "${{ github.sha }}",
    VEAN_CI_RUN_ID: "${{ github.run_id }}",
    VEAN_CI_RUN_ATTEMPT: "${{ github.run_attempt }}",
    VEAN_CI_JOB: "${{ github.job }}",
    VEAN_CI_WORKFLOW: "${{ github.workflow }}",
    VEAN_CI_WORKFLOW_REF: "${{ github.workflow_ref }}",
    VEAN_CI_WORKFLOW_SHA: "${{ github.workflow_sha }}",
    VEAN_CI_EVENT_NAME: "${{ github.event_name }}",
    VEAN_CI_REPOSITORY: "${{ github.repository }}",
    VEAN_CI_RUNNER_NAME: "${{ runner.name }}",
    VEAN_CI_RUNNER_OS: "${{ runner.os }}",
    VEAN_CI_RUNNER_ARCH: "${{ runner.arch }}",
    VEAN_CI_RUNNER_ENVIRONMENT: "${{ runner.environment }}",
  };
  if (JSON.stringify(initializer?.env ?? {}) !== JSON.stringify(expectedInitializerEnvironment)) {
    errors.push("failure evidence identity environment is incomplete");
  }
  if (finalizer?.if !== "always()") errors.push("evidence finalization must run always");
  if (
    JSON.stringify(finalizer?.env ?? {}) !==
    JSON.stringify({
      VEAN_CI_EVIDENCE_PATH: policy.artifact.path,
      VEAN_CI_JOB_STATUS: "${{ job.status }}",
    })
  ) {
    errors.push("evidence finalization outcome environment is incomplete");
  }
  const allowedRunSteps = runSteps.filter(
    (command) =>
      Object.values(policy.inline_step_hashes).includes(sha256Text(command)) ||
      command ===
        "sudo apt-get update && sudo apt-get install --yes build-essential ffmpeg file libayatana-appindicator3-dev librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev libxml2-utils melt" ||
      command === "bun install --frozen-lockfile\nbun install --cwd app --frozen-lockfile" ||
      command === "bun run verify:ci-bootstrap",
  );
  if (allowedRunSteps.length !== runSteps.length)
    errors.push("workflow contains unapproved run logic");
  const uploadStep = steps.find(
    (step) =>
      typeof step === "object" &&
      step !== null &&
      !Array.isArray(step) &&
      typeof (step as Record<string, unknown>).uses === "string" &&
      ((step as Record<string, unknown>).uses as string).startsWith("actions/upload-artifact@"),
  ) as Record<string, unknown> | undefined;
  if (uploadStep?.if !== "always()") errors.push("evidence upload must run always");
  const uploadWith = uploadStep?.with as Record<string, unknown> | undefined;
  if (uploadWith?.path !== policy.artifact.path || uploadWith?.["if-no-files-found"] !== "error") {
    errors.push("evidence upload path/policy does not match runner-temp envelope");
  }
  if (
    uploadWith?.name !== policy.artifact.name_template ||
    uploadWith?.["retention-days"] !== policy.artifact.retention_days ||
    Object.keys(uploadWith ?? {})
      .sort()
      .join("\0") !== ["if-no-files-found", "name", "path", "retention-days"].sort().join("\0")
  ) {
    errors.push("evidence upload metadata is invalid");
  }
  const setupStep = steps.find(
    (step) =>
      typeof step === "object" &&
      step !== null &&
      !Array.isArray(step) &&
      typeof (step as Record<string, unknown>).uses === "string" &&
      ((step as Record<string, unknown>).uses as string).startsWith("oven-sh/setup-bun@"),
  ) as Record<string, unknown> | undefined;
  const setupWith = setupStep?.with as Record<string, unknown> | undefined;
  if (
    setupWith?.["bun-version"] !== "1.3.14" ||
    Object.keys(setupWith ?? {}).join("\0") !== "bun-version"
  ) {
    errors.push("Bun version must be pinned to 1.3.14");
  }
  for (const [action, pin] of Object.entries(policy.action_pins)) {
    if (seenActions.get(action) !== pin) errors.push(`action pin mismatch: ${action}`);
  }
  const expectedActionOrder = Object.keys(policy.action_pins);
  if (actionOrder.join("\0") !== expectedActionOrder.join("\0")) {
    errors.push("workflow action set/order does not match policy");
  }
  if (runSteps.filter((command) => command === "bun run verify:ci-bootstrap").length !== 1) {
    errors.push("workflow must call the bootstrap facade exactly once");
  }
  const duplicateCommands = runSteps.filter((command) =>
    /^bun run (lint|typecheck|test)(?:\s|$)/.test(command),
  );
  if (duplicateCommands.length > 0) errors.push("workflow duplicates policy command logic");
  if (packageJson.scripts?.["verify:ci-bootstrap"] !== policy.facade_script) {
    errors.push("bootstrap facade script does not match policy");
  }
  if (!policy.covers.includes("meta-evaluator-contract")) {
    errors.push("meta evaluator is not mapped");
  }
  for (const command of policy.commands) {
    const match = /^bun run ([\w:-]+)(?:\s|$)/.exec(command);
    if (!match?.[1] || !packageJson.scripts?.[match[1]]) {
      errors.push(`unknown package command: ${command}`);
    }
  }
  return errors;
}

function main(): void {
  const evidencePath = resolve(
    root,
    process.env.VEAN_CI_EVIDENCE_PATH ?? ".vean/ci/bootstrap.json",
  );
  const startedAt = new Date().toISOString();
  const results: Array<{ command: string; exit_code: number | null; duration_ms: number }> = [];
  const policyErrors: string[] = [];
  let initializedEvidence: Record<string, unknown> = {};
  let exitCode = 1;
  let policy: Policy | null = null;
  let workflowPath: string | null = null;

  try {
    if (existsSync(evidencePath)) {
      const parsed = JSON.parse(readFileSync(evidencePath, "utf8")) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("initialized CI evidence must be an object");
      }
      initializedEvidence = parsed as Record<string, unknown>;
    }
    policy = JSON.parse(readFileSync(policyPath, "utf8")) as Policy;
    workflowPath = resolve(root, policy.workflow_path);
    const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    policyErrors.push(
      ...validateBootstrapPolicy(policy, readFileSync(workflowPath, "utf8"), packageJson),
    );
    if (policyErrors.length === 0) {
      exitCode = 0;
      for (const command of policy.commands) {
        const started = performance.now();
        const result = spawnSync("sh", ["-lc", command], { cwd: root, stdio: "inherit" });
        results.push({
          command,
          exit_code: result.status,
          duration_ms: Math.round(performance.now() - started),
        });
        if (result.status !== 0) {
          exitCode = 1;
          break;
        }
      }
    }
  } catch (error) {
    policyErrors.push(`bootstrap exception: ${String(error)}`);
    exitCode = 1;
  } finally {
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(
      evidencePath,
      `${JSON.stringify(
        {
          ...initializedEvidence,
          contract_version: policy?.contract_version ?? "1.0.0",
          profile: policy?.profile ?? "bootstrap",
          status: exitCode === 0 ? "verified" : "failed",
          reason_code: exitCode === 0 ? "VERIFIED" : "CI_BOOTSTRAP_FAILED",
          evidence_subject_sha:
            process.env.GITHUB_SHA ?? initializedEvidence.evidence_subject_sha ?? null,
          evidence_subject_basis:
            process.env.GITHUB_SHA !== undefined
              ? "github.sha"
              : (initializedEvidence.evidence_subject_basis ?? null),
          workflow_hash: workflowPath && existsSync(workflowPath) ? sha256(workflowPath) : null,
          policy_hash: existsSync(policyPath) ? sha256(policyPath) : null,
          started_at: startedAt,
          ended_at: new Date().toISOString(),
          policy_errors: policyErrors,
          results,
        },
        null,
        2,
      )}\n`,
    );
  }
  process.exitCode = exitCode;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.dirname, "run-harness-profile.ts")
) {
  main();
}
