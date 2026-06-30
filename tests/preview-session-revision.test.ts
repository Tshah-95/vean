// Stable unit test for the session REVISION counter — the live-preview "HMR"
// trigger (DESIGN-LIVE-PREVIEW §3 step 0, §4). `SessionEditResult` carries a
// monotonic `revision` that the browser compositor keys its recomposite on
// (`(currentFrame, revision)`), so a same-frame edit invalidates the cached frame
// even though the playhead did not move. This is the analog of OpenReel's
// `project.modifiedAt` / OpenCut's `renderTree` identity.
//
// What it pins:
//   • a freshly loaded session starts at revision 0 (the un-edited state);
//   • EVERY successful op/undo/redo bumps it by exactly 1, strictly monotonic;
//   • a FAILED op (typed EditError) leaves the revision untouched (no state change
//     ⇒ nothing to recomposite);
//   • a FAILED undo/redo on an empty stack leaves the revision untouched.
//
// It drives the session module DIRECTLY against an in-memory `.mlt` (no server, no
// `bun:sqlite`, no disk), so it runs under vitest's Node host alongside the other
// pure-core gates. The session deps (bridge tool core → ops → diagnostics → ir)
// pull no Bun-only modules, so this needs no probe subprocess.
import { describe, expect, it } from "vitest";
import { serializeDoc } from "../src/bridge/tools/core";
import { VERTICAL, clip, resetIds, timeline, videoTrack } from "../src/index";
import type { Timeline } from "../src/ir/types";
import { SessionStore, applyOp, redoSession, undoSession } from "../src/preview/session";

const URI = "file:///revision.mlt";

/** A small, clean single-track timeline whose clips are long enough that an
 *  in-bounds trim/split stays valid (so the op succeeds). */
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

/** Load a session whose on-disk `.mlt` is the serialized `cleanDoc`. The loader is
 *  a stub (the bytes come from the in-memory IR), so this touches no filesystem. */
function loadSession() {
  const xml = serializeDoc(cleanDoc());
  const store = new SessionStore();
  return store.get(URI, () => xml);
}

describe("session revision — the live-preview HMR trigger", () => {
  it("starts at 0 on a freshly loaded, un-edited session", () => {
    const session = loadSession();
    expect(session.revision).toBe(0);
  });

  it("increments by exactly 1 on every successful op", () => {
    const session = loadSession();

    const first = applyOp(session, { op: "trimIn", args: { uuid: "a", delta: 10 } });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.revision).toBe(1);
    expect(session.revision).toBe(1);

    const second = applyOp(session, { op: "trimIn", args: { uuid: "a", delta: 5 } });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.revision).toBe(2);

    // Strictly monotonic across the two edits.
    expect(second.revision).toBeGreaterThan(first.revision);
  });

  it("bumps the revision on undo and redo (every history move is a recomposite)", () => {
    const session = loadSession();

    const applied = applyOp(session, { op: "trimIn", args: { uuid: "a", delta: 10 } });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.revision).toBe(1);

    // Undo is itself a state change the compositor must repaint → the revision
    // advances, it does NOT roll back to the pre-edit value.
    const undone = undoSession(session);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.revision).toBe(2);

    const redone = redoSession(session);
    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect(redone.revision).toBe(3);

    // Monotonic non-decreasing across apply → undo → redo.
    expect(redone.revision).toBeGreaterThan(undone.revision);
    expect(undone.revision).toBeGreaterThan(applied.revision);
  });

  it("does NOT bump the revision when an op fails (no state change to repaint)", () => {
    const session = loadSession();

    const ok = applyOp(session, { op: "trimIn", args: { uuid: "a", delta: 10 } });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(session.revision).toBe(1);

    // A trim against a non-existent clip is a typed EditError: no state change.
    const failed = applyOp(session, { op: "trimIn", args: { uuid: "does-not-exist", delta: 5 } });
    expect(failed.ok).toBe(false);
    // The failed op left the revision exactly where the last success put it.
    expect(session.revision).toBe(1);
  });

  it("does NOT bump the revision when undo/redo find an empty stack", () => {
    const session = loadSession();
    expect(session.revision).toBe(0);

    const undo = undoSession(session);
    expect(undo.ok).toBe(false);
    expect(session.revision).toBe(0);

    const redo = redoSession(session);
    expect(redo.ok).toBe(false);
    expect(session.revision).toBe(0);
  });
});
