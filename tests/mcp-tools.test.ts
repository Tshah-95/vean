// The TOOL-OUTPUT-DISCIPLINE gate (Move 2). Proves the MCP domain tools obey the
// "Tool output discipline" contract (AGENTS.md "Agent feedback contract",
// BUILD-MONITOR review lens #3, the explicit escalation trigger "tool responses
// include full diagnostic dumps by default"):
//
//   • a mutating tool returns `consequences`, `inverse`, `touchedUris`, and a
//     COMPACT `health` summary (errors/warnings counts + new/blocking details);
//   • it does NOT return the full diagnostic set — `health` has no `diagnostics`
//     array, and on a clean edit the detail list is empty;
//   • a NEW defect introduced by an edit DOES appear in `health.newOrBlocking`
//     (the agent sees the adverse effect without being told to run diagnose),
//     while the FULL pre-existing set is never dumped;
//   • the inverse round-trips (undo restores the original IR);
//   • a precondition failure is a typed ToolError value, not a throw.
//
// These run on the PURE tool core (mutate/preview/diagnose), which is Bun-free, so
// they execute under vitest's Node host. The render→still leg (which needs the
// melt binary + Bun file I/O) is the separate `bun run move2:e2e` gate; here we
// prove every clip the seeded tasks touch ends in a clean, serializable state.
import { describe, expect, it } from "vitest";
import { diagnoseTool, serializeDoc } from "../src/bridge/tools/core";
// The mutating tools come from their dedicated module (the compact-health contract
// these tests gate lives there).
import { mutate, preview } from "../src/bridge/tools/mutate";
import { isToolError } from "../src/bridge/tools/types";
import { VERTICAL, clip, colorClip, filter, resetIds, timeline, videoTrack } from "../src/index";
import { fromMlt } from "../src/ir/parse";
import type { Timeline } from "../src/ir/types";

const URI = "file:///doc.mlt";

/** Parse the committed multitrack corpus into IR — a real, clean document the
 *  seeded tasks edit. */
async function corpus(): Promise<Timeline> {
  // Read via Node fs (vitest host has no Bun global).
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const xml = readFileSync(
    resolve(import.meta.dirname, "..", "corpus", "vean-multitrack.mlt"),
    "utf8",
  );
  return fromMlt(xml);
}

