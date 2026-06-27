#!/usr/bin/env bun
// edit — the edit-algebra CLI. Apply one named op to a `.mlt`, write the result,
// and print BOTH the structured consequences (so you can see what changed before
// a frame renders) and the inverse op as JSON (so undo is scriptable).
//
//   bun run edit <in.mlt> <op> <json-args> [out.mlt]
//
// Concretely it: parses the input `.mlt` → IR (the typed document); looks the op
// up in the registry and applies it through `apply` (which Zod-validates `args`,
// so a malformed call is a typed `invalid-args` EditError, never a throw);
// serializes the result; runs it through the SAME strict namespace-aware XML
// validity gate the corpus uses (`lint-xml`) so we never write a file Shotcut
// would refuse; writes it (default `<in>.edited.mlt`); and prints the consequence
// report as readable text plus the inverse invocation as a one-line JSON object.
//
// Undo is the printed `inverse` invocation. The script ALWAYS verifies it before
// reporting (no flag): it applies the inverse to the result state and checks
// `toMlt(undone)` equals `toMlt(parse(input))` byte-for-byte, printing
// `undo: verified` on success and exiting non-zero on an inverse-law violation —
// so the inverse is proven, not asserted. `scripts/undo.ts` is the standalone
// demonstration of that round-trip (`bun run undo <in.mlt> <op> <json-args>`).
//
// NOTE — undo is verified IN-PROCESS (inverse applied to the live result state),
// which is exactly what the op contract guarantees. It is NOT yet a cross-process
// `bun run edit <out.mlt> <inverse…>` round-trip: a uuid an op MINTS (split's left
// half) is renamed by a serialize→parse reload (the documented Move-1b persistence
// gap, DESIGN-MOVE1.md §1), so the inverse JSON — which names that in-session uuid —
// only resolves against the LIVE state until ids round-trip through `shotcut:uuid`.
//
// On an EditError (clip-not-found, split-at-boundary, invalid-args, …) it prints
// the typed error and exits NON-ZERO. The op never throws for a bad precondition
// (contract law #5) — the failure is a value, surfaced verbatim.
//
// Exported (`runEdit`, `formatConsequences`, `xmlIsClean`) so tests/cli-edit drive
// the exact same path the CLI runs, and so the XML gate is reused, not re-coded.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromMlt } from "../src/ir/parse";
import { toMlt } from "../src/ir/serialize";
import type { Timeline } from "../src/ir/types";
import { type EditError, type OpResult, apply, isEditError } from "../src/ops";

// ─── XML validity gate (Shotcut-openability) ──────────────────────────────────
/** Run the strict, namespace-AWARE `xmllint` gate over an XML string — the same
 *  check `scripts/lint-xml.ts` runs on the corpus, the durable fix for the class
 *  of bug where a `.mlt` opens in `melt` (namespace-lenient) but Shotcut refuses
 *  it ("Namespace prefix shotcut … is not defined"). Returns `{ ok, detail }`.
 *
 *  CRITICAL: `xmllint` EXITS 0 on a namespace error, printing it only to STDERR.
 *  So "clean" means xmllint exits 0 AND emits NO diagnostics — ANY output is a
 *  defect. We write to a temp file (xmllint reads a path), merge stderr→stdout so
 *  the namespace diagnostic survives any exit code, and key off the text. */
