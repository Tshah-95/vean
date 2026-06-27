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
//   • `mutate` (apply-op) returns consequences + inverse + touchedUris, with NO
//     standing health snapshot and NO full-set dump;
//   • a NEW ERROR an edit introduces appears in `alerts`; clean edits and
//     pre-existing diagnostics do not add noise to the tool response;
//   • `preview` returns the same report but mutates NOTHING (state in === state out);
//   • `undoTool` re-applies an inverse and round-trips to the original IR;
//   • `alertsDelta` keys diagnostics by STABLE identity (code + clip uuid / track /
//     transition), so the new-error diff survives reordering — never by index;
//   • a precondition failure is a typed ToolError VALUE, not a throw.
//
// These run on the PURE core, so they execute under vitest's Node host (no Bun, no
// melt). The render→still leg is the separate `bun run move2:e2e` gate.
import { describe, expect, it } from "vitest";
import { serializeDoc } from "../src/bridge/tools/core";
import { alertsDelta, mutate, preview, undoTool } from "../src/bridge/tools/mutate";
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

describe("mutate (apply-op) — the focused ToolResult contract", () => {
  it("returns consequences + inverse + touchedUris, with no standing health snapshot", () => {
    const state = cleanDoc();
    const { outcome, newState } = mutate(
      state,
      { op: "trimIn", args: { uuid: "a", delta: 10 } },
      URI,
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The required fields are present.
    expect(outcome.consequences).toBeDefined();
    expect(outcome.inverse).toBeDefined();
    expect(outcome.touchedUris).toEqual([URI]);

    // Clean edits do not carry a standing health object or empty alerts.
    expect(outcome).not.toHaveProperty("health");
    expect(outcome).not.toHaveProperty("diagnostics");
    expect(outcome.alerts).toBeUndefined();

    // The edit produced a serializable state (a tool never writes an unserializable
    // timeline — the op-purity + serializer contract).
    expect(newState).toBeDefined();
    expect(() => serializeDoc(newState as Timeline)).not.toThrow();
  });

  it("a pre-existing blocking error is NOT repeated after an unrelated edit", () => {
    // A document that ALREADY carries an error. An unrelated edit must not repeat
    // the standing problem in a mutating tool reply; the LSP/diagnose surfaces own
    // the current document health.
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
    expect(outcome.alerts).toBeUndefined();
    expect(outcome).not.toHaveProperty("health");
    expect(outcome).not.toHaveProperty("diagnostics");
  });

  it("a pre-existing WARNING (untouched) is not included in alerts", () => {
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
    expect(outcome.alerts).toBeUndefined();
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
  it("returns the consequences + inverse + optional alerts a hypothetical edit WOULD produce, mutating nothing", () => {
    const state = cleanDoc();
    const before = serializeDoc(state);
    const outcome = preview(state, { op: "trimIn", args: { uuid: "a", delta: 10 } }, URI);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.consequences).toBeDefined();
    expect(outcome.inverse).toBeDefined();
    expect(outcome).not.toHaveProperty("health");
    expect(outcome).not.toHaveProperty("diagnostics");
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
    expect(back.outcome).not.toHaveProperty("health");
    expect(back.outcome).not.toHaveProperty("diagnostics");
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
    expect(fwd.outcome.alerts).toBeUndefined();
    const back = undoTool(fwd.newState, fwd.outcome.inverse, URI);
    expect(back.outcome.ok).toBe(true);
    if (!back.outcome.ok || !back.newState) return;
    expect(back.newState).toEqual(tl);
  });
});

describe("alertsDelta — new blocking errors only (stable-identity keyed)", () => {
  /** Build a minimal Diagnostic for the diff. */
  function diag(code: string, severity: Diagnostic["severity"], clip: string): Diagnostic {
    return { code, severity, message: `${code} on ${clip}`, location: { clip }, source: "test" };
  }

  it("a key present AFTER but not BEFORE is NEW (introduced by the edit)", () => {
    const before = [diag("warn-x", "warning", "c1")];
    const after = [diag("warn-x", "warning", "c1"), diag("err-y", "error", "c2")];
    const alerts = alertsDelta(before, after);
    expect(alerts.map((d) => d.code)).toEqual(["err-y"]);
  });

  it("a pre-existing ERROR is not repeated", () => {
    const before = [diag("err-y", "error", "c2")];
    const after = [diag("err-y", "error", "c2")];
    expect(alertsDelta(before, after)).toEqual([]);
  });

  it("identity is keyed by STABLE location, not array index (a reorder is not a 'new' diagnostic)", () => {
    const a = diag("err-y", "error", "cA");
    const b = diag("err-y", "error", "cB");
    // Same two diagnostics, different ORDER after the edit. Neither is new.
    const before = [a, b];
    const after = [b, a];
    expect(alertsDelta(before, after)).toEqual([]);
  });

  it("warnings introduced by an edit are not mutation alerts", () => {
    expect(alertsDelta([], [diag("warn-x", "warning", "c1")])).toEqual([]);
  });

  it("a clean post-edit set yields an empty alert list", () => {
    expect(alertsDelta([], [])).toEqual([]);
  });
});
