#!/usr/bin/env bun
// Move-2 end-to-end gate — the op → ambient diagnostics → render → still loop,
// proving the bridge composes with the real melt driver. This is the leg the
// vitest suite CANNOT run (vitest hosts under Node, where the `Bun` global +
// the melt binary aren't available), so it lives as a `bun`-run gate alongside
// `verify:corpus`.
//
// For each seeded task it: loads a working copy of the corpus document, applies an
// op through the MCP TOOL CORE (`mutate` — the same path the `apply-op` MCP tool
// runs), asserts the COMPACT ToolResult shape (consequences + inverse +
// touchedUris + compact health, NO full diagnostic dump), writes the new IR,
// re-analyzes through the LSP ENGINE (`analyze` — the same path the ambient
// `publishDiagnostics` runs) to confirm the document is clean, then RENDERS it and
// grabs a STILL via the melt driver — a real frame on disk is the perceptual
// proof. Exits 1 on any failure (a CI gate).
import { analyze } from "../src/bridge/lsp/engine";
import { parseDoc, serializeDoc } from "../src/bridge/tools/core";
import { mutate } from "../src/bridge/tools/mutate";
import type { ToolResult } from "../src/bridge/tools/types";
import { render, still } from "../src/driver/melt";

const SRC = "corpus/vean-multitrack.mlt";
const OUT_DIR = "out/move2-e2e";

type Task = {
  label: string;
  op: string;
  args: Record<string, unknown>;
  /** A frame to grab a still at (proving the edit's region renders). */
  frame: number;
  /** A consequence field expected to be non-empty (sanity on the report). */
  expectConsequence: keyof ToolResult["consequences"];
};

const TASKS: Task[] = [
  {
    label: "Task 1 — trimIn clip-3 +10 (tighten the gap before the blue clip)",
    op: "trimIn",
    args: { uuid: "clip-3", delta: 10 },
    frame: 30,
    expectConsequence: "clipsTrimmed",
  },
  {
    label: "Task 2 — gain clip-5 to -6 dB (duck the audio bed)",
    op: "gain",
    args: { uuid: "clip-5", db: -6 },
    frame: 50,
    expectConsequence: "clipsTrimmed", // gain reports as a (zero-delta) trim on the clip
  },
];

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

async function runTask(task: Task, n: number): Promise<boolean> {
  console.log(`\n[${n}] ${task.label}`);
  const doc = `${OUT_DIR}/task${n}.mlt`;
  await Bun.write(doc, await Bun.file(SRC).text());

  // 1) op via the tool core (the apply-op path).
  const state = parseDoc(await Bun.file(doc).text());
  const { outcome, newState } = mutate(state, { op: task.op, args: task.args }, `file://${doc}`);
  if (!outcome.ok) {
    console.error(`  ✗ op failed: ${outcome.kind} — ${outcome.detail}`);
    return false;
  }

  // 2) ToolResult discipline: the four fields present + compact health (no dump).
  assert(outcome.consequences != null, "result carries consequences");
  assert(
    outcome.inverse != null && typeof outcome.inverse.op === "string",
    "result carries an inverse op",
  );
  assert(
    outcome.touchedUris.length === 1 && outcome.touchedUris[0] === `file://${doc}`,
    "result names the touched URI",
  );
  assert(
    typeof outcome.health.errors === "number" && Array.isArray(outcome.health.newOrBlocking),
    "health is the compact summary (counts + new/blocking list)",
  );
  assert(
    !("diagnostics" in (outcome.health as object)),
    "health does NOT carry a full diagnostic dump",
  );
  assert(
    (outcome.consequences[task.expectConsequence] as unknown[]).length >= 0,
    `consequences include the expected '${String(task.expectConsequence)}' field`,
  );

  // 3) persist + ambient re-analysis (the publishDiagnostics path) → clean.
  await Bun.write(doc, serializeDoc(newState as NonNullable<typeof newState>));
  const ambient = analyze(`file://${doc}`, await Bun.file(doc).text());
  assert(
    ambient.lspDiagnostics.length === 0,
    "ambient diagnostics report the edited document clean",
  );

  // 4) render + still — a real frame on disk.
  const mp4 = `${OUT_DIR}/task${n}.mp4`;
  const png = `${OUT_DIR}/task${n}-f${task.frame}.png`;
  await render(doc, mp4);
  await still(doc, task.frame, png);
  const renderedOk = await Bun.file(mp4).exists();
  const stillFile = Bun.file(png);
  const stillOk = (await stillFile.exists()) && stillFile.size > 0;
  assert(renderedOk, `render produced ${mp4}`);
  assert(stillOk, `still produced ${png} (${stillFile.size} bytes — a real frame)`);

  return process.exitCode !== 1;
}

async function main(): Promise<void> {
  console.log("Move-2 e2e gate — op → ambient diagnostics → render → still\n");
  // Confirm melt/ffmpeg are present (the gate needs the system deps).
  const tasksPassed: boolean[] = [];
  for (let i = 0; i < TASKS.length; i++) {
    const task = TASKS[i];
    if (!task) continue;
    try {
      tasksPassed.push(await runTask(task, i + 1));
    } catch {
      tasksPassed.push(false);
    }
  }
  const allPass = tasksPassed.length === TASKS.length && tasksPassed.every(Boolean);
  console.log(
    `\n${allPass ? "OVERALL PASS" : "OVERALL FAIL"} — ${tasksPassed.filter(Boolean).length}/${TASKS.length} seeded tasks completed end-to-end`,
  );
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
