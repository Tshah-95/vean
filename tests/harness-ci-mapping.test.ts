import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateBootstrapPolicy } from "../scripts/ci/run-harness-profile";

type Policy = Parameters<typeof validateBootstrapPolicy>[0];

const root = resolve(import.meta.dirname, "..");
const workflow = readFileSync(resolve(root, ".github/workflows/harness.yml"), "utf8");
const policy = JSON.parse(
  readFileSync(resolve(root, "scripts/ci/harness-policy.json"), "utf8"),
) as Policy;
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const parsedWorkflow = parse(workflow) as {
  jobs: { bootstrap: { steps: Array<Record<string, unknown>> } };
};

function step(name: string): Record<string, unknown> {
  const found = parsedWorkflow.jobs.bootstrap.steps.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing workflow step ${name}`);
  return found;
}

describe("CI bootstrap policy mapping", () => {
  it("maps the required push-main bootstrap to existing canonical commands", () => {
    expect(validateBootstrapPolicy(policy, workflow, packageJson)).toEqual([]);
    expect(policy.commands).toEqual(["bun run lint", "bun run typecheck", "bun run test"]);
    expect(workflow).toContain("bun install --cwd app --frozen-lockfile");
    expect(workflow).toContain(
      "sudo apt-get install --yes build-essential ffmpeg file libayatana-appindicator3-dev librsvg2-dev libssl-dev libwebkit2gtk-4.1-dev libxdo-dev libxml2-utils melt",
    );
    expect(policy.artifact.name_template).toBe(
      "harness-bootstrap-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
    );
  });

  it("rejects trigger removal, permissive failure, duplicate logic, and stale commands", () => {
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace("  push:\n", "  pull_request:\n"),
        packageJson,
      ),
    ).toContain("workflow must run on push to main");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "    name: Harness bootstrap\n",
          "    name: Harness bootstrap\n    continue-on-error: true\n",
        ),
        packageJson,
      ),
    ).toContain("required jobs cannot continue on error");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace("bun run verify:ci-bootstrap", "bun run test"),
        packageJson,
      ),
    ).toContain("workflow must call the bootstrap facade exactly once");
    expect(
      validateBootstrapPolicy(
        { ...policy, commands: ["bun run removed-command"] },
        workflow,
        packageJson,
      ),
    ).toContain("unknown package command: bun run removed-command");
  });

  it("rejects semantic YAML decoys, skipped jobs, floating actions, duplicate commands, and a no-op facade", () => {
    const decoy = workflow.replace(
      /on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/,
      "on:\n  pull_request:\ndecoy:\n  push:\n    branches: [main]\n  workflow_dispatch:\n",
    );
    expect(validateBootstrapPolicy(policy, decoy, packageJson)).toContain(
      "workflow must run on push to main",
    );
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "    name: Harness bootstrap\n",
          "    name: Harness bootstrap\n    if: ${{ false }}\n",
        ),
        packageJson,
      ),
    ).toContain("required bootstrap job cannot have a condition");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
          "actions/checkout@main",
        ),
        packageJson,
      ),
    ).toContain("action is not pinned to a full SHA: actions/checkout@main");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "      - name: Run policy-defined bootstrap\n",
          "      - name: Duplicate lint\n        run: bun run lint\n      - name: Run policy-defined bootstrap\n",
        ),
        packageJson,
      ),
    ).toContain("workflow duplicates policy command logic");
    expect(
      validateBootstrapPolicy(policy, workflow, {
        scripts: { ...packageJson.scripts, "verify:ci-bootstrap": "true" },
      }),
    ).toContain("bootstrap facade script does not match policy");
  });

  it("rejects skipped gate steps, trigger path suppression, and unapproved pinned actions", () => {
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "      - name: Run policy-defined bootstrap\n",
          "      - name: Run policy-defined bootstrap\n        if: ${{ false }}\n",
        ),
        packageJson,
      ),
    ).toContain("only evidence finalization/upload may have the exact always() condition");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "    branches: [main]\n",
          '    branches: [main]\n    paths-ignore: ["**"]\n',
        ),
        packageJson,
      ),
    ).toContain("push trigger may only select the main branch");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "      - name: Set up Bun\n",
          "      - name: Unapproved action\n        uses: attacker/action@0000000000000000000000000000000000000000\n      - name: Set up Bun\n",
        ),
        packageJson,
      ),
    ).toContain("workflow action set/order does not match policy");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace("  workflow_dispatch:\n", "  workflow_dispatch: false\n"),
        packageJson,
      ),
    ).toContain("workflow_dispatch must be enabled without filters");
  });

  it("rejects expression-based error swallowing, custom shells, and upload reordering", () => {
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "        run: bun run verify:ci-bootstrap\n",
          "        continue-on-error: ${{ true }}\n        run: bun run verify:ci-bootstrap\n",
        ),
        packageJson,
      ),
    ).toContain("required steps cannot continue on error");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "        run: bun run verify:ci-bootstrap\n",
          "        run: bun run verify:ci-bootstrap\n        shell: bash {0} || true\n",
        ),
        packageJson,
      ),
    ).toContain("workflow step 5 contains unapproved keys");
    const uploadBlock = workflow.slice(
      workflow.indexOf("      - name: Upload structured harness evidence"),
    );
    const withoutUpload = workflow.slice(
      0,
      workflow.indexOf("      - name: Upload structured harness evidence"),
    );
    const reordered = withoutUpload.replace(
      "      - name: Run policy-defined bootstrap\n",
      `${uploadBlock}      - name: Run policy-defined bootstrap\n`,
    );
    expect(validateBootstrapPolicy(policy, reordered, packageJson)).toContain(
      "workflow step order mismatch at 5",
    );
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "    timeout-minutes: 20\n",
          "    timeout-minutes: 20\n    env:\n      VEAN_CI_EVIDENCE_PATH: ${{ runner.temp }}/harness-bootstrap.json\n",
        ),
        packageJson,
      ),
    ).toContain("bootstrap job contains unapproved keys");
  });

  it("rejects weakened pre-checkout identity, finalization, and artifact lineage", () => {
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace("          VEAN_CI_SOURCE_SHA: ${{ github.sha }}\n", ""),
        packageJson,
      ),
    ).toContain("failure evidence identity environment is incomplete");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace('"evidence_subject_basis": "github.sha"', '"basis": "github.sha"'),
        packageJson,
      ),
    ).toContain("inline step implementation mismatch: Initialize failure evidence");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "      - name: Finalize structured harness evidence\n        if: always()\n",
          "      - name: Finalize structured harness evidence\n        if: success()\n",
        ),
        packageJson,
      ),
    ).toContain("evidence finalization must run always");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace("          VEAN_CI_JOB_STATUS: ${{ job.status }}\n", ""),
        packageJson,
      ),
    ).toContain("evidence finalization outcome environment is incomplete");
    expect(
      validateBootstrapPolicy(
        policy,
        workflow.replace(
          "harness-bootstrap-${{ github.sha }}-${{ github.run_id }}-${{ github.run_attempt }}\n          path:",
          "harness-bootstrap-${{ github.sha }}\n          path:",
        ),
        packageJson,
      ),
    ).toContain("evidence upload metadata is invalid");
  });

  it("writes pre-checkout runner identity and finalizes cancelled/failed outcomes without converting them to success", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "vean-ci-evidence-"));
    const evidencePath = resolve(directory, "bootstrap.json");
    try {
      const initializer = step("Initialize failure evidence");
      const initResult = spawnSync("bash", ["-eo", "pipefail", "-c", String(initializer.run)], {
        encoding: "utf8",
        env: {
          ...process.env,
          VEAN_CI_EVIDENCE_PATH: evidencePath,
          VEAN_CI_ARTIFACT_NAME: "harness-bootstrap-deadbeef-123-2",
          VEAN_CI_SOURCE_SHA: "deadbeef",
          VEAN_CI_RUN_ID: "123",
          VEAN_CI_RUN_ATTEMPT: "2",
          VEAN_CI_JOB: "bootstrap",
          VEAN_CI_WORKFLOW: "Harness",
          VEAN_CI_WORKFLOW_REF: "owner/repo/.github/workflows/harness.yml@refs/heads/main",
          VEAN_CI_WORKFLOW_SHA: "cafebabe",
          VEAN_CI_EVENT_NAME: "push",
          VEAN_CI_REPOSITORY: "owner/repo",
          VEAN_CI_RUNNER_NAME: "GitHub Actions 1",
          VEAN_CI_RUNNER_OS: "Linux",
          VEAN_CI_RUNNER_ARCH: "X64",
          VEAN_CI_RUNNER_ENVIRONMENT: "github-hosted",
          ImageOS: "ubuntu24",
          ImageVersion: "20260701.1",
          RUNNER_TOOL_CACHE: "/opt/hostedtoolcache",
          RUNNER_TEMP: directory,
        },
      });
      expect(initResult.status, initResult.stderr).toBe(0);
      const initialized = JSON.parse(readFileSync(evidencePath, "utf8"));
      expect(initialized).toMatchObject({
        status: "failed",
        reason_code: "CI_BOOTSTRAP_NOT_REACHED",
        evidence_subject_sha: "deadbeef",
        evidence_subject_basis: "github.sha",
        github: {
          run_id: "123",
          run_attempt: "2",
          job: "bootstrap",
          workflow_sha: "cafebabe",
        },
        runner: {
          os: "Linux",
          arch: "X64",
          environment: "github-hosted",
          image_os: "ubuntu24",
          image_version: "20260701.1",
        },
        expected_artifact: {
          name: "harness-bootstrap-deadbeef-123-2",
          path: evidencePath,
          retention_days: 7,
        },
      });

      const finalizer = step("Finalize structured harness evidence");
      const failed = spawnSync("bash", ["-eo", "pipefail", "-c", String(finalizer.run)], {
        encoding: "utf8",
        env: {
          ...process.env,
          VEAN_CI_EVIDENCE_PATH: evidencePath,
          VEAN_CI_JOB_STATUS: "failure",
        },
      });
      expect(failed.status, failed.stderr).toBe(0);
      expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
        status: "failed",
        reason_code: "CI_JOB_FAILED_BEFORE_BOOTSTRAP",
        ci_job_status: "failure",
      });

      writeFileSync(evidencePath, `${JSON.stringify(initialized)}\n`);
      const cancelled = spawnSync("bash", ["-eo", "pipefail", "-c", String(finalizer.run)], {
        encoding: "utf8",
        env: {
          ...process.env,
          VEAN_CI_EVIDENCE_PATH: evidencePath,
          VEAN_CI_JOB_STATUS: "cancelled",
        },
      });
      expect(cancelled.status, cancelled.stderr).toBe(0);
      expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
        status: "failed",
        reason_code: "CI_JOB_CANCELLED",
        ci_job_status: "cancelled",
      });

      const verified = JSON.parse(readFileSync(evidencePath, "utf8"));
      verified.status = "verified";
      verified.reason_code = "VERIFIED";
      writeFileSync(evidencePath, `${JSON.stringify(verified)}\n`);
      const successful = spawnSync("bash", ["-eo", "pipefail", "-c", String(finalizer.run)], {
        encoding: "utf8",
        env: {
          ...process.env,
          VEAN_CI_EVIDENCE_PATH: evidencePath,
          VEAN_CI_JOB_STATUS: "success",
        },
      });
      expect(successful.status, successful.stderr).toBe(0);
      expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
        status: "verified",
        reason_code: "VERIFIED",
        ci_job_status: "success",
      });

      verified.status = "failed";
      verified.reason_code = "CI_BOOTSTRAP_NOT_REACHED";
      writeFileSync(evidencePath, `${JSON.stringify(verified)}\n`);
      const missingResult = spawnSync("bash", ["-eo", "pipefail", "-c", String(finalizer.run)], {
        encoding: "utf8",
        env: {
          ...process.env,
          VEAN_CI_EVIDENCE_PATH: evidencePath,
          VEAN_CI_JOB_STATUS: "success",
        },
      });
      expect(missingResult.status).toBe(1);
      expect(JSON.parse(readFileSync(evidencePath, "utf8"))).toMatchObject({
        status: "failed",
        reason_code: "CI_BOOTSTRAP_RESULT_MISSING",
        ci_job_status: "success",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
