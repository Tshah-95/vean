#!/usr/bin/env bun
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { clip, timeline, videoTrack } from "../src/ir/builder";
import { fromMlt } from "../src/ir/parse";
import { VERTICAL } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import type { Item, Timeline } from "../src/ir/types";
import type { OpInvocation } from "../src/ops";
import {
  SessionStore,
  applyOp,
  markSaved,
  serializeSession,
  undoSession,
} from "../src/preview/session";
import {
  type ComponentControlId,
  componentOracleImplementationPaths,
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
const developerCanaryHash = hashFile(canary);
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

  const paritySource = join(repo, "viewer/test-results/component-browser/parity.json");
  const parity = JSON.parse(readFileSync(paritySource, "utf8")) as {
    scenarioId?: string;
    invocations?: OpInvocation[];
  };
  const expectedParityOps = ["move", "slip", "slide", "trimIn", "trimOut", "roll", "move"];
  if (
    parity.scenarioId !== "a11y.timeline.pointer-keyboard-parity" ||
    parity.invocations?.length !== expectedParityOps.length ||
    parity.invocations.some((invocation, index) => invocation.op !== expectedParityOps[index])
  ) {
    throw new Error("browser parity recorder did not capture every approved edit family");
  }
  const parityPath = join(artifactDir, "browser-pointer-keyboard-parity.json");
  copyFileSync(paritySource, parityPath);

  const sourceTimeline = join(repo, "corpus/shotcut-single.mlt");
  const sourceTimelineHash = hashFile(sourceTimeline);
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

  const parityTruthPath = join(artifactDir, "pointer-keyboard-parity-truth.json");
  const parityTruth = proveParityPersistence(
    artifactDir,
    parity.invocations,
    String(recorded.invocation?.args?.uuid),
  );
  writeFileSync(
    parityTruthPath,
    `${JSON.stringify(
      {
        scenario_id: parity.scenarioId,
        browser_parity_hash: hashPath(parityPath),
        edit_families: parityTruth,
      },
      null,
      2,
    )}\n`,
  );

  if (hashFile(canary) !== developerCanaryHash || hashFile(sourceTimeline) !== sourceTimelineHash) {
    throw new Error("component verification mutated developer state or the source corpus fixture");
  }

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
    parityInvocationHash: hashPath(parityPath),
    parityMltTruthHash: hashPath(parityTruthPath),
    parityFamilies: parityTruth.map((entry) => entry.family),
    sourceCorpusUnchanged: true,
    developerCanaryUnchanged: true,
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
    implementationPaths: componentOracleImplementationPaths.map((path) => join(repo, path)),
    generatedPaths: [truthPath, parityTruthPath, resultPath],
    artifactPaths: [
      browserLogPath,
      invocationPath,
      parityPath,
      truthPath,
      parityTruthPath,
      screenshotPath,
      resultPath,
    ],
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

function proveParityPersistence(
  artifactDir: string,
  invocations: OpInvocation[],
  targetUuid: string,
) {
  const mediaDir = join(artifactDir, "parity-media");
  mkdirSync(mediaDir, { recursive: true });
  const media = ["left.mov", "alpha.mov", "right.mov", "overlay.mov"].map((name) =>
    join(mediaDir, name),
  );
  for (const path of media) writeFileSync(path, "component parity fixture\n");

  const fixtureIr = timeline(VERTICAL, {
    video: [
      videoTrack(
        clip(media[0] as string, { id: "left", in: 10, out: 39, length: 100 }),
        clip(media[1] as string, { id: targetUuid, in: 10, out: 39, length: 100 }),
        clip(media[2] as string, { id: "clip-b", in: 10, out: 39, length: 100 }),
      ),
      // Ends before Alpha's frame-30 ripple seam. That makes ripple trim lossless
      // while still giving the cross-track move a real destination to overwrite.
      videoTrack(clip(media[3] as string, { id: "overlay", dur: 15, length: 100 })),
    ],
  });
  // Browser fixture track IDs are part of the keyboard invocation contract. The
  // serializer chooses positional playlist IDs, so rename the second playlist in
  // this isolated input document before parsing it into the session engine.
  const baselineXml = toMlt(fixtureIr).replaceAll("playlist1", "v2");

  return invocations.map((invocation, index) => {
    const family = `${index + 1}-${invocation.op}${index === 6 ? "-cross-track" : ""}`;
    const timelinePath = join(artifactDir, `parity-${family}.mlt`);
    writeFileSync(timelinePath, baselineXml);
    const beforeHash = hashFile(timelinePath);
    const store = new SessionStore();
    const session = store.get(timelinePath, (path) => readFileSync(path, "utf8"));
    const beforeIr = JSON.stringify(session.ir);
    const outcome = applyOp(session, invocation);
    if (!outcome.ok) {
      throw new Error(`parity ${family} failed: ${outcome.kind}: ${outcome.detail}`);
    }
    const inverse = session.undoStack.at(-1)?.invocation ?? null;
    writeFileSync(timelinePath, serializeSession(session));
    markSaved(session);
    const afterHash = hashFile(timelinePath);
    const reparsed = fromMlt(readFileSync(timelinePath, "utf8"));
    const placement = locate(reparsed, targetUuid);
    if (beforeHash === afterHash || !placement || !inverse) {
      throw new Error(`parity ${family} did not produce persisted, reparsable timeline truth`);
    }
    const undone = undoSession(session);
    if (!undone.ok || JSON.stringify(session.ir) !== beforeIr) {
      throw new Error(`parity ${family} inverse did not restore the exact starting IR`);
    }
    return {
      family,
      invocation,
      touched_timeline_uri: timelinePath,
      before_mlt_hash: beforeHash,
      after_mlt_hash: afterHash,
      parsed_ir: placement,
      consequences: outcome.consequences,
      diagnostics: outcome.diagnostics,
      inverse,
      inverse_restored_exact_ir: true,
    };
  });
}
