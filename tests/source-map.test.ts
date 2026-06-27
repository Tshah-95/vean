// Source-map unit tests — the IR-location → .mlt text-span index the LSP uses to
// turn a diagnostic's stable-identity location into a publishable Range. This is
// the additive lexical pass (src/ir/source-map.ts); it must NOT have perturbed the
// parser (the Move-0/1 round-trip gates cover that separately) and must resolve
// the element kinds the engine addresses (clip, track, transition) by the SAME
// stable id the engine reports.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSourceMap, spanForLocation } from "../src/ir/source-map";

const MULTITRACK = readFileSync(
  resolve(import.meta.dirname, "..", "corpus", "vean-multitrack.mlt"),
  "utf8",
);

describe("buildSourceMap — indexes addressable elements by stable id", () => {
  it("maps each clip uuid to its producer span (and points inside the text)", () => {
    const map = buildSourceMap(MULTITRACK);
    // The corpus carries clip uuids clip-0, clip-1, clip-3, clip-5.
    for (const id of ["clip-0", "clip-1", "clip-3", "clip-5"]) {
      const span = map.clips.get(id);
      expect(span, `clip ${id} should be located`).toBeDefined();
      if (!span) continue;
      expect(span.start).toBeGreaterThanOrEqual(0);
      expect(span.end).toBeGreaterThan(span.start);
      // The span actually covers a <producer> element carrying that uuid.
      const text = MULTITRACK.slice(span.start, span.end);
      expect(text).toContain("<producer");
      expect(text).toContain(id);
    }
  });

  it("maps a clip to the ENTRY that plays it (where the timeline window lives)", () => {
    const map = buildSourceMap(MULTITRACK);
    const entry = map.clipEntries.get("clip-3");
    expect(entry).toBeDefined();
    if (!entry) return;
    const text = MULTITRACK.slice(entry.start, entry.end);
    expect(text).toContain("<entry");
    expect(text).toContain('producer="producer4"'); // clip-3's producer (id producer4)
  });

  it("maps track ids (the playlists) to their spans", () => {
    const map = buildSourceMap(MULTITRACK);
    for (const id of ["playlist0", "playlist1", "playlist2"]) {
      const span = map.tracks.get(id);
      expect(span, `track ${id}`).toBeDefined();
      if (!span) continue;
      expect(MULTITRACK.slice(span.start, span.end)).toContain(`<playlist id="${id}"`);
    }
  });

  it("indexes the FIELD transition (the one with an id) but NOT a nested dissolve's luma/mix", () => {
    const map = buildSourceMap(MULTITRACK);
    // The corpus has exactly one field transition (qtblend, id=transition0); the
    // dissolve's luma+mix are nested and idless → excluded.
    expect(map.transitions).toHaveLength(1);
    const span = map.transitions[0];
    expect(span).toBeDefined();
    if (!span) return;
    expect(MULTITRACK.slice(span.start, span.end)).toContain("qtblend");
  });
});

describe("spanForLocation — resolves a diagnostic location to a span", () => {
  it("prefers the clip anchor, falls back to track, then to the head (0,0)", () => {
    const map = buildSourceMap(MULTITRACK);
    // Clip-scoped → the producer span.
    const clipSpan = spanForLocation(map, { clip: "clip-1", track: "playlist0" });
    expect(clipSpan).toEqual(map.clips.get("clip-1"));
    // Track-only → the playlist span.
    const trackSpan = spanForLocation(map, { track: "playlist1" });
    expect(trackSpan).toEqual(map.tracks.get("playlist1"));
    // Unknown identity → the (0,0) head fallback (a diagnostic is never dropped).
    const headSpan = spanForLocation(map, { clip: "ghost" });
    expect(headSpan).toEqual({ start: 0, end: 0 });
  });
});
