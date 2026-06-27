#!/usr/bin/env bun
// resolve — the resolveValueAtFrame CLI ("go-to-definition for video" from the
// shell). Resolve the EFFECTIVE value of a parameter at a TIMELINE frame, with the
// resolution path (which scope produced it).
//
//   bun run resolve <file.mlt> <frame> <target-json>
//
// where <target-json> is one of the ResolveTarget shapes (src/query/resolve):
//   • clip filter:  {"scope":"clip","clip":"<uuid>","service":"brightness","property":"level"}
//   • clip fade:    {"scope":"fade","clip":"<uuid>","direction":"in"}
//   • transition:   {"scope":"transition","index":0,"property":"compositing"}
//
// Prints the typed value, a scalar readout, whether the playhead is live on the
// target, and the scope chain it walked. This is the Move-1b CLI-phase stub over
// the finished, pure query (`src/query`); Move 2's bridge wraps the same call.
//
// Like `diagnose`, this is a DEBUG / inspection verb, not part of an agent safety
// loop — the LSP surfaces hover/definitions ambiently in Move 2.
import { fromMlt } from "../src/ir/parse";
import { type ResolveTarget, resolveValueAtFrame } from "../src/query/resolve";

const USAGE = "usage: bun run resolve <file.mlt> <frame> <target-json>";

async function main(): Promise<void> {
  const [, , file, frameArg, targetJson] = process.argv;
  if (!file || frameArg === undefined || !targetJson) {
    console.error(USAGE);
    process.exit(2);
  }
  const frame = Number(frameArg);
  if (!Number.isInteger(frame)) {
    console.error(`resolve: <frame> must be an integer, got "${frameArg}"`);
    process.exit(2);
  }
  let target: ResolveTarget;
  try {
    target = JSON.parse(targetJson) as ResolveTarget;
  } catch (err) {
    console.error(
      `resolve: <target-json> is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(2);
    return;
  }

  const xml = await Bun.file(file).text();
  const state = fromMlt(xml);
  const r = resolveValueAtFrame(state, target, frame);

  if (r.notFound) {
    console.error(`resolve: ${r.notFound}`);
    process.exit(1);
  }

  console.log(`resolve: frame ${frame}`);
  console.log(`  value:  ${JSON.stringify(r.value)}`);
  console.log(`  scalar: ${r.scalar ?? "—"}`);
  console.log(`  live:   ${r.live} (playhead ${r.live ? "is" : "is NOT"} on the target)`);
  console.log("  path (innermost-first; * = produced):");
  for (const hop of r.path) {
    console.log(`    ${hop.produced ? "*" : " "} ${hop.scope.padEnd(10)} ${hop.label}`);
  }
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
