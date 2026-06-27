// The diagnostics CONTRACT — the `Diagnostic` shape and the checker interface
// every rule (`src/diagnostics/checks/*.ts`) is written against. This is the
// SHARED CORE: the LSP, MCP tools, the CLI debug verb, tests, and the future UI
// all call the one engine in `src/diagnostics/`; none reimplement a check
// elsewhere (the load-bearing "diagnostics engine is shared core" rule —
// AGENTS.md "Agent feedback contract", BUILD-MONITOR.md escalation trigger).
//
// A checker is a PURE function `(state) => Diagnostic[]`: it reads the IR and
// returns the diagnostics it finds, with NO I/O and no mutation. The registry
// (`./index`) runs every checker and concatenates the results into the FULL
// current set for a document — exactly what an LSP `publishDiagnostics` needs
// (an empty set clears prior diagnostics).
import type { Timeline } from "../ir/types";

// ─── Severity ──────────────────────────────────────────────────────────────────
/** LSP-aligned severities. `error` blocks a faithful render (an unserializable or
 *  mis-rendering state); `warning` is a perceptual hazard (judder, upscaling);
 *  `info`/`hint` are advisory. The engine reports all; a surface decides which to
 *  show. (Mirrors the LSP DiagnosticSeverity 1..4 ordering.) */
export type Severity = "error" | "warning" | "info" | "hint";

// ─── Location ───────────────────────────────────────────────────────────────────
/** WHERE a diagnostic applies, by STABLE identity (a clip uuid, a track id, a
 *  transition index) + an optional frame range in TIMELINE space — never an
 *  ephemeral clip index. An LSP maps this onto document ranges; the CLI prints it;
 *  the UI highlights it. All fields optional so a whole-document diagnostic (e.g.
 *  "fps mismatch") can omit a specific anchor. */
export type DiagnosticLocation = {
  /** The clip's stable uuid, when the diagnostic is clip-scoped. */
  clip?: string;
  /** The track's stable id, when track-scoped. */
  track?: string;
  /** A field transition's index, when transition-scoped. */
  transition?: number;
  /** A filter's index within its clip, when filter-scoped. */
  filter?: number;
  /** Inclusive timeline frame range the diagnostic covers, when positional. */
  range?: { from: number; to: number };
};

// ─── A related location (the "see also" set) ───────────────────────────────────
/** A secondary location a diagnostic refers to (the OTHER clip in an overlap, the
 *  source a dangling ref points at). Mirrors the LSP `relatedInformation`. */
export type RelatedLocation = {
  location: DiagnosticLocation;
  message: string;
};

// ─── The Diagnostic ─────────────────────────────────────────────────────────────
/** One diagnostic: a stable machine `code`, a `severity`, a human `message`, a
 *  `location`, and optional `related` locations + a `fix` hint. The `code` is the
 *  durable identity (an LSP/CLI keys off it; never reword it casually); the
 *  `message` is the human text. `data` carries machine payload (the offending
 *  numbers) for a code action or a structured report. */
export type Diagnostic = {
  /** Stable machine identity, e.g. `clip-overlap`, `in-out-beyond-source`. */
  code: string;
  severity: Severity;
  /** The checker that produced this (set by the registry, for provenance). */
  source: string;
  message: string;
  location: DiagnosticLocation;
  /** Secondary locations (the LSP relatedInformation). */
  related?: RelatedLocation[];
  /** A short hint at the deterministic repair, when one exists (the seed of an LSP
   *  code action / MCP safe-edit). Not the fix itself — just its description. */
  fix?: string;
  /** Machine payload (offending numbers, ids) for a structured consumer. */
  data?: Record<string, number | string | boolean>;
};

// ─── The checker contract (name → (state) => Diagnostic[]) ──────────────────────
/** A single diagnostic rule. PURE: reads the IR, returns its findings, no I/O, no
 *  mutation. The registry runs every checker on the document and concatenates the
 *  results into the full current set. A checker must emit ZERO diagnostics on a
 *  VALID timeline (the no-false-positive gate, asserted over the clean corpus by
 *  `tests/diagnostics-harness.test.ts`). */
export type Checker = (state: Timeline) => Diagnostic[];

/** A registry entry: the checker's stable name (stamped onto each Diagnostic's
 *  `source`) + the function. */
export type CheckerEntry = {
  /** Stable name, also the diagnostic `source` (e.g. `structural`, `sync`). */
  name: string;
  check: Checker;
};

// ─── Small constructors (keep checker bodies terse) ─────────────────────────────
/** Build a Diagnostic without the `source` (the registry stamps `source` from the
 *  checker name, so a checker body never repeats its own name). */
export type DiagnosticInput = Omit<Diagnostic, "source">;

/** Sugar for an error/warning/info/hint diagnostic (source filled by the registry). */
export function diag(input: DiagnosticInput): DiagnosticInput {
  return input;
}
