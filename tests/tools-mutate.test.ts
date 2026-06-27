// The MUTATING-TOOL CORE gate (Move 2) — the unit test for `src/bridge/tools/mutate`,
// the dedicated home of `apply-op` / `preview-op` / `undo` and the tool-output
// discipline they enforce (AGENTS.md "Agent feedback contract", BUILD-MONITOR
// review lens #3, the escalation trigger "tool responses include full diagnostic
// dumps by default").
//
// It drives the TRANSPORT-FREE mutating tools directly (no MCP server, no stdio, no
// file I/O — those are the binding's job and tested separately), so it isolates the
// contract from the wiring. What it proves, per the contract:
//
//   • `mutate` (apply-op) returns consequences + inverse + touchedUris + a COMPACT
//     `health` — counts + ONLY the new/blocking details — and NO full-set dump
//     (`health` has no `diagnostics` key);
//   • a NEW defect an edit introduces appears in `health.newOrBlocking`, while a
//     pre-existing, untouched WARNING is COUNTED but not dumped (it's ambient
//     context the LSP already showed, not news);
//   • `preview` returns the same report but mutates NOTHING (state in === state out);
//   • `undoTool` re-applies an inverse and round-trips to the original IR;
//   • `healthDelta` keys diagnostics by STABLE identity (code + clip uuid / track /
//     transition), so the new-vs-existing diff survives reordering — never by index;
//   • a precondition failure is a typed ToolError VALUE, not a throw.
//
// These run on the PURE core, so they execute under vitest's Node host (no Bun, no
// melt). The render→still leg is the separate `bun run move2:e2e` gate.
import { describe, expect, it } from "vitest";
import { serializeDoc } from "../src/bridge/tools/core";
import { healthDelta, mutate, preview, undoTool } from "../src/bridge/tools/mutate";
import { isToolError } from "../src/bridge/tools/types";
import type { Diagnostic } from "../src/diagnostics";
import { VERTICAL, clip, colorClip, filter, resetIds, timeline, videoTrack } from "../src/index";
import { fromMlt } from "../src/ir/parse";
import type { Timeline } from "../src/ir/types";

const URI = "file:///mutate.mlt";

/** A small, clean two-clip video timeline the mutating tools edit. `a` is a finite
 *  file source long enough that an in-bounds trim/split stays valid. */
function cleanDoc(): Timeline {
  resetIds();
  return timeline(VERTICAL, {
    video: [
      videoTrack(
        clip("/a.mp4", { id: "a", in: 0, out: 99, length: 200 }),
        clip("/b.mp4", { id: "b", in: 0, out: 59, length: 200 }),
      ),
    ],
  });
}

