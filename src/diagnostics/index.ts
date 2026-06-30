// The diagnostics ENGINE — the shared core. This is the ONE place domain validity
// rules live; the LSP, MCP tools, the CLI debug verb, tests, and the future UI all
// call `collectDiagnostics` here (AGENTS.md "Agent feedback contract"). Nothing
// reimplements a check elsewhere — putting diagnostics in `src/lsp/` or
// `src/bridge/` is an explicit BUILD-MONITOR escalation trigger.
//
// `collectDiagnostics(state)` runs every registered checker and concatenates the
// results into the FULL current diagnostic set for the document. That FULL-SET
// shape is what makes it LSP-READY: a `vean-lsp` calls it on every document change
// and `publishDiagnostics(uri, collectDiagnostics(doc))` — an EMPTY set clears the
// prior diagnostics (the standard language-server contract). The engine is PURE
// and document-keyed: same IR → same diagnostics, no I/O, no state.
//
// NOTE on the loop: `diagnose` (the CLI/MCP verb that wraps this) is a DEBUG/CI/
// manual-inspection tool, NOT the agent safety loop. The ambient loop is the LSP
// pushing this set after each change; no flow should depend on "remember to run
// diagnose". The CLI help + docstrings frame it that way.
import type { Timeline } from "../ir/types";
import { dials } from "./checks/dials";
import { media } from "./checks/media";
import { structural } from "./checks/structural";
import { sync } from "./checks/sync";
import type { CheckerEntry, Diagnostic } from "./types";

// ─── The registry (name → checker) ──────────────────────────────────────────────
/** The ordered list of registered checkers. A new check lands by adding its file
 *  under `./checks` and one entry here — the engine, every surface, and the
 *  no-false-positive harness pick it up automatically (the harness iterates this
 *  registry, so a new checker is auto-covered against the clean corpus). */
export const CHECKERS: CheckerEntry[] = [
  { name: "structural", check: structural },
  { name: "sync", check: sync },
  { name: "media", check: media },
  { name: "dials", check: dials },
];

/** The names of every registered checker (for the harness + a `--only` filter). */
export const CHECKER_NAMES: string[] = CHECKERS.map((c) => c.name);

// ─── collectDiagnostics — the LSP-ready full-set entry point ─────────────────────
/** Run every registered checker over `state` and return the FULL current
 *  diagnostic set for the document (the LSP `publishDiagnostics` payload; an empty
 *  array clears prior diagnostics). Pure + document-keyed: same IR → same set, no
 *  I/O. Each checker's `name` is stamped onto every Diagnostic's `source` here, so
 *  a checker body never has to repeat its own name and provenance is authoritative.
 *
 *  `opts.only` runs a subset of checkers by name (for a focused debug/CI pass);
 *  omitted runs them all (the normal LSP path). */
export function collectDiagnostics(
  state: Timeline,
  opts: { only?: readonly string[] } = {},
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const entry of CHECKERS) {
    if (opts.only && !opts.only.includes(entry.name)) continue;
    for (const d of entry.check(state)) {
      // The registry is the authority on `source` — overwrite whatever the checker
      // set so provenance always matches the registered name.
      out.push({ ...d, source: entry.name });
    }
  }
  return out;
}

/** A compact health summary of a diagnostic set — used by the explicit `diagnose`
 *  debug/CI surface and CLI reports. Mutating tools intentionally do not return
 *  this standing health snapshot; they only surface mutation-local alerts. */
export type DiagnosticHealth = {
  errors: number;
  warnings: number;
  infos: number;
  hints: number;
  /** True iff there are zero errors AND zero warnings (the "clean" gate). */
  clean: boolean;
};

/** Summarize a diagnostic set into counts + a clean flag (zero errors+warnings). */
export function summarize(diagnostics: readonly Diagnostic[]): DiagnosticHealth {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  let hints = 0;
  for (const d of diagnostics) {
    if (d.severity === "error") errors++;
    else if (d.severity === "warning") warnings++;
    else if (d.severity === "info") infos++;
    else hints++;
  }
  return { errors, warnings, infos, hints, clean: errors === 0 && warnings === 0 };
}

// ─── Re-exports (the public diagnostics surface) ────────────────────────────────
export type {
  Checker,
  CheckerEntry,
  Diagnostic,
  DiagnosticInput,
  DiagnosticLocation,
  RelatedLocation,
  Severity,
} from "./types";
export { diag } from "./types";
export { structural } from "./checks/structural";
export { sync } from "./checks/sync";
export { media } from "./checks/media";
export { dials } from "./checks/dials";
