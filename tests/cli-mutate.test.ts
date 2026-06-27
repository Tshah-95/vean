// CLI smoke tests for the MUTATING-tool CLI verbs `scripts/preview-op.ts` and
// `scripts/undo-op.ts` — the shell forms of the `preview-op` / `undo` MCP tools.
// They spawn the ACTUAL scripts under `bun` against a real corpus file (vitest
// workers run under Node, so we shell out to the `bun` binary), proving the
// agent-facing CLI works as documented.
//
// What each asserts:
//   • `preview-op` on a valid op exits 0, prints the consequence report + the
//     inverse, and writes NOTHING —
//     a DRY RUN leaves the input file byte-identical;
//   • `preview-op` of a bad precondition exits 1 with the typed ToolError, still
//     writing nothing;
//   • `undo-op` re-applies an inverse to a working copy, writes a Shotcut-clean
//     file (the SAME xmllint gate `edit` enforces), and the result round-trips;
//   • an apply→undo CLI round-trip (`edit` forward, then `undo-op` with the printed
//     inverse) restores the document to vean's normal form byte-for-byte.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { xmlIsClean } from "../scripts/edit";
import { fromMlt } from "../src/ir/parse";
import { toMlt } from "../src/ir/serialize";

const ROOT = resolve(import.meta.dirname, "..");
const EDIT = join(ROOT, "scripts", "edit.ts");
const PREVIEW = join(ROOT, "scripts", "preview-op.ts");
const UNDO_OP = join(ROOT, "scripts", "undo-op.ts");
const CORPUS_FILE = join(ROOT, "corpus", "vean-multitrack.mlt");

// `clip-3` is a real clip in the multitrack corpus; a trimIn of +10 is a safe,
// in-bounds tighten (used by the move2 e2e gate too).
const CLIP = "clip-3";

type Run = { code: number; stdout: string; stderr: string };

function runScript(script: string, args: string[]): Run {
  try {
    const stdout = execFileSync("bun", [script, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      code: typeof e.status === "number" ? e.status : 1,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() ?? "",
    };
  }
}

describe("scripts/preview-op.ts — CLI dry-run", () => {
  let dir: string;
  let doc: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vean-cli-preview-"));
    doc = join(dir, "doc.mlt");
    copyFileSync(CORPUS_FILE, doc);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("previews a valid op: exits 0, prints consequences + inverse, writes NOTHING", () => {
    const before = readFileSync(doc, "utf8");
    const run = runScript(PREVIEW, [doc, "trimIn", JSON.stringify({ uuid: CLIP, delta: 10 })]);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain("DRY RUN");
    expect(run.stdout).toContain("consequences");
    // Clean previews do not print a standing health block; the inverse is scriptable.
    expect(run.stdout).not.toContain("health");
    expect(run.stdout).not.toContain("alerts");
    expect(run.stdout).toContain("inverse");
    // It is a DRY RUN — the file on disk is byte-identical.
    expect(readFileSync(doc, "utf8")).toBe(before);
  });

  it("a bad precondition exits 1 with the typed ToolError and writes nothing", () => {
    const before = readFileSync(doc, "utf8");
    const run = runScript(PREVIEW, [doc, "gain", JSON.stringify({ uuid: "ghost", db: 0 })]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("clip-not-found");
    expect(readFileSync(doc, "utf8")).toBe(before);
  });

  it("malformed JSON args are a usage error (exit 2)", () => {
    const run = runScript(PREVIEW, [doc, "trimIn", "{not json"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("not valid JSON");
  });
});

describe("scripts/undo-op.ts — re-apply an inverse to a file", () => {
  let dir: string;
  let doc: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vean-cli-undoop-"));
    doc = join(dir, "doc.mlt");
    copyFileSync(CORPUS_FILE, doc);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("an apply (edit) → undo-op round-trip restores the document to vean's normal form byte-for-byte", () => {
    // vean's NORMAL FORM of the input is the byte-target undo must reproduce (a
    // Shotcut-saved file carries spelling vean normalizes).
    const normalized = toMlt(fromMlt(readFileSync(CORPUS_FILE, "utf8")));
    const edited = join(dir, "edited.mlt");

    // Forward: apply a gain via `edit`, capturing the printed inverse JSON.
    const fwd = runScript(EDIT, [doc, "gain", JSON.stringify({ uuid: CLIP, db: -6 }), edited]);
    expect(fwd.code).toBe(0);
    // Pull the inverse invocation off the `edit` output (the line after "inverse").
    const m = fwd.stdout.match(/\{"op":"[^"]+","args":\{[^\n]*\}\}/);
    expect(m).not.toBeNull();
    const inverseJson = (m as RegExpMatchArray)[0];

    // Undo: re-apply that inverse to the edited file via `undo-op`, in place.
    const back = runScript(UNDO_OP, [edited, inverseJson]);
    expect(back.code).toBe(0);
    expect(back.stdout).toContain("clean (Shotcut-openable)");

    // The undone file is byte-identical to vean's normal form of the original.
    const undone = readFileSync(edited, "utf8");
    expect(undone).toBe(normalized);
    // And it is itself Shotcut-clean + round-trips.
    expect(xmlIsClean(undone).ok).toBe(true);
    expect(() => toMlt(fromMlt(undone))).not.toThrow();
  });

  it("a malformed inverse-json is a usage error (exit 2)", () => {
    const run = runScript(UNDO_OP, [doc, "{not json"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("not valid JSON");
    expect(existsSync(doc)).toBe(true);
  });

  it("an inverse naming a missing clip exits 1 with the typed ToolError", () => {
    const run = runScript(UNDO_OP, [
      doc,
      JSON.stringify({ op: "gain", args: { uuid: "ghost", db: 0 } }),
    ]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("clip-not-found");
  });
});