describe("mutate (apply-op) — the compact ToolResult contract", () => {
  it("returns consequences + inverse + touchedUris + a COMPACT health (no full dump)", () => {
    const state = cleanDoc();
    const { outcome, newState } = mutate(
      state,
      { op: "trimIn", args: { uuid: "a", delta: 10 } },
      URI,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The four required fields are present.
    expect(outcome.consequences).toBeDefined();
    expect(outcome.inverse).toBeDefined();
    expect(outcome.touchedUris).toEqual([URI]);
    expect(outcome.health).toBeDefined();

    // The health is COMPACT: counts + an (here empty) new/blocking list, and
    // CRUCIALLY no `diagnostics` array (the full-set dump the contract forbids).
    expect(outcome.health).toMatchObject({ errors: 0, warnings: 0, clean: true });
    expect(outcome.health.newOrBlocking).toEqual([]);
    expect(outcome.health).not.toHaveProperty("diagnostics");

    // The edit produced a serializable state (a tool never writes an unserializable
    // timeline — the op-purity + serializer contract).
    expect(newState).toBeDefined();
    expect(() => serializeDoc(newState as Timeline)).not.toThrow();
  });

  it("a BLOCKING error already in the document is surfaced after an UNRELATED edit (but the full set is never dumped)", () => {
    // A document that ALREADY carries an error: a clip window past its source
    // length. (A public op refuses to CREATE this — the edit algebra guards against
    // an out-of-bounds window — so we hand-build the pre-broken IR the LSP/MCP might
    // hold mid-edit.) An unrelated edit must still surface the blocking error in the
    // compact summary — the agent sees the adverse effect without a diagnose call.
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
              {
                kind: "clip",
                id: "ok",
                resource: "/b.mp4",
                in: 0,
                out: 40,
                length: 200,
                filters: [],
              },
            ],
          },
        ],
        audio: [],
      },
      transitions: [],
      title: "pre-broken",
    };
    const { outcome } = mutate(tl, { op: "trimIn", args: { uuid: "ok", delta: 5 } }, URI);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The blocking error is surfaced in the compact list (the agent sees it without
    // a diagnose call), and the list is SMALL — just the blocking news, not the full
    // set — with no `diagnostics` full-dump field.
    expect(outcome.health.errors).toBeGreaterThanOrEqual(1);
    expect(outcome.health.newOrBlocking.map((d) => d.code)).toContain("in-out-beyond-source");
    expect(outcome.health.newOrBlocking.length).toBeLessThanOrEqual(3);
    expect(outcome.health).not.toHaveProperty("diagnostics");
  });

  it("a pre-existing WARNING (untouched) is COUNTED but NOT pulled into newOrBlocking", () => {
    // A document with a WARNING (a keyframe animation entirely past the played
    // window → a dead-clamp warning) but no error. An unrelated edit must NOT pull
    // that pre-existing warning into the compact detail list — only its COUNT.
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
    const { outcome } = mutate(tl, { op: "trimIn", args: { uuid: "other", delta: 5 } }, URI);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.health.warnings).toBeGreaterThanOrEqual(1);
    expect(outcome.health.newOrBlocking.map((d) => d.code)).not.toContain("keyframe-outside-clip");
  });

  it("a precondition failure is a typed ToolError value (no throw)", () => {
    const state = cleanDoc();
    const { outcome, newState } = mutate(
      state,
      { op: "gain", args: { uuid: "ghost", db: 0 } },
      URI,
    );
    expect(isToolError(outcome)).toBe(true);
    if (!isToolError(outcome)) return;
    expect(outcome.kind).toBe("clip-not-found");
    expect(outcome.detail).toMatch(/ghost/);
    // No state advanced on a failed precondition.
    expect(newState).toBeUndefined();
  });

  it("malformed op args fail as a typed `invalid-args` ToolError, not a thrown ZodError", () => {
    const state = cleanDoc();
    const { outcome } = mutate(state, { op: "gain", args: { uuid: "a" } }, URI);
    expect(isToolError(outcome)).toBe(true);
    if (!isToolError(outcome)) return;
    expect(outcome.kind).toBe("invalid-args");
  });
});

describe("preview (preview-op) — same report, document unchanged", () => {
  it("returns the consequences + inverse + health a hypothetical edit WOULD produce, mutating nothing", () => {
    const state = cleanDoc();
    const before = serializeDoc(state);
    const outcome = preview(state, { op: "trimIn", args: { uuid: "a", delta: 10 } }, URI);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.consequences).toBeDefined();
    expect(outcome.inverse).toBeDefined();
    expect(outcome.health).not.toHaveProperty("diagnostics");
    // The input state is byte-identical afterward (preview discards the new state).
    expect(serializeDoc(state)).toBe(before);
  });

  it("a failing preview returns the typed ToolError WITHOUT mutating the input", () => {
    const state = cleanDoc();
    const before = serializeDoc(state);
    const outcome = preview(state, { op: "gain", args: { uuid: "ghost", db: 0 } }, URI);
    expect(isToolError(outcome)).toBe(true);
    expect(serializeDoc(state)).toBe(before);
  });
});

