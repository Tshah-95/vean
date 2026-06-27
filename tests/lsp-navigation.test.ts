// vean-lsp NAVIGATION gate — hover / find-references / go-to-definition over the
// `.mlt` document. Proves the READ surface answers by calling the SHARED core (the
// IR + source map `analyze` produced, and the `src/query` navigation queries —
// `resolveValueAtFrame`, `findReferences`), never recomputing a value or an
// adjacency itself. This file imports the bridge navigation, never a query/rule.
//
// The headline assertion: HOVER over a clip resolves its animated/fade parameters'
// EFFECTIVE values at the clip's start frame through the SHARED resolver — the
// "go-to-definition for video" surface — so a hover number agrees with the
// `resolve` CLI verb (tests/cli-lsp.test.ts) by construction.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Hover } from "vscode-languageserver/node";
import { analyze } from "../src/bridge/lsp/engine";
import { definition, hover, references } from "../src/bridge/lsp/navigation";

const MULTITRACK = readFileSync(
  resolve(import.meta.dirname, "..", "corpus", "vean-multitrack.mlt"),
  "utf8",
);
const KEYFRAMES = readFileSync(
  resolve(import.meta.dirname, "..", "corpus", "vean-keyframes.mlt"),
  "utf8",
);
const URI = "file:///nav.mlt";

/** The markdown body of a hover (the only content shape the engine emits). */
function hoverText(h: Hover | null): string {
  if (!h) return "";
  const c = h.contents as { kind: string; value: string };
  return c.value;
}

/** A document offset inside the producer that defines clip `id`. */
function insideClip(text: string, id: string): number {
  const a = analyze(URI, text);
  const span = a.sourceMap.clips.get(id);
  if (!span) throw new Error(`clip ${id} not in source map`);
  return span.start + 5;
}

describe("hover — resolves a clip's effective parameter values via the SHARED query", () => {
  it("over a clip with a fade resolves the fade level at the clip's start frame", () => {
    const a = analyze(URI, MULTITRACK);
    const offset = insideClip(MULTITRACK, "clip-0"); // carries a fadeIn brightness
    const text = hoverText(hover(a, a.doc.positionAt(offset)));
    expect(text).toContain("**clip** `clip-0`");
    expect(text).toContain("resolved @ frame");
    // fade-IN is 0 at the clip's first frame — the SHARED resolver's answer,
    // surfaced in the hover (and labelled with the producing scope).
    expect(text).toMatch(/fadeIn level`: 0/);
    expect(text).toContain("(via fade)");
  });

  it("over a clip with an animated filter resolves that filter's value at frame 0", () => {
    // The keyframes corpus clip-0 has `brightness.level = 0=0.2;…` — at frame 0 the
    // SHARED resolver reports 0.2 (the same value tests/cli-lsp.test.ts asserts for
    // the `resolve` verb). Hover must agree.
    const a = analyze(URI, KEYFRAMES);
    const offset = insideClip(KEYFRAMES, "clip-0");
    const text = hoverText(hover(a, a.doc.positionAt(offset)));
    expect(text).toMatch(/brightness\.level`: 0\.2/);
    expect(text).toContain("(via clip)");
  });

  it("over a field transition reports its service, track pair, and window", () => {
    const a = analyze(URI, MULTITRACK);
    const span = a.sourceMap.transitions[0];
    expect(span).toBeDefined();
    if (!span) return;
    const text = hoverText(hover(a, a.doc.positionAt(span.start + 5)));
    expect(text).toContain("**transition** #0 `qtblend`");
    expect(text).toMatch(/composites track \d+ over \d+/);
    expect(text).toContain("window: 15–64");
  });

  it("over a track reports its kind, id, and item count", () => {
    const a = analyze(URI, MULTITRACK);
    const span = a.sourceMap.tracks.get("playlist2"); // the audio track A1
    expect(span).toBeDefined();
    if (!span) return;
    const text = hoverText(hover(a, a.doc.positionAt(span.start + 5)));
    expect(text).toMatch(/\*\*audio track\*\* `playlist2` — \d+ item/);
  });

  it("returns null off any addressable element (whitespace at the document head)", () => {
    const a = analyze(URI, MULTITRACK);
    expect(hover(a, a.doc.positionAt(0))).toBeNull();
  });
});

describe("references — delegates the source-usage set to the SHARED query", () => {
  it("returns at least the clip's own location for the source it uses", () => {
    const a = analyze(URI, MULTITRACK);
    const offset = insideClip(MULTITRACK, "clip-0");
    const refs = references(a, a.doc.positionAt(offset));
    expect(refs.length).toBeGreaterThanOrEqual(1);
    // Every returned location is a real range in THIS document.
    for (const r of refs) {
      expect(r.uri).toBe(URI);
      expect(r.range.end.line).toBeGreaterThanOrEqual(r.range.start.line);
    }
  });

  it("returns nothing when the cursor is not on a clip", () => {
    const a = analyze(URI, MULTITRACK);
    expect(references(a, a.doc.positionAt(0))).toEqual([]);
  });
});

describe("definition — points at the clip's identity declaration", () => {
  it("resolves to the shotcut:uuid property value (the clip's 'declaration')", () => {
    const a = analyze(URI, MULTITRACK);
    const offset = insideClip(MULTITRACK, "clip-0");
    const def = definition(a, a.doc.positionAt(offset));
    expect(def).not.toBeNull();
    if (!def) return;
    const text = MULTITRACK.slice(a.doc.offsetAt(def.range.start), a.doc.offsetAt(def.range.end));
    expect(text).toBe("clip-0"); // the uuid value span
  });

  it("returns null when the cursor is not on a clip", () => {
    const a = analyze(URI, MULTITRACK);
    expect(definition(a, a.doc.positionAt(0))).toBeNull();
  });
});
