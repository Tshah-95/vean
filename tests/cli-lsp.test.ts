// CLI smoke tests for the Move-1b LSP-side verbs: `diagnose` (publish-diagnostics
// over the shell), `resolve` (go-to-definition for video), `refs` (find-all-
// references). Each spawns the ACTUAL script under `bun` against a real corpus file
// — an end-to-end check that the agent/CI-facing CLI works as documented, and that
// `diagnose`'s exit code is a usable CI gate (0 clean, 1 on an error).
//
// These three verbs are the READ / diagnostic side of the LSP surface — they wrap
// the SHARED engine/query (src/diagnostics, src/query) and reimplement no rule, the
// same core the real `vean-lsp` and MCP tools will call in Move 2. `diagnose` is
// framed as DEBUG/CI here, NOT the agent safety loop (AGENTS.md "Agent feedback
// contract": the ambient loop is the LSP PUSHING diagnostics after each change).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const DIAGNOSE = join(ROOT, "scripts", "diagnose.ts");
const RESOLVE = join(ROOT, "scripts", "resolve.ts");
const REFS = join(ROOT, "scripts", "refs.ts");
const MULTITRACK = join(ROOT, "corpus", "vean-multitrack.mlt");

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

// A hand-authored `.mlt` with a clip window PAST its source length — a defect the
// serializer won't emit (it's an unserializable state), but a real broken file an
// agent could load. Exercises diagnose's error path + exit-1 CI gate.
const BROKEN_MLT = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.38.0" root="" title="broken">
  <profile description="x" width="1080" height="1920" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="9" display_aspect_den="16" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="200">
    <property name="length">100</property>
    <property name="mlt_service">color</property>
    <property name="resource">#FF000000</property>
    <property name="shotcut:uuid">badclip</property>
  </producer>
  <playlist id="playlist0">
    <property name="shotcut:video">1</property>
    <property name="shotcut:audio">0</property>
    <property name="shotcut:name">V1</property>
    <entry producer="producer0" in="0" out="200"/>
  </playlist>
  <tractor id="tractor0" shotcut="1" title="broken">
    <track producer="playlist0"/>
  </tractor>
</mlt>
`;

describe("scripts/diagnose.ts — the debug/CI verb", () => {
  it("exits 0 and reports CLEAN on a valid corpus file", () => {
    const run = runScript(DIAGNOSE, [MULTITRACK]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("no diagnostics");
  });

  it("--json emits the health summary + diagnostics array (empty when clean)", () => {
    const run = runScript(DIAGNOSE, [MULTITRACK, "--json"]);
    expect(run.code).toBe(0);
    const parsed = JSON.parse(run.stdout) as {
      health: { errors: number; clean: boolean };
      diagnostics: unknown[];
    };
    expect(parsed.health.clean).toBe(true);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("no <file> is a usage error (exit 2) printing the usage line", () => {
    const run = runScript(DIAGNOSE, []);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("usage: bun run diagnose");
  });

  describe("on a broken file", () => {
    let dir: string;
    let path: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "vean-diag-"));
      path = join(dir, "broken.mlt");
      writeFileSync(path, BROKEN_MLT);
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("exits 1 (the CI gate) and names the error diagnostic", () => {
      const run = runScript(DIAGNOSE, [path]);
      expect(run.code).toBe(1); // an ERROR fails the gate
      expect(run.stdout).toContain("in-out-beyond-source");
    });

    it("groups the report by producing checker (the `source` group header)", () => {
      const run = runScript(DIAGNOSE, [path]);
      // The window-past-source defect comes from the `structural` checker; the
      // report groups under that source, with the code + a ✗ error glyph + the
      // location beneath it.
      expect(run.stdout).toContain("▸ structural");
      expect(run.stdout).toMatch(/✗ \[in-out-beyond-source]/);
      expect(run.stdout).toContain("clip badclip"); // the clip-scoped location prints
    });

    it("--json carries the error in the diagnostics array", () => {
      const run = runScript(DIAGNOSE, [path, "--json"]);
      expect(run.code).toBe(1);
      const parsed = JSON.parse(run.stdout) as {
        health: { errors: number };
        diagnostics: Array<{ code: string; source: string }>;
      };
      expect(parsed.health.errors).toBeGreaterThanOrEqual(1);
      expect(parsed.diagnostics.some((d) => d.code === "in-out-beyond-source")).toBe(true);
    });
  });
});

describe("scripts/resolve.ts — the resolveValueAtFrame verb", () => {
  it("resolves a clip fade level + prints the resolution path", () => {
    const run = runScript(RESOLVE, [
      MULTITRACK,
      "0",
      JSON.stringify({ scope: "fade", clip: "clip-0", direction: "in" }),
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("scalar: 0"); // fade-in is 0 at frame 0
    expect(run.stdout).toContain("* fade");
  });

  it("resolves an animated clip filter property", () => {
    const kf = join(ROOT, "corpus", "vean-keyframes.mlt");
    const run = runScript(RESOLVE, [
      kf,
      "0",
      JSON.stringify({ scope: "clip", clip: "clip-0", service: "brightness", property: "level" }),
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("scalar: 0.2");
  });

  it("a missing clip exits non-zero with notFound on stderr", () => {
    const run = runScript(RESOLVE, [
      MULTITRACK,
      "0",
      JSON.stringify({ scope: "fade", clip: "ghost", direction: "in" }),
    ]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/not found/);
  });
});

describe("scripts/refs.ts — the findReferences verb", () => {
  it("lists a clip's ripple set (with cross-track reach under ripple)", () => {
    const run = runScript(REFS, [
      MULTITRACK,
      JSON.stringify({ kind: "clip", clip: "clip-0", ripple: true }),
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("same-track-after");
    expect(run.stdout).toContain("cross-track-after");
    expect(run.stdout).toContain("clip-5"); // the audio shifts too
  });

  it("lists readers/writers of a property", () => {
    const run = runScript(REFS, [
      MULTITRACK,
      JSON.stringify({ kind: "property", property: "frames" }),
    ]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("vean.fadeIn");
  });

  it("a missing clip exits non-zero with notFound", () => {
    const run = runScript(REFS, [MULTITRACK, JSON.stringify({ kind: "clip", clip: "ghost" })]);
    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/not found/);
  });
});