describe("undoTool (undo) — re-apply an inverse, round-trip to the original", () => {
  it("the inverse undoes the edit (round-trip to the original IR)", () => {
    const state = cleanDoc();
    const fwd = mutate(state, { op: "trimIn", args: { uuid: "a", delta: 10 } }, URI);
    expect(fwd.outcome.ok).toBe(true);
    if (!fwd.outcome.ok || !fwd.newState) return;
    // Feed the forward result's inverse to the dedicated `undo` tool.
    const back = undoTool(fwd.newState, fwd.outcome.inverse, URI);
    expect(back.outcome.ok).toBe(true);
    if (!back.outcome.ok || !back.newState) return;
    // undo deep-equals the original (the edit-algebra undo law, surfaced through the
    // tool), and it returns the SAME compact contract (so an agent can redo it).
    expect(back.newState).toEqual(state);
    expect(back.outcome.touchedUris).toEqual([URI]);
    expect(back.outcome.health).not.toHaveProperty("diagnostics");
    expect(back.outcome.inverse).toBeDefined(); // undo's own inverse = the redo
  });

  it("undo of a COLOR-clip split is clean (the split-color rebase fix, surfaced through undo)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "black", { id: "a" }), colorClip(60, "gold", { id: "b" }))],
    });
    const fwd = mutate(tl, { op: "split", args: { uuid: "a", frame: 30 } }, URI);
    expect(fwd.outcome.ok).toBe(true);
    if (!fwd.outcome.ok || !fwd.newState) return;
    expect(fwd.outcome.health.clean).toBe(true);
    const back = undoTool(fwd.newState, fwd.outcome.inverse, URI);
    expect(back.outcome.ok).toBe(true);
    if (!back.outcome.ok || !back.newState) return;
    expect(back.newState).toEqual(tl);
  });
});

describe("healthDelta — the compact new-vs-existing diff (stable-identity keyed)", () => {
  /** Build a minimal Diagnostic for the diff. */
  function diag(code: string, severity: Diagnostic["severity"], clip: string): Diagnostic {
    return { code, severity, message: `${code} on ${clip}`, location: { clip }, source: "test" };
  }

  it("a key present AFTER but not BEFORE is NEW (introduced by the edit)", () => {
    const before = [diag("warn-x", "warning", "c1")];
    const after = [diag("warn-x", "warning", "c1"), diag("err-y", "error", "c2")];
    const h = healthDelta(before, after);
    expect(h.errors).toBe(1);
    expect(h.warnings).toBe(1);
    expect(h.clean).toBe(false);
    // The new error is in the detail list; the pre-existing untouched warning is NOT.
    expect(h.newOrBlocking.map((d) => d.code)).toEqual(["err-y"]);
  });

  it("a pre-existing ERROR is BLOCKING (surfaced even though it isn't new)", () => {
    const before = [diag("err-y", "error", "c2")];
    const after = [diag("err-y", "error", "c2")];
    const h = healthDelta(before, after);
    // Not new (key unchanged) but an error → blocking → surfaced anyway.
    expect(h.newOrBlocking.map((d) => d.code)).toEqual(["err-y"]);
    expect(h.errors).toBe(1);
  });

  it("identity is keyed by STABLE location, not array index (a reorder is not a 'new' diagnostic)", () => {
    const a = diag("err-y", "error", "cA");
    const b = diag("err-y", "error", "cB");
    // Same two diagnostics, different ORDER after the edit. Neither is new.
    const before = [a, b];
    const after = [b, a];
    const h = healthDelta(before, after);
    // Both errors counted (blocking), but de-duped to the two distinct stable keys —
    // a reorder introduced nothing.
    expect(h.errors).toBe(2);
    expect(h.newOrBlocking.map((d) => d.location.clip).sort()).toEqual(["cA", "cB"]);
  });

  it("a clean post-edit set yields an empty detail list and clean=true", () => {
    const h = healthDelta([], []);
    expect(h).toMatchObject({ errors: 0, warnings: 0, clean: true });
    expect(h.newOrBlocking).toEqual([]);
  });
});
