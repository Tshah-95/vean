#!/usr/bin/env bun
// lint:xml — the STRICT XML-VALIDITY gate (Shotcut-openability). This is the
// durable fix for the class of bug where a `.mlt` opens fine in `melt` (which is
// namespace-LENIENT) yet Shotcut refuses it with
//   "Namespace prefix shotcut for filter on filter is not defined"
// because Shotcut parses with a strict, namespace-AWARE `QXmlStreamReader`.
//
//   bun run lint:xml
//
// It runs `xmllint --noout --nsclean` (namespace-aware) over:
//   1. every committed `corpus/*.mlt` (what ships), AND
//   2. the FRESHLY-SERIALIZED output of every fixture in corpus/vean-fixtures.ts
//      (what the serializer produces RIGHT NOW — so a regression is caught even
//      before the corpus is re-blessed).
//
// CRITICAL subtlety this gate exists to handle: `xmllint` EXITS 0 on a namespace
// error (an undeclared `shotcut:` prefix), printing the diagnostic only to STDERR.
// A naive `xmllint --noout || fail` would let exactly our bug through. So a file
// FAILS this gate iff `xmllint` exits non-zero OR emits ANY stderr — either a
// well-formedness error (non-zero exit) or a namespace error (zero exit, stderr).
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VEAN_FIXTURES } from "../corpus/vean-fixtures";
import { toMlt } from "../src/ir/serialize";

const ROOT = resolve(import.meta.dirname, "..");
const CORPUS = join(ROOT, "corpus");
const OUT = join(ROOT, "out", "lint-xml");

/** The outcome of namespace-aware linting one XML document on disk. */
export type LintResult = { label: string; ok: boolean; detail: string };

/** Run `xmllint --noout --nsclean` (namespace-aware) on a file. A file is clean
 *  iff xmllint exits 0 AND emits NO diagnostics. We capture stderr (merged via a
 *  shell, so it survives any exit code) and key off it directly: ANY xmllint
 *  output is a defect. This is the whole point of the gate — an undeclared
 *  `shotcut:` prefix is reported on stderr at EXIT 0, so a naive exit-code check
 *  (`xmllint --noout || fail`) would wave exactly our bug through. A
 *  well-formedness error also lands on stderr (with a non-zero exit), so the single
 *  "stderr non-empty ⇒ fail" rule covers both. */
function lintFile(path: string, label: string): LintResult {
  // Merge stderr→stdout so the namespace diagnostic is read regardless of exit
  // code; `|| true` keeps a non-zero exit from throwing before we read it.
  const cmd = `xmllint --noout --nsclean ${sh(path)} 2>&1 || true`;
  const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8" }).trim();
  return out === ""
    ? { label, ok: true, detail: "clean" }
    : { label, ok: false, detail: firstLine(out) };
}

/** POSIX single-quote escape for embedding a path in a `sh -c` command. */
function sh(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function firstLine(s: string): string {
  return s.split("\n").find((l) => l.trim() !== "") ?? "";
}

function listCorpus(): string[] {
  try {
    return readdirSync(CORPUS)
      .filter((f) => f.endsWith(".mlt"))
      .sort();
  } catch {
    return [];
  }
}

/** Lint EVERY namespace surface — both committed `corpus/*.mlt` and the fresh
 *  serializer output of every vean fixture — and return the per-document results.
 *  Pure of process control (no exit) so `verify-corpus` can fold the same gate in
 *  and report it inline. */
export function lintAll(): LintResult[] {
  mkdirSync(OUT, { recursive: true });
  const results: LintResult[] = [];

  // 1. Every committed corpus file (what ships on disk).
  for (const name of listCorpus()) {
    results.push(lintFile(join(CORPUS, name), `corpus/${name}`));
  }

  // 2. The FRESH serializer output of every vean fixture (what toMlt emits now —
  //    catches a serializer regression before the corpus is re-blessed).
  for (const [name, make] of Object.entries(VEAN_FIXTURES)) {
    const xml = toMlt(make());
    const tmp = join(OUT, name);
    writeFileSync(tmp, xml);
    results.push(lintFile(tmp, `serialize(${name})`));
  }
  return results;
}

function main(): void {
  if (listCorpus().length === 0) {
    console.error(`lint:xml — no .mlt files in ${CORPUS}`);
    process.exit(2);
  }
  const results = lintAll();
  for (const r of results) {
    console.log(`${r.ok ? "ok  " : "FAIL"}  ${r.label.padEnd(28)} ${r.ok ? "" : r.detail}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log(
    failed.length === 0
      ? `OVERALL: PASS — ${results.length}/${results.length} XML namespace-clean (Shotcut-openable)`
      : `OVERALL: FAIL — ${failed.length}/${results.length} have XML/namespace errors: ${failed
          .map((f) => f.label)
          .join(", ")}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.main) {
  main();
}
