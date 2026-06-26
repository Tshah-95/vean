#!/usr/bin/env bun
// roundtrip — the Move-0 round-trip harness. Reads a `.mlt`, parses it to the IR,
// re-serializes, and reports whether the result is semantically equal (byte-
// identical for vean's own emissions). The CLI face of the round-trip gate.
//
//   bun run roundtrip <file.mlt>
//
// What "semantically equal" means, concretely (two distinct guarantees, both
// checked, so the harness is honest about Shotcut-saved files it can't byte-match):
//
//   1. BYTE-IDENTITY (the strong contract) — for a file vean ITSELF emitted,
//      `serialize(parse(x))` must reproduce `x` byte-for-byte. When the input is
//      byte-identical to the re-emission, the round-trip is loss-free and we say
//      so explicitly.
//
//   2. FIXPOINT / IDEMPOTENCE (the semantic contract) — a real Shotcut document
//      carries spelling vean normalizes (attribute order, decimal separators,
//      proxies, redundant hints). vean is NOT required to reproduce that input
//      byte-for-byte, but it MUST reach a STABLE normal form: parsing the
//      re-emission and serializing again has to yield the SAME bytes as the first
//      emission. If `serialize(parse(serialize(parse(x))))` differs from
//      `serialize(parse(x))`, the parser is dropping or mangling information on
//      the round-trip — that's the real failure, and the diff localizes it.
//
// PASS = the IR reaches a fixpoint (always required). The report additionally
// flags whether the input was byte-loss-free (guarantee 1).
//
// This module exports `roundtripXml` / `formatRoundtrip` so `verify-corpus.ts`
// reuses the exact same semantic check before it spends a render on faithfulness.
import { fromMlt } from "../src/ir/parse";
import { toMlt } from "../src/ir/serialize";

/** The outcome of round-tripping one `.mlt` document through the IR. */
export type RoundtripReport = {
  /** PASS iff the IR reached a fixpoint (the re-emission is stable under a second
   *  parse→serialize). This is the load-bearing semantic gate. */
  pass: boolean;
  /** True iff the input was reproduced BYTE-for-byte (the strong contract that
   *  only holds for vean's own emissions; informational for Shotcut files). */
  byteIdentical: boolean;
  /** The first emission: `serialize(parse(input))`. */
  emitted: string;
  /** The fixpoint emission: `serialize(parse(emitted))`. Equal to `emitted` on PASS. */
  reEmitted: string;
  /** The original input bytes (whitespace-normalized only for the trailing-newline
   *  comparison; the diff is computed against this). */
  input: string;
  /** A unified-ish line diff of `emitted` vs `reEmitted` when the fixpoint fails,
   *  or of `input` vs `emitted` when it passes but is not byte-identical. Empty on
   *  a clean byte-identical pass. */
  diff: string;
};

/** Normalize for comparison: trim a single trailing newline so a file saved with
 *  or without a final `\n` doesn't read as a difference. Internal content is NOT
 *  touched — byte-identity for vean's own output is checked against this. */
function norm(s: string): string {
  return s.replace(/\n$/, "");
}

/** Compute a compact line-level diff (old → new). Pure, dependency-free: marks
 *  the first divergent region with context so a localized failure is obvious
 *  without pulling in a diff library. */
export function lineDiff(a: string, b: string, context = 2): string {
  const al = a.split("\n");
  const bl = b.split("\n");
  const max = Math.max(al.length, bl.length);
  let firstDiff = -1;
  let lastDiff = -1;
  for (let i = 0; i < max; i++) {
    if (al[i] !== bl[i]) {
      if (firstDiff === -1) firstDiff = i;
      lastDiff = i;
    }
  }
  if (firstDiff === -1) return "";
  const start = Math.max(0, firstDiff - context);
  const end = Math.min(max, lastDiff + context + 1);
  const out: string[] = [];
  out.push(`@@ lines ${start + 1}–${end} (first divergence at line ${firstDiff + 1}) @@`);
  for (let i = start; i < end; i++) {
    const x = al[i];
    const y = bl[i];
    if (x === y) {
      out.push(`  ${x ?? ""}`);
    } else {
      if (x !== undefined) out.push(`- ${x}`);
      if (y !== undefined) out.push(`+ ${y}`);
    }
  }
  return out.join("\n");
}

/** Round-trip one `.mlt` document string through `parse → serialize` and report
 *  whether the IR reached a stable normal form (fixpoint) plus whether the input
 *  was reproduced byte-for-byte. Pure: no filesystem, no subprocess — so it is
 *  unit-testable and reused by both the CLI and the corpus gate. */
export function roundtripXml(input: string): RoundtripReport {
  const emitted = toMlt(fromMlt(input));
  const reEmitted = toMlt(fromMlt(emitted));
  const fixpoint = emitted === reEmitted;
  const byteIdentical = norm(input) === norm(emitted);
  const diff = fixpoint
    ? byteIdentical
      ? ""
      : lineDiff(norm(input), norm(emitted))
    : lineDiff(emitted, reEmitted);
  return {
    pass: fixpoint,
    byteIdentical,
    emitted,
    reEmitted,
    input,
    diff,
  };
}

/** Render a `RoundtripReport` to a human-readable block for a CLI or a gate row. */
export function formatRoundtrip(label: string, r: RoundtripReport): string {
  const status = r.pass ? "PASS" : "FAIL";
  const mode = r.byteIdentical
    ? "byte-identical (loss-free)"
    : r.pass
      ? "fixpoint stable (normalized; not byte-identical to input)"
      : "NOT a fixpoint — parser lost or mangled information";
  const lines = [`${status}  ${label}  —  ${mode}`];
  if (r.diff) {
    lines.push(r.diff);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: bun run roundtrip <file.mlt>");
    process.exit(2);
  }
  const xml = await Bun.file(file).text();
  const report = roundtripXml(xml);
  console.log(formatRoundtrip(file, report));
  process.exit(report.pass ? 0 : 1);
}

// Only run the CLI when invoked directly — importing this module (e.g. from
// verify-corpus or a test) must NOT trigger argv parsing or a process.exit.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
