#!/usr/bin/env bun
// undo-op — the `undo` MCP tool as a CLI verb. Undo an edit by re-applying its
// INVERSE invocation (the `inverse` JSON a prior `apply-op`/`edit` printed) to a
// `.mlt` file, writing the undone document back. Mirrors the `undo` MCP tool:
// re-apply the inverse through the SAME transport-free mutating-tool core
// (`undoTool`, src/bridge/tools/mutate), persist, and print the ToolResult.
//
//   bun run undo-op <file.mlt> <inverse-json> [out.mlt]
//
// where <inverse-json> is the `{"op":"…","args":{…}}` invocation a prior edit
// emitted as its `inverse`. (Distinct from `bun run undo`, which is the round-trip
// DEMONSTRATION — apply an op THEN its own inverse and prove byte-identity. This is
// the operational verb: undo an already-applied edit recorded as an inverse.)
//
// Default output overwrites the input file IN PLACE (undo is a mutation of the
// document, like the MCP tool writing back the same URI); pass an explicit out path
// to write elsewhere. The written XML passes the SAME strict namespace-aware
// xmllint gate `edit` uses — we never write a file Shotcut would refuse. Output
// stays Shotcut-clean.
//
// IMPORTANT — the inverse references in-session clip uuids. An authored clip id now
// survives serialize→parse via `shotcut:uuid` (Move 1b), so an inverse that names
// authored ids round-trips against the written file. But an inverse that names a
// uuid a forward op MINTED at runtime (e.g. split's `_unsplit` left-half id) is
// random by design and a reload renames it — so `undo-op` resolves cleanly for ops
// whose inverse references stable ids, exactly as the MCP `undo` tool does on the
// shared file. (The same documented Move-1b persistence nuance the `edit`/`undo`
// scripts carry.)
//
// Exit 0 on success; 1 on a typed ToolError (the inverse's precondition / invalid
// args) or a non-Shotcut-clean emission; 2 on usage / malformed JSON.
import { writeFileSync } from "node:fs";
import { undoTool } from "../src/bridge/tools/mutate";
import { isToolError } from "../src/bridge/tools/types";
import { fromMlt } from "../src/ir/parse";
import { toMlt } from "../src/ir/serialize";
import type { OpInvocation } from "../src/ops";
import { formatConsequences, xmlIsClean } from "./edit";
import { formatAlerts } from "./preview-op";

const USAGE = "usage: bun run undo-op <file.mlt> <inverse-json> [out.mlt]";

async function main(): Promise<void> {
  const [, , file, inverseJson, outArg] = process.argv;
  if (!file || inverseJson === undefined) {
    console.error(USAGE);
    process.exit(2);
  }

  let inverse: OpInvocation;
  try {
    inverse = JSON.parse(inverseJson) as OpInvocation;
  } catch (err) {
    console.error(
      `undo-op: <inverse-json> is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
    console.error(USAGE);
    process.exit(2);
    return;
  }
  if (!inverse || typeof inverse.op !== "string") {
    console.error('undo-op: <inverse-json> must be an invocation: {"op":"…","args":{…}}');
    process.exit(2);
  }

  const xml = await Bun.file(file).text();
  const state = fromMlt(xml);
  const { outcome, newState } = undoTool(state, inverse, `file://${file}`);

  if (isToolError(outcome)) {
    console.error(`undo-op: inverse failed — ToolError[${outcome.kind}]: ${outcome.detail}`);
    process.exit(1);
  }
  if (!newState) {
    console.error("undo-op: inverse applied but produced no new state (unexpected)");
    process.exit(1);
  }

  // Shotcut-openability gate: never WRITE a file the strict namespace-aware parser
  // would refuse (the same gate `edit` enforces).
  const outXml = toMlt(newState);
  const lint = xmlIsClean(outXml);
  if (!lint.ok) {
    console.error(`undo-op: refusing to write — result is not Shotcut-clean XML: ${lint.detail}`);
    process.exit(1);
  }

  const outPath = outArg ?? file; // undo overwrites in place by default (a mutation).
  writeFileSync(outPath, outXml);

  console.log(`undo-op: ${inverse.op} → ${outPath}`);
  console.log(`xml:  ${lint.ok ? "clean (Shotcut-openable)" : lint.detail}`);
  console.log("consequences (what the undo did):");
  console.log(formatConsequences(outcome.consequences));
  if (outcome.alerts && outcome.alerts.length > 0) {
    console.log("alerts (new blocking errors introduced by this undo):");
    console.log(formatAlerts(outcome.alerts));
  }
  console.log("inverse (the REDO this undo carries — scriptable):");
  console.log(`  ${JSON.stringify(outcome.inverse)}`);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
