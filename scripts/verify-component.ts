#!/usr/bin/env bun
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fromMlt } from "../src/ir/parse";
import type { Item, Timeline } from "../src/ir/types";
import { SessionStore, applyOp, markSaved, serializeSession } from "../src/preview/session";
import {
  type ComponentControlId,
  isComponentControlId,
  prepareComponentControl,
} from "./harness/component-control";
import { hashPath, writeControlFailure, writeVerifiedEvidence } from "./harness/evidence";
import { createFixture, hashFile } from "./harness/fixture";

const repo = resolve(import.meta.dirname, "..");
const playwrightBrowsers =
  process.env.PLAYWRIGHT_BROWSERS_PATH ??
  (process.platform === "darwin"
    ? join(homedir(), "Library/Caches/ms-playwright")
    : join(homedir(), ".cache/ms-playwright"));
const suiteIndex = process.argv.indexOf("--suite");
const suite = suiteIndex >= 0 ? process.argv[suiteIndex + 1] : "components";
if (suite !== "components" && suite !== "accessibility") {
  throw new Error("--suite must be accessibility when supplied");
}
const claimId = suite === "accessibility" ? "claim-dom-accessibility" : "claim-react-components";
const controlId: ComponentControlId =
  suite === "accessibility" ? "nc-dom-accessibility" : "nc-react-components";
const reasonCode =
  suite === "accessibility" ? "SENSITIVITY_DOM_ACCESSIBILITY" : "SENSITIVITY_REACT_COMPONENTS";
const oracleCommand =
  suite === "accessibility"
    ? "bun run verify:component --suite accessibility"
    : "bun run verify:component";
const expectedPredicate =
  suite === "accessibility"
    ? "approved ledger has zero blocking semantic/axe/keyboard/focus failures; no manual VoiceOver claim is inferred"
    : "executed component scenario IDs exactly equal approved ledger and timeline-dependent cases reference approved interaction-contract hash";
const scenarioPath = join(repo, "artifacts/specs/harness-scenarios/component.json");
const contractPath = join(repo, "artifacts/specs/timeline-keyboard-accessibility-contract-v1.md");
const approvedContractHash = "90e92872cc4df0dc12705ee560d2e2e5e3a916210c2a2eebb73e2cbd15c9a6d1";
if (hashPath(contractPath) !== approvedContractHash) {
  throw new Error("approved timeline interaction contract hash drifted");
}
const scenarioLedger = JSON.parse(readFileSync(scenarioPath, "utf8")) as {
  interaction_contract?: { path?: string; sha256?: string; version?: string };
  scenarios?: Array<{ id?: string }>;
};
if (
  scenarioLedger.interaction_contract?.path !==
    "artifacts/specs/timeline-keyboard-accessibility-contract-v1.md" ||
  scenarioLedger.interaction_contract.sha256 !== approvedContractHash ||
  scenarioLedger.interaction_contract.version !== "timeline-a11y-v1"
) {
  throw new Error("component scenario ledger is not bound to the approved interaction contract");
}
const executedScenarioIds = (scenarioLedger.scenarios ?? []).map((scenario) => scenario.id);
if (
  executedScenarioIds.some((id) => !id) ||
  new Set(executedScenarioIds).size !== executedScenarioIds.length ||
  executedScenarioIds.length !== 23
) {
  throw new Error("component scenario IDs must be 23 unique non-empty IDs");
}

const negativePhase = process.env.VEAN_HARNESS_PHASE === "negative-control";
const requestedControl = process.env.VEAN_HARNESS_CONTROL_ID;
if (negativePhase && requestedControl && !isComponentControlId(requestedControl)) {
  throw new Error(`unexpected component negative control ${requestedControl}`);
}
if (negativePhase && requestedControl !== controlId) {
  throw new Error(`suite ${suite} requires ${controlId}, received ${requestedControl ?? "none"}`);
}
const control = prepareComponentControl(controlId, !negativePhase);
if (negativePhase && hashFile(control.target) !== control.mutated_hash) {
  throw new Error(`${controlId} was not applied to real viewer product source`);
}

const sourceSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
  .stdout.toString()
  .trim();
const canary = join(repo, ".vean/harness/developer-state-canary");
mkdirSync(dirname(canary), { recursive: true });
if (!Bun.file(canary).size) writeFileSync(canary, "poisoned-developer-state\n", { mode: 0o600 });
const fixture = await createFixture({ sourceSha, developerCanary: canary });
const evidenceBase = process.env.VEAN_HARNESS_EVIDENCE_PATH
  ? dirname(process.env.VEAN_HARNESS_EVIDENCE_PATH)
  : join(repo, ".vean/harness/component-runs");
const runId = (process.env.VEAN_HARNESS_CLAIM_RUN_ID ?? fixture.descriptor.runId).replace(
  /[^A-Za-z0-9_.-]/g,
  "_",
);
const artifactDir = join(evidenceBase, `${claimId}-artifacts`, runId);
mkdirSync(artifactDir, { recursive: true });
const browserLogPath = join(artifactDir, "browser.log");
let cleanup: Awaited<ReturnType<typeof fixture.close>> | null = null;

try {
  const browser = Bun.spawnSync(
    ["bun", "run", "--cwd", "viewer", "test:browser", "--", "--reporter=verbose"],
    {
      cwd: repo,
      env: {
        ...process.env,
        HOME: fixture.descriptor.home,
        PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsers,
        VEAN_COMPONENT_PORT: String(fixture.descriptor.vitePort),
        CI: "1",
        FORCE_COLOR: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const browserLog = `${browser.stdout.toString()}${browser.stderr.toString()}`;
  writeFileSync(browserLogPath, browserLog);
  if (negativePhase) {
    if (browser.exitCode === 0) {
      throw new Error(`${controlId} did not fail the real-browser oracle`);
    }
    writeControlFailure(reasonCode, controlId);
  }
  if (browser.exitCode !== 0) {
    console.error(browserLog);
    throw new Error(`real-browser component suite failed with exit ${browser.exitCode}`);
  }
  const browserScenarioIds = executedScenarioIds as string[];
  const missingBrowserScenarios = browserScenarioIds.filter((id) => !browserLog.includes(id));
  if (missingBrowserScenarios.length > 0) {
    throw new Error(`browser reporter omitted scenario IDs: ${missingBrowserScenarios.join(", ")}`);
  }

  const invocationSource = join(repo, "viewer/test-results/component-browser/invocation.json");
  const recorded = JSON.parse(readFileSync(invocationSource, "utf8")) as {
    scenarioId?: string;
    actionId?: string;
    route?: string;
    invocation?: { op?: string; args?: Record<string, unknown> };
  };
  if (
    recorded.scenarioId !== "a11y.timeline.document-truth" ||
    recorded.actionId !== "move" ||
    recorded.invocation?.op !== "move" ||
    recorded.route !== "timeline:fixture"
  ) {
    throw new Error(
      "browser invocation recorder did not capture the required real keyboard action",
    );
  }
  const invocationPath = join(artifactDir, "browser-invocation.json");
  copyFileSync(invocationSource, invocationPath);

  const sourceTimeline = join(repo, "corpus/shotcut-single.mlt");
  const savedTimeline = join(fixture.descriptor.projectRoot, "component-keyboard.mlt");
  copyFileSync(sourceTimeline, savedTimeline);
  const beforeHash = hashFile(savedTimeline);
  const store = new SessionStore();
  const session = store.get(savedTimeline, (path) => readFileSync(path, "utf8"));
  const applied = applyOp(
    session,
    recorded.invocation as { op: string; args: Record<string, unknown> },
  );
  if (!applied.ok)
    throw new Error(`recorded keyboard invocation failed: ${applied.kind}: ${applied.detail}`);
  const xml = serializeSession(session);
  writeFileSync(savedTimeline, xml);
  markSaved(session);
  const afterHash = hashFile(savedTimeline);
  const reparsed = fromMlt(readFileSync(savedTimeline, "utf8"));
  const placement = locate(reparsed, String(recorded.invocation?.args?.uuid));
  const moved = applied.consequences.clipsMoved[0];
  if (
    beforeHash === afterHash ||
    placement?.track !== "playlist0" ||
    placement.position !== 1 ||
    moved?.uuid !== recorded.invocation?.args?.uuid ||
    moved?.to.position !== 1 ||
    applied.diagnostics.length !== 0
  ) {
    throw new Error("independent SessionStore/.mlt truth did not match the browser invocation");
  }
  const truthPath = join(artifactDir, "independent-mlt-truth.json");
  writeFileSync(
    truthPath,
    `${JSON.stringify(
      {
        scenario_id: "a11y.timeline.document-truth",
        browser_invocation_hash: hashPath(invocationPath),
        action_id: recorded.actionId,
        browser_route: recorded.route,
        touched_timeline_uri: savedTimeline,
        before_mlt_hash: beforeHash,
        after_mlt_hash: afterHash,
        parsed_ir: placement,
        consequences: applied.consequences,
        diagnostics: applied.diagnostics,
        inverse: session.undoStack.at(-1)?.invocation ?? null,
      },
      null,
      2,
    )}\n`,
  );

  const screenshotSource = join(repo, "viewer/test-results/component-browser/accessibility.png");
  const screenshotPath = join(artifactDir, "accessibility.png");
  copyFileSync(screenshotSource, screenshotPath);
  const resultPath = join(artifactDir, "result.json");
  const result = {
    suite,
    browser: "playwright/chromium/headless",
    host: "127.0.0.1",
    strictPort: fixture.descriptor.vitePort,
    tests: 23,
    interactionContractHash: approvedContractHash,
    invocationHash: hashPath(invocationPath),
    independentMltTruthHash: hashPath(truthPath),
    screenshotHash: hashPath(screenshotPath),
    tracePolicy: "retain-on-failure",
    cleanupFindings: [] as unknown[],
  };
  cleanup = await fixture.close();
  result.cleanupFindings = cleanup.detected;
  if (cleanup.detected.length > 0)
    throw new Error("component fixture cleanup found residual state");
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  writeVerifiedEvidence({
    repo,
    claimId,
    oracleCommand,
    expectedPredicate,
    controlId,
    fixturePath: sourceTimeline,
    commandPath: join(repo, "scripts/verify-component.ts"),
    implementationPaths: [
      join(repo, "scripts/verify-component.ts"),
      join(repo, "scripts/harness/component-control.ts"),
      join(repo, "viewer/vitest.browser.config.ts"),
      join(repo, "viewer/test/setup-browser.ts"),
      join(repo, "viewer/test/timeline.browser.test.tsx"),
      join(repo, "viewer/src/components/TimelineStrip.tsx"),
      join(repo, "viewer/src/components/ClipBlock.tsx"),
      join(repo, "viewer/src/timelineKeyboard.ts"),
      join(repo, "viewer/src/useTimelineEditor.ts"),
    ],
    generatedPaths: [],
    artifactPaths: [browserLogPath, invocationPath, truthPath, screenshotPath, resultPath],
    result,
    controlPlan: {
      control_id: control.control_id,
      before_hash: control.before_hash,
      mutated_hash: control.mutated_hash,
      manifestPath: control.manifestPath,
      manifestHash: hashPath(control.manifestPath),
    },
    scenarioPath,
    executedScenarioIds: executedScenarioIds as string[],
  });
  console.log(JSON.stringify({ status: "verified", claimId, artifactDir, result }));
} finally {
  if (!cleanup) await fixture.close();
}

function itemLength(item: Item): number {
  if (item.kind === "clip") return item.out - item.in + 1;
  if (item.kind === "blank") return item.length;
  return item.frames;
}

function locate(timeline: Timeline, uuid: string) {
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    let position = 0;
    for (const item of track.items) {
      if (item.kind === "clip" && item.id === uuid) {
        return { uuid, track: track.id, position, sourceIn: item.in, sourceOut: item.out };
      }
      position += itemLength(item);
    }
  }
  return null;
}