describe("apply-op (mutate) — the compact ToolResult contract", () => {
  it("returns consequences + inverse + touchedUris + a COMPACT health (no full dump)", async () => {
    const state = await corpus();
    const { outcome, newState } = mutate(
      state,
      { op: "gain", args: { uuid: "clip-5", db: -6 } },
      URI,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The four required fields are present.
    expect(outcome.consequences).toBeDefined();
    expect(outcome.inverse).toBeDefined();
    expect(outcome.touchedUris).toEqual([URI]);
    expect(outcome.health).toBeDefined();

    // The health is COMPACT: counts + a (here empty) new/blocking list, and
    // CRUCIALLY no `diagnostics` array (the full-set dump the contract forbids).
    expect(outcome.health).toMatchObject({ errors: 0, warnings: 0, clean: true });
    expect(outcome.health.newOrBlocking).toEqual([]);
    expect(outcome.health).not.toHaveProperty("diagnostics");

    // The edit produced a serializable state (the op's purity + serializer
    // contract — a tool never writes an unserializable timeline).
    expect(newState).toBeDefined();
    expect(() => serializeDoc(newState as Timeline)).not.toThrow();
  });

  it("the inverse undoes the edit (round-trip to the original IR)", async () => {
    const state = await corpus();
    const fwd = mutate(state, { op: "gain", args: { uuid: "clip-5", db: -6 } }, URI);
    expect(fwd.outcome.ok).toBe(true);
    if (!fwd.outcome.ok || !fwd.newState) return;
    const back = mutate(fwd.newState, fwd.outcome.inverse, URI);
    expect(back.outcome.ok).toBe(true);
    if (!back.outcome.ok || !back.newState) return;
    // apply(inverse) deep-equals the original (the edit-algebra undo law, surfaced
    // through the tool).
    expect(back.newState).toEqual(state);
  });

  it("a BLOCKING error in the document is surfaced in health.newOrBlocking after an unrelated edit (but the FULL set is never dumped)", () => {
    // A document that ALREADY carries an error: a clip window past its source
    // length. (A public op refuses to CREATE this state — the edit algebra guards
    // against writing an out-of-bounds window, returning a typed EditError instead;
    // that is correct op hygiene. So we hand-build the pre-broken IR the LSP/MCP
    // might hold mid-edit, exactly as tests/diagnostics-checks.test.ts does.) An
    // unrelated edit (gain on a DIFFERENT, audio clip) must still surface the
    // blocking error in the compact summary — the agent sees the adverse effect
    // ambiently, without a diagnose call.
    const tl: Timeline = {
      profile: VERTICAL,
      tracks: {
        video: [
          {
            kind: "video",
            id: "v1",
            items: [
              {
                kind: "clip",
                id: "bad",
                resource: "/a.mp4",
                in: 0,
                out: 200,
                length: 100,
                filters: [],
              },
            ],
          },
        ],
        audio: [
          {
            kind: "audio",
            id: "a1",
            hidden: true,
            items: [{ kind: "clip", id: "snd", resource: "/x.wav", in: 0, out: 50, filters: [] }],
          },
        ],
      },
      transitions: [],
      title: "pre-broken",
    };
    // Baseline (via the debug verb) already shows the error.
    expect(diagnoseTool(tl).health.clean).toBe(false);
    // Apply an unrelated edit: duck the audio clip.
    const { outcome } = mutate(tl, { op: "gain", args: { uuid: "snd", db: -6 } }, URI);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The blocking error is surfaced in the compact list — the agent sees it
    // without a diagnose call.
    expect(outcome.health.errors).toBeGreaterThanOrEqual(1);
    const codes = outcome.health.newOrBlocking.map((d) => d.code);
    expect(codes).toContain("in-out-beyond-source");
    // The compact list is SMALL (just the blocking news), not the full set — and
    // carries no `diagnostics` full-dump field.
    expect(outcome.health.newOrBlocking.length).toBeLessThanOrEqual(3);
    expect(outcome.health).not.toHaveProperty("diagnostics");
  });

  it("a pre-existing WARNING (non-blocking, untouched) is summarized in counts but NOT dumped into newOrBlocking", () => {
    // A document with a WARNING (a keyframe animation entirely past the played
    // window → a dead-clamp warning) but no error. An unrelated edit must NOT pull
    // that pre-existing warning into the compact detail list (it's ambient context
    // the LSP already showed, not news) — only its COUNT is reported.
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "warn",
            dur: 50,
            filters: [filter("brightness", { level: "100=0;200=1" })],
          }),
          clip("/b.mp4", { id: "other", dur: 40, length: 200 }),
        ),
      ],
    });
    // Baseline: a warning, no error.
    const base = diagnoseTool(tl);
    expect(base.health.errors).toBe(0);
    expect(base.health.warnings).toBeGreaterThanOrEqual(1);
    // Edit the OTHER clip (gain) — leaves the warning clip untouched.
    const { outcome } = mutate(tl, { op: "trimIn", args: { uuid: "other", delta: 5 } }, URI);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The warning is COUNTED but not in the detail list (untouched + non-blocking).
    expect(outcome.health.warnings).toBeGreaterThanOrEqual(1);
    expect(outcome.health.newOrBlocking.map((d) => d.code)).not.toContain("keyframe-outside-clip");
  });

  it("a precondition failure is a typed ToolError value (no throw)", async () => {
    const state = await corpus();
    const { outcome } = mutate(state, { op: "gain", args: { uuid: "ghost", db: 0 } }, URI);
    expect(isToolError(outcome)).toBe(true);
    if (!isToolError(outcome)) return;
    expect(outcome.kind).toBe("clip-not-found");
    expect(outcome.detail).toMatch(/ghost/);
  });

  it("invalid op args fail as a typed ToolError, not a thrown ZodError", async () => {
    const state = await corpus();
    const { outcome } = mutate(state, { op: "gain", args: { uuid: "clip-5" } }, URI);
    expect(isToolError(outcome)).toBe(true);
    if (!isToolError(outcome)) return;
    expect(outcome.kind).toBe("invalid-args");
  });
});

describe("preview-op — same report, document unchanged", () => {
  it("returns the consequences + health a hypothetical edit WOULD produce", async () => {
    const state = await corpus();
    const before = serializeDoc(state);
    const outcome = preview(state, { op: "gain", args: { uuid: "clip-5", db: -6 } }, URI);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.consequences).toBeDefined();
    expect(outcome.inverse).toBeDefined();
    // The input state is untouched (preview discards the new state).
    expect(serializeDoc(state)).toBe(before);
  });
});

describe("diagnose tool — the ONE verb allowed the full set", () => {
  it("returns the full diagnostic set + health (the deliberate debug verb)", async () => {
    const state = await corpus();
    const out = diagnoseTool(state);
    // It DOES carry the full array — that's its job, and why it's separate from the
    // mutating tools (which must not).
    expect(Array.isArray(out.diagnostics)).toBe(true);
    expect(out.health.clean).toBe(true);
  });
});

