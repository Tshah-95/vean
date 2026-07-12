import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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

describe("CI bootstrap policy mapping", () => {
  it("maps the required push-main bootstrap to existing canonical commands", () => {
    expect(validateBootstrapPolicy(policy, workflow, packageJson)).toEqual([]);
    expect(policy.commands).toEqual(["bun run lint", "bun run typecheck", "bun run test"]);
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
    ).toContain("only evidence upload may have the exact always() condition");
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
    ).toContain("workflow step 4 contains unapproved keys");
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
      "workflow step order mismatch at 4",
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
});