export function xmlIsClean(xml: string): { ok: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), "vean-edit-lint-"));
  const file = join(dir, "candidate.mlt");
  try {
    writeFileSync(file, xml);
    const cmd = `xmllint --noout --nsclean ${sh(file)} 2>&1 || true`;
    const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" }).trim();
    return out === ""
      ? { ok: true, detail: "clean" }
      : { ok: false, detail: out.split("\n").find((l) => l.trim() !== "") ?? out };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** POSIX single-quote escape for embedding a path in a `sh -c` command. */
function sh(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─── Consequence reporting (human-readable) ───────────────────────────────────
/** Render an op's `Consequences` to a readable, line-oriented block — only the
 *  fields the op actually touched, so an append shows one "added" line and a
 *  ripple shows the per-track shifts. This is the "reports its consequences
 *  before a single frame renders" surface in text form. Pure + exported so the
 *  test asserts on the same string the CLI prints. */
export function formatConsequences(c: OpResult["consequences"]): string {
  const lines: string[] = [];
  for (const r of c.clipsAdded) {
    lines.push(`  + added    clip ${r.uuid} @ ${r.track}:${r.position} (${r.playtime}f)`);
  }
  for (const r of c.clipsRemoved) {
    lines.push(`  - removed  clip ${r.uuid} @ ${r.track}:${r.position} (${r.playtime}f)`);
  }
  for (const m of c.clipsMoved) {
    lines.push(
      `  ~ moved    clip ${m.uuid}  ${m.from.track}:${m.from.position} → ${m.to.track}:${m.to.position}`,
    );
  }
  for (const t of c.clipsTrimmed) {
    lines.push(
      `  ~ trimmed  clip ${t.uuid}  in${signed(t.inDelta)} out${signed(t.outDelta)} playtime${signed(t.playtimeDelta)}`,
    );
  }
  for (const b of c.blanksCreated) {
    lines.push(`  + blank    @ ${b.track}:${b.position} (${b.length}f)`);
  }
  for (const b of c.blanksRemoved) {
    lines.push(`  - blank    @ ${b.track}:${b.position} (${b.length}f)`);
  }
  for (const r of c.ripple) {
    lines.push(`  » ripple   track ${r.track} shifted ${signed(r.shift)}f from ${r.from}`);
  }
  for (const w of c.warnings) {
    lines.push(`  ! warning  [${w.code}] ${w.detail}`);
  }
  lines.push(`  Δ duration ${signed(c.durationDelta)}f`);
  return lines.join("\n");
}

/** Format a signed number with an explicit leading sign (so a report reads
 *  `+12` / `-5` / `+0`, never an ambiguous bare `0`). */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

// ─── Typed-error reporting ────────────────────────────────────────────────────
/** Render an `EditError` to a readable one-liner — the typed failure surface
 *  (contract law #5), printed verbatim so a caller (or an agent) can branch on
 *  `kind`. The full error is also emitted as JSON for scripting. */
export function formatEditError(e: EditError): string {
  return `EditError[${e.kind}]: ${JSON.stringify(e)}`;
}

// ─── The core (pure of process control, so tests reuse it) ────────────────────
/** The structured outcome of one `edit` invocation — either a typed EditError or
 *  the applied result plus everything the CLI prints/writes. `undoVerified` is the
 *  proof the printed inverse is correct: the inverse, applied to the result state,
 *  re-serializes byte-identically to the (normalized) input. */
export type EditOutcome =
  | { ok: false; error: EditError }
  | {
      ok: true;
      result: OpResult;
      /** The applied state, serialized (what gets written to `out`). */
      outXml: string;
      /** The input, normalized through parse→serialize (the byte-target undo must hit). */
      inputXml: string;
      /** xmllint verdict on `outXml` (Shotcut-openability). */
      lint: { ok: boolean; detail: string };
      /** The inverse applied to the result state, serialized — the "undone"
       *  document. Equals `inputXml` iff the inverse is correct. `null` if the
       *  inverse itself errored (which would itself be an inverse-law violation). */
      undoneXml: string | null;
      /** True iff `undoneXml` reproduces `inputXml` byte-for-byte. */
      undoVerified: boolean;
    };

/** Apply one op to a parsed `.mlt` and assemble the full outcome WITHOUT touching
 *  the filesystem or exiting — the CLI and the tests both call this, so they
 *  exercise identical logic. `inputXml` is the raw `.mlt` text; `op`/`args` are a
 *  registry invocation. Verifies the printed inverse round-trips to the input. */
export function runEdit(inputXml: string, op: string, args: unknown): EditOutcome {
  // Normalize the input through the IR first: undo must reproduce vean's own
  // emission of the parsed input (a Shotcut-saved file carries spelling vean
  // normalizes; the byte-target is `toMlt(fromMlt(input))`, the stable normal
  // form, which is exactly what we WRITE were the op a no-op).
  const startState: Timeline = fromMlt(inputXml);
  const normalizedInput = toMlt(startState);

  const result = apply({ op, args }, startState);
  if (isEditError(result)) return { ok: false, error: result };

  const outXml = toMlt(result.state);
  const lint = xmlIsClean(outXml);

  // Prove the printed inverse undoes the op: apply it to the RESULT state and
  // re-serialize — it must byte-match the normalized input. (Both directions go
  // through `apply`, exactly as a caller's scripted undo would.)
  const undone = apply(result.inverse, result.state);
  const undoneXml = isEditError(undone) ? null : toMlt(undone.state);
  const undoVerified = undoneXml === normalizedInput;

  return { ok: true, result, outXml, inputXml: normalizedInput, lint, undoneXml, undoVerified };
}

/** Default output path for an input `<in>.mlt` → `<in>.edited.mlt` (or append
 *  `.edited.mlt` if the input has no `.mlt` extension). */
export function defaultOutPath(inPath: string): string {
  return inPath.endsWith(".mlt") ? inPath.replace(/\.mlt$/, ".edited.mlt") : `${inPath}.edited.mlt`;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────
const USAGE = "usage: bun run edit <in.mlt> <op> <json-args> [out.mlt]";

async function main(): Promise<void> {
  const [, , inPath, op, argsJson, outArg] = process.argv;
  if (!inPath || !op || argsJson === undefined) {
    console.error(USAGE);
    process.exit(2);
  }

  // Parse the JSON args up front — a malformed JSON string is a usage error
  // (distinct from `invalid-args`, which is a well-formed JSON the op's Zod
  // schema rejects).
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch (err) {
    console.error(
      `edit: <json-args> is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
    console.error(USAGE);
    process.exit(2);
  }

  const inputXml = await Bun.file(inPath).text();
  const outcome = runEdit(inputXml, op, args);

  // Typed failure (contract law #5): print the EditError and exit non-zero. The
  // error is emitted both readably and as raw JSON so a script can branch on it.
  if (!outcome.ok) {
    console.error(formatEditError(outcome.error));
    process.exit(1);
  }

  // Shotcut-openability gate: never WRITE a file the strict namespace-aware
  // parser would refuse. A dirty emission is a serializer defect, not a user
  // error — surface it loudly and don't leave a broken `.mlt` behind.
  if (!outcome.lint.ok) {
    console.error(
      `edit: refusing to write — result is not Shotcut-clean XML: ${outcome.lint.detail}`,
    );
    process.exit(1);
  }

  const outPath = outArg ?? defaultOutPath(inPath);
  writeFileSync(outPath, outcome.outXml);

  // Report. Consequences as readable text; the inverse as one-line JSON so undo
  // is copy-paste scriptable (`bun run edit <out> <inverse.op> '<inverse.args>'`).
  console.log(`edit: ${op} → ${outPath}`);
  console.log(`xml:  ${outcome.lint.ok ? "clean (Shotcut-openable)" : outcome.lint.detail}`);
  console.log("consequences:");
  console.log(formatConsequences(outcome.result.consequences));
  console.log("inverse (undo — scriptable):");
  console.log(`  ${JSON.stringify(outcome.result.inverse)}`);
  console.log(
    `undo: ${
      outcome.undoVerified
        ? "verified — applying the inverse restores the original byte-for-byte"
        : "WARNING — applying the inverse did NOT reproduce the original (inverse-law violation)"
    }`,
  );

  // A failed undo-verification is a contract violation (inverse law #2): the
  // written file is fine, but the printed inverse can't be trusted — fail loud.
  process.exit(outcome.undoVerified ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