describe("seeded editing tasks — the op→clean-state legs (render leg is move2:e2e)", () => {
  it("Task 1 — trimIn tightens a clip and stays clean + serializable", async () => {
    const state = await corpus();
    const { outcome, newState } = mutate(
      state,
      { op: "trimIn", args: { uuid: "clip-3", delta: 10 } },
      URI,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !newState) return;
    expect(outcome.health.clean).toBe(true);
    expect(outcome.consequences.clipsTrimmed.length).toBeGreaterThanOrEqual(1);
    expect(() => fromMlt(serializeDoc(newState))).not.toThrow(); // round-trips
  });

  it("Task 2 — gain ducks an audio clip and stays clean + serializable", async () => {
    const state = await corpus();
    const { outcome, newState } = mutate(
      state,
      { op: "gain", args: { uuid: "clip-5", db: -6 } },
      URI,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !newState) return;
    expect(outcome.health.clean).toBe(true);
    expect(() => fromMlt(serializeDoc(newState))).not.toThrow();
  });

  it("Task 3 — a file-clip split tightens to two clips, stays clean + serializable", () => {
    resetIds();
    // A finite file source long enough for both halves to stay in-bounds.
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/scene.mp4", { id: "a", in: 0, out: 79, length: 200 }))],
    });
    // Split clip "a" at its mid-point — a structural edit that always serializes.
    const { outcome, newState } = mutate(tl, { op: "split", args: { uuid: "a", frame: 40 } }, URI);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !newState) return;
    expect(outcome.health.clean).toBe(true);
    expect(outcome.consequences.clipsAdded.length).toBe(1); // the new head half
    expect(() => fromMlt(serializeDoc(newState))).not.toThrow();
  });

  it("Task 4 — a COLOR-clip split is now clean (the split-color inconsistency was FIXED at the edit algebra)", () => {
    // REGRESSION GUARD for a cross-surface defect the bridge surfaced while it was
    // being built: splitting a COLOR clip used to leave the tail half with a
    // re-based `length` (its own played count) but an UN-rebased `out`, so the
    // diagnostics engine's in-out-beyond-source rule fired (out ≥ length) on a
    // perfectly valid edit — a latent inconsistency between the split op and the
    // diagnostics engine. The Move-2 bridge EXPOSED it (ambient feedback doing its
    // job); the fix landed at root cause in the EDIT ALGEBRA
    // (`splitEntryAt` now re-bases a color half's window to 0-based, which is the
    // canonical/serialized form for a positionless generator), verified byte-stable
    // on round-trip + the full Move-1 op-invariants gate green. A color-clip split
    // is now diagnostic-clean.
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "black", { id: "a" }), colorClip(60, "gold", { id: "b" }))],
    });
    const { outcome, newState } = mutate(tl, { op: "split", args: { uuid: "a", frame: 30 } }, URI);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || !newState) return;
    expect(outcome.health.clean).toBe(true);
    expect(outcome.health.newOrBlocking).toEqual([]);
    // And it still serializes + round-trips.
    expect(() => fromMlt(serializeDoc(newState))).not.toThrow();
  });

  it("Task 5 — a trim's inverse undoes the edit ACROSS PERSIST (serialize→reparse→undo, the real MCP undo path)", async () => {
    // REGRESSION GUARD for the cross-surface defect the criteria-verification
    // surfaced: the existing undo test (above) feeds `gain`'s inverse to the
    // in-memory post-edit state and never serializes. But the MCP server PERSISTS
    // between apply-op and the undo tool (it writes the .mlt and reads it back),
    // and a trim on a COLOR clip re-bases its window to 0-based on serialize — so
    // the in-memory window (in=10) and the persisted window (in=0) differ, and a
    // scalar trim inverse that was correct in-memory used to UNDERFLOW after the
    // reparse (frame-out-of-range). The fix re-bases the color trim window 0-based
    // by playtime at the edit-algebra layer (mirrors the split-color fix), so the
    // inverse the tool returns is valid against the PERSISTED document too. Here we
    // drive the seeded trim (trimIn clip-3, a color clip) through the tool, persist
    // via the same serializeDoc the MCP server uses, reparse, then feed the
    // RETURNED inverse back through the tool — it must clear and restore the doc.
    const state = await corpus();
    const origXml = serializeDoc(state);
    const fwd = mutate(state, { op: "trimIn", args: { uuid: "clip-3", delta: 10 } }, URI);
    expect(fwd.outcome.ok).toBe(true);
    if (!fwd.outcome.ok || !fwd.newState) return;

    // Persist exactly as the server does: write (serialize) then read (reparse).
    const reparsed = fromMlt(serializeDoc(fwd.newState));

    // The undo tool applies the inverse to the PERSISTED state, not the in-memory one.
    const back = mutate(reparsed, fwd.outcome.inverse, URI);
    expect(back.outcome.ok).toBe(true); // used to be false: frame-out-of-range
    if (!back.outcome.ok || !back.newState) return;
    // And it restores the original document byte-for-byte.
    expect(serializeDoc(back.newState)).toBe(origXml);
  });
});
