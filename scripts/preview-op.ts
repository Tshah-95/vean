#!/usr/bin/env bun
// preview-op — the `preview-op` MCP tool as a CLI verb. Preview an edit op on a
// `.mlt` WITHOUT writing it: print the consequence report + the inverse + the
// COMPACT diagnostic health the edit WOULD produce, but leave the document on disk
// UNCHANGED. The "report before you render" surface from the shell.
//
//   bun run preview-op <file.mlt> <op> <json-args>
//
// It drives the SAME transport-free mutating-tool core (`preview`, src/bridge/
// tools/mutate) the `preview-op` MCP tool marshals — so the CLI and the agent
// surface produce the identical ToolResult, and neither reimplements a rule
// (`preview` calls the edit algebra + the shared diagnostics engine, discarding the
// new state). Tool-output discipline holds: the printed health is COMPACT (counts +
// new/blocking details only), never a full diagnostic dump.
//
// Exit 0 on a successful preview; 1 on a typed ToolError (the op's precondition or
// invalid args), printed verbatim so a caller can branch on `kind`; 2 on usage /
// malformed JSON args. NOTHING is written, ever — that is what makes it a preview.
import { preview } from "../src/bridge/tools/mutate";
import type { ToolHealth, ToolOutcome } from "../src/bridge/tools/types";
import { isToolError } from "../src/bridge/tools/types";
import { fromMlt } from "../src/ir/parse";
import { formatConsequences } from "./edit";

const USAGE = "usage: bun run preview-op <file.mlt> <op> <json-args>";

/** Render the COMPACT health to a readable block — counts + ONLY the new/blocking
 *  details (never the full set; that's the ambient LSP's / `diagnose`'s job). */
export function formatHealth(h: ToolHealth): string {
  const lines = [
    `  ${h.clean ? "clean" : "NOT clean"} — ${h.errors} error(s), ${h.warnings} warning(s)`,
  ];
  if (h.newOrBlocking.length === 0) {
    lines.push("  new/blocking: (none — this edit introduced no defects)");
  } else {
    lines.push(`  new/blocking (${h.newOrBlocking.length}):`);
    for (const d of h.newOrBlocking) {
      const where = d.location.clip
        ? ` (clip ${d.location.clip})`
        : d.location.track
          ? ` (track ${d.location.track})`
          : "";
      lines.push(`    ${d.severity === "error" ? "✗" : "!"} [${d.code}] ${d.message}${where}`);
    }
  }
  return lines.join("\n");
}

/** Print a successful preview ToolResult (consequences + inverse + compact health)
 *  the same way `apply-op`/`edit` reports a real edit — minus any file write. */
export function reportPreview(outcome: Extract<ToolOutcome, { ok: true }>): void {
  console.log("consequences (what this edit WOULD do — nothing written):");
  console.log(formatConsequences(outcome.consequences));
  console.log("health (compact — counts + new/blocking only):");
  console.log(formatHealth(outcome.health));
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
