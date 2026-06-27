// The diagnostics no-false-positive HARNESS — the gate that keeps the engine
// trustworthy. It is REGISTRY-DRIVEN: it iterates the committed corpus and the
// `CHECKERS` registry, so a checker added under `src/diagnostics/checks/` (and
// registered in `src/diagnostics/index.ts`) is AUTO-COVERED here with no edit to
// this file — exactly the "auto-covering checkers as they land" contract.
//
// Two halves:
//   1. SILENCE on clean input — every committed corpus `.mlt` (real, valid
//      timelines) must produce ZERO error/warning diagnostics, both for the whole
//      engine and for EACH checker run in isolation. This is the no-false-positive
//      gate: a checker that fires on a valid timeline is worse than no checker.
//   2. The engine is the SHARED core — `collectDiagnostics` returns the FULL set
//      (LSP-ready) and `summarize` derives the compact health the MCP/CLI surface.
//
// (That each checker actually FIRES on a broken state — so silence isn't vacuous —
// is proven in tests/diagnostics-checks.test.ts; this file is the silence gate.)
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKERS, CHECKER_NAMES, collectDiagnostics, summarize } from "../src/diagnostics";
import { fromMlt } from "../src/ir/parse";

const CORPUS = join(import.meta.dirname, "..", "corpus");

/** Every committed corpus `.mlt` file (the clean, valid timelines). */
const corpusFiles = readdirSync(CORPUS).filter((f) => f.endsWith(".mlt"));

describe("diagnostics harness — the registry is wired", () => {
  it("registers at least the structural/sync/media checkers", () => {
    expect(CHECKER_NAMES).toEqual(expect.arrayContaining(["structural", "sync", "media"]));
    // Every entry has a name + a callable check (the registry contract).
    for (const entry of CHECKERS) {
      expect(typeof entry.name).toBe("string");
      expect(typeof entry.check).toBe("function");
    }
  });

  it("found corpus files to test (the gate isn't vacuously empty)", () => {
    expect(corpusFiles.length).toBeGreaterThan(0);
  });
});

describe("diagnostics harness — SILENCE on every clean corpus file", () => {
  for (const file of corpusFiles) {
    const state = () => fromMlt(readFileSync(join(CORPUS, file), "utf8"));

    it(`collectDiagnostics is SILENT (0 errors, 0 warnings) on ${file}`, () => {
      const diagnostics = collectDiagnostics(state());
      const health = summarize(diagnostics);
      // The no-false-positive gate: a valid timeline produces no error/warning.
      // (info/hint advisories are allowed — they don't block.) If this fails, the
      // message names the offending diagnostics so the regression localizes.
      const blocking = diagnostics.filter(
        (d) => d.severity === "error" || d.severity === "warning",
      );
      expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
      expect(health.clean).toBe(true);
    });

    // Registry-driven per-checker silence: EACH checker, run alone, is also silent.
    // This auto-covers any checker added to the registry (no edit here needed) and
    // pinpoints WHICH checker would have a false positive if one regressed.
    for (const entry of CHECKERS) {
      it(`checker "${entry.name}" is silent on ${file}`, () => {
        const only = collectDiagnostics(state(), { only: [entry.name] });
        const blocking = only.filter((d) => d.severity === "error" || d.severity === "warning");
        expect(blocking, JSON.stringify(blocking, null, 2)).toHaveLength(0);
      });
    }
  }
});

describe("diagnostics harness — collectDiagnostics is the LSP-ready full set", () => {
  it("returns an array (the publishDiagnostics payload; empty clears prior)", () => {
    const tl = fromMlt(readFileSync(join(CORPUS, "vean-multitrack.mlt"), "utf8"));
    const diagnostics = collectDiagnostics(tl);
    expect(Array.isArray(diagnostics)).toBe(true);
    // A clean document → an empty set (which an LSP uses to CLEAR diagnostics).
    expect(diagnostics).toEqual([]);
  });

  it("is pure + document-keyed: same IR → identical diagnostics", () => {
    const tl = fromMlt(readFileSync(join(CORPUS, "vean-keyframes.mlt"), "utf8"));
    expect(collectDiagnostics(tl)).toEqual(collectDiagnostics(tl));
  });

  it("`only` runs a checker subset (the focused debug/CI pass)", () => {
    const tl = fromMlt(readFileSync(join(CORPUS, "vean-multitrack.mlt"), "utf8"));
    // An unknown checker name yields nothing; a real one runs.
    expect(collectDiagnostics(tl, { only: ["no-such-checker"] })).toEqual([]);
    expect(collectDiagnostics(tl, { only: ["structural"] })).toEqual([]);
  });
});
