#!/usr/bin/env bun
// diagnose — the DEBUG / CI / manual-inspection verb for the diagnostics engine.
//
//   bun run diagnose <file.mlt> [--only structural,sync,media] [--json]
//
// It parses a `.mlt` → IR and runs the SHARED diagnostics engine
// (`collectDiagnostics`, src/diagnostics) over it, printing the full current
// diagnostic set + a compact health summary. Exit code is 1 iff there is any
// ERROR diagnostic (a CI gate), else 0 (warnings don't fail the gate; they're
// perceptual advisories).
//
// IMPORTANT — `diagnose` is NOT the agent safety loop. The ambient feedback loop
// (Move 2) is `vean-lsp` PUSHING the diagnostic set into the agent's context after
// every document change (like tsserver / rust-analyzer), so an agent sees adverse
// effects without being told to run a separate command. `diagnose` exists for CI
// gates, test fixtures, one-off inspection, and non-LSP clients — never as the
// step that makes an ordinary edit loop "safe". Do not build a flow that depends
// on remembering to run it.
//
// This is the Move-1b CLI PHASE stub: it wires the engine to a command so Move 2's
// bridge has a working verb to wrap. The engine it calls is the finished, shared
// core; the surface here is intentionally thin.
import { collectDiagnostics, summarize } from "../src/diagnostics";
import type { Diagnostic, Severity } from "../src/diagnostics";
import { fromMlt } from "../src/ir/parse";

const USAGE = "usage: bun run diagnose <file.mlt> [--only structural,sync,media] [--json]";

/** A one-line glyph per severity for the human report. */
const GLYPH: Record<Severity, string> = { error: "✗", warning: "!", info: "i", hint: "·" };

/** Render one diagnostic to a readable line: glyph, code, location, message. */
export function formatDiagnostic(d: Diagnostic): string {
  const loc: string[] = [];
  if (d.location.clip) loc.push(`clip ${d.location.clip}`);
  if (d.location.track) loc.push(`track ${d.location.track}`);
  if (d.location.transition != null) loc.push(`transition #${d.location.transition}`);
  if (d.location.filter != null) loc.push(`filter #${d.location.filter}`);
  if (d.location.range) loc.push(`@ ${d.location.range.from}..${d.location.range.to}`);
  const where = loc.length ? ` (${loc.join(", ")})` : "";
  const fix = d.fix ? `\n        ↳ fix: ${d.fix}` : "";
  return `  ${GLYPH[d.severity]} [${d.code}] ${d.message}${where}${fix}`;
}

/** Severity ordering for a stable, most-important-first sort within a group. */
const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, info: 2, hint: 3 };

/** The full text report for a diagnostic set + its health. Diagnostics are GROUPED
 *  by their producing checker (`source`, stamped by the shared engine), and ordered
 *  most-severe-first within each group — so a debug/CI read scans by subsystem
 *  (structural / sync / media) the way the engine's registry is organized. Pure +
 *  exported so a test (or Move 2's bridge) renders the exact same output. */
export function formatReport(diagnostics: Diagnostic[]): string {
  const health = summarize(diagnostics);
  if (diagnostics.length === 0) {
    return "✓ no diagnostics — the timeline is clean.";
  }
  // Group by `source` (the checker), preserving first-seen group order so the
  // output mirrors the registry order the engine ran the checkers in.
  const groups = new Map<string, Diagnostic[]>();
  for (const d of diagnostics) {
    const g = groups.get(d.source);
    if (g) g.push(d);
    else groups.set(d.source, [d]);
  }
  const lines: string[] = [];
  for (const [source, group] of groups) {
    const sorted = [...group].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    lines.push(`  ▸ ${source} (${group.length})`);
    for (const d of sorted) lines.push(formatDiagnostic(d));
  }
  lines.push(
    `\n  ${health.errors} error(s), ${health.warnings} warning(s), ${health.infos} info, ${health.hints} hint`,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");

  // `--only` selects a checker subset, as `--only=a,b` or `--only a,b`. Absent ⇒
  // run every checker (no filter). The space-separated form CONSUMES the next
  // token as its value, so we record that index and exclude it from the positional
  // <file> search (the bug a naive `argv.find(!--)` would hit).
  const onlyIdx = argv.findIndex((a) => a === "--only" || a.startsWith("--only="));
  let only: string[] | undefined;
  let onlyValueIdx = -1;
  if (onlyIdx >= 0) {
    const arg = argv[onlyIdx] as string;
    let raw: string | undefined;
    if (arg.includes("=")) {
      raw = arg.split("=")[1];
    } else {
      raw = argv[onlyIdx + 1];
      onlyValueIdx = onlyIdx + 1;
    }
    only = raw ? raw.split(",") : undefined;
  }

  // The <file> is the first positional that is neither a flag nor the --only value.
  const file = argv.find((a, i) => !a.startsWith("--") && i !== onlyValueIdx);
  if (!file) {
    console.error(USAGE);
    process.exit(2);
  }

  const xml = await Bun.file(file).text();
  const state = fromMlt(xml);
  const diagnostics = collectDiagnostics(state, only ? { only } : {});
  const health = summarize(diagnostics);

  if (json) {
    console.log(JSON.stringify({ health, diagnostics }, null, 2));
  } else {
    console.log(`diagnose: ${file}`);
    console.log(formatReport(diagnostics));
  }

  // CI gate: any ERROR fails. Warnings are advisory (perceptual) and do not.
  process.exit(health.errors > 0 ? 1 : 0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
