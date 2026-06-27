#!/usr/bin/env bun
// preview-op — the `preview-op` MCP tool as a CLI verb. Preview an edit op on a
// `.mlt` WITHOUT writing it: print the consequence report + the inverse + the
// mutation-local alerts the edit WOULD produce, but leave the document on disk
// UNCHANGED. The "report before you render" surface from the shell.
//
//   bun run preview-op <file.mlt> <op> <json-args>
//
// It drives the SAME transport-free mutating-tool core (`preview`, src/bridge/
// tools/mutate) the `preview-op` MCP tool marshals — so the CLI and the agent
// surface produce the identical ToolResult, and neither reimplements a rule
// (`preview` calls the edit algebra + the shared diagnostics engine, discarding the
// new state). Tool-output discipline holds: no standing health snapshot and never a
// full diagnostic dump; new blocking errors are shown as `alerts`.
//
// Exit 0 on a successful preview; 1 on a typed ToolError (the op's precondition or
// invalid args), printed verbatim so a caller can branch on `kind`; 2 on usage /
// malformed JSON args. NOTHING is written, ever — that is what makes it a preview.
import { preview } from "../src/bridge/tools/mutate";
import type { ToolOutcome } from "../src/bridge/tools/types";
import { isToolError } from "../src/bridge/tools/types";
import type { Diagnostic } from "../src/diagnostics";
import { fromMlt } from "../src/ir/parse";
import { formatConsequences } from "./edit";

const USAGE = "usage: bun run preview-op <file.mlt> <op> <json-args>";

/** Render mutation-local alerts. A clean edit has no block at all; this helper is
 *  only called when the tool result carries newly introduced blocking errors. */
export function formatAlerts(alerts: Diagnostic[]): string {
  const lines = [`  ${alerts.length} new blocking error(s):`];
  for (const d of alerts) {
    const where = d.location.clip
      ? ` (clip ${d.location.clip})`
      : d.location.track
        ? ` (track ${d.location.track})`
        : "";
    lines.push(`    [${d.code}] ${d.message}${where}`);
  }
  return lines.join("\n");
}

/** Print a successful preview ToolResult (consequences + inverse + optional alerts)
 *  the same way `apply-op`/`edit` reports a real edit — minus any file write. */
export function reportPreview(outcome: Extract<ToolOutcome, { ok: true }>): void {
  console.log("consequences (what this edit WOULD do — nothing written):");
  console.log(formatConsequences(outcome.consequences));
  if (outcome.alerts && outcome.alerts.length > 0) {
    console.log("alerts (new blocking errors introduced by this edit):");
    console.log(formatAlerts(outcome.alerts));
  }
  console.log("inverse (the undo this edit WOULD carry — scriptable):");
  console.log(`  ${JSON.stringify(outcome.inverse)}`);
}

async function main(): Promise<void> {
  const [, , file, op, argsJson] = process.argv;
  if (!file || !op || argsJson === undefined) {
    console.error(USAGE);
    process.exit(2);
  }

  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch (err) {
    console.error(
      `preview-op: <json-args> is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
    console.error(USAGE);
    process.exit(2);
  }

  const xml = await Bun.file(file).text();
  const state = fromMlt(xml);
  const outcome = preview(state, { op, args }, `file://${file}`);

  if (isToolError(outcome)) {
    console.error(`preview-op: ${op} would fail — ToolError[${outcome.kind}]: ${outcome.detail}`);
    process.exit(1);
  }

  console.log(`preview-op: ${op} on ${file} (DRY RUN — document unchanged)`);
  reportPreview(outcome);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
