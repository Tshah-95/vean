#!/usr/bin/env bun
// undo — the round-trip DEMONSTRATION for the edit algebra. It applies one op to a
// `.mlt`, then applies that op's OWN printed inverse, and proves the document is
// restored BYTE-FOR-BYTE — the operational form of inverse-law #2 ("apply(inverse,
// apply(op).state).state deep-equals the original").
//
//   bun run undo <in.mlt> <op> <json-args>
//
// It prints the inverse invocation `edit` would print, the undone document's
// status, and PASS/FAIL on the byte-identity check. Exit 0 iff the inverse
// reproduces the original.
//
// IMPORTANT — why undo is done IN-PROCESS here, not by re-invoking `edit` on the
// written file: a clip's uuid (`Clip.id`) is stable WITHIN a session (which is all
// the op contract + its inverse need — ops and undo run on the live IR), but it
// does NOT yet survive a serialize→parse round-trip. `serialize.ts` mints
// ephemeral `producer${N}` ids and `parse.ts` reads them back, so an op that mints
// a uuid (split's left half, a future paste) writes a fresh uuid that a RELOAD
// renames — and the inverse JSON, which references that in-session uuid, would no
// longer resolve against the reloaded file (you'd get `clip-not-found`). Closing
// that gap is Move 1b's recorded diff (route `Clip.id` through `shotcut:uuid`; see
// DESIGN-MOVE1.md §1 "Known persistence gap"). Until then, the *correct* undo —
// and the one the contract guarantees — is the inverse applied to the live result
// state, which is exactly what this demonstration (and `edit`'s own self-check)
// runs. The inverse JSON is still printed so it is scriptable the moment Move 1b
// makes ids round-trip-stable.
//
// Reuses `runEdit` from `edit.ts`, so this demonstration drives the identical
// apply→undo path the CLI verifies.
import { fromMlt } from "../src/ir/parse";
import { toMlt } from "../src/ir/serialize";
import { runEdit } from "./edit";
import { lineDiff } from "./roundtrip";

const USAGE = "usage: bun run undo <in.mlt> <op> <json-args>";

async function main(): Promise<void> {
  const [, , inPath, op, argsJson] = process.argv;
  if (!inPath || !op || argsJson === undefined) {
    console.error(USAGE);
    process.exit(2);
  }

  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch (err) {
    console.error(
      `undo: <json-args> is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(2);
  }

  const inputXml = await Bun.file(inPath).text();
  // The byte-target is vean's NORMAL FORM of the input (parse→serialize) — a
  // Shotcut-saved file carries spelling vean normalizes, so undo must reproduce
  // `toMlt(fromMlt(input))`, not the raw input bytes.
  const normalized = toMlt(fromMlt(inputXml));

  const outcome = runEdit(inputXml, op, args);
  if (!outcome.ok) {
    console.error(
      `undo: forward op failed — EditError[${outcome.error.kind}]: ${JSON.stringify(outcome.error)}`,
    );
    process.exit(1);
  }

  console.log(`undo demo: ${op} then its inverse`);
  console.log(`  forward op:  ${op} ${JSON.stringify(args)}`);
  console.log(`  inverse op:  ${JSON.stringify(outcome.result.inverse)}`);

  if (outcome.undoneXml === null) {
    console.error("  FAIL — the inverse itself returned an EditError (inverse-law violation)");
    process.exit(1);
  }

  if (outcome.undoVerified) {
    console.log("  PASS — applying the inverse restored the original document byte-for-byte");
    process.exit(0);
  }

  // Localize the divergence so a regression in an op's inverse is obvious.
  console.error("  FAIL — undone document is NOT byte-identical to the original normal form:");
  console.error(lineDiff(normalized, outcome.undoneXml));
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
