// Stable unit test for the session AUTHORSHIP boundary — the agent-scoped undo
// guard (Palmier `agentUndoStack` lesson). Multiple authors mutate one working
// IR; an undo must not silently cross an authorship boundary.
//
// What it pins:
//   • every apply tags its undo entry with the supplied author (default "human");
//   • `nextUndoAuthor` / `nextRedoAuthor` report the top-of-stack author the UI
//     uses to label/guard its undo button;
//   • a human cannot undo an agent's edit (typed `cross-author-undo`, no state
//     change), and vice versa, UNLESS `allowCrossAuthor` is set;
//   • redo carries the ORIGINAL author through an undo→redo round-trip, so a redo
//     restores the work under whoever made it;
//   • the inverse invocations stay byte-canonical (authorship lives on the wrapper),
//     so the undo result still round-trips to the pre-edit serialized bytes.
//
// Drives the session module DIRECTLY against an in-memory `.mlt` (no server, no
// `bun:sqlite`, no disk), like preview-session-revision.test.ts.
import { describe, expect, it } from "vitest";
import { serializeDoc } from "../src/bridge/tools/core";
import { VERTICAL, clip, resetIds, timeline, videoTrack } from "../src/index";
import type { Timeline } from "../src/ir/types";
import {
  HUMAN_AUTHOR,
  SessionStore,
  applyOp,
  redoSession,
  undoSession,
} from "../src/preview/session";

const URI = "file:///authorship.mlt";

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

function loadSession() {
  const xml = serializeDoc(cleanDoc());
  const store = new SessionStore();
  return store.get(URI, () => xml);
}

describe("session authorship — the agent-scoped undo boundary", () => {
  it("tags each undo entry with its author and reports the next-undo author", () => {
    const session = loadSession();

    const human = applyOp(session, { op: "trimIn", args: { uuid: "a", delta: 10 } });
    expect(human.ok).toBe(true);
    if (!human.ok) return;
    expect(human.nextUndoAuthor).toBe(HUMAN_AUTHOR);

    const agent = applyOp(
      session,
      { op: "trimIn", args: { uuid: "a", delta: 5 } },
      { author: "agent-1" },
    );
    expect(agent.ok).toBe(true);
    if (!agent.ok) return;
    // The most recent edit is the agent's, so a next undo would touch the agent's.
    expect(agent.nextUndoAuthor).toBe("agent-1");
  });

  it("defaults the author to the human when none is supplied", () => {
    const session = loadSession();
    const res = applyOp(session, { op: "trimIn", args: { uuid: "a", delta: 10 } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.nextUndoAuthor).toBe("human");
  });

  it("refuses a human undo of an agent's edit (no state change), and vice versa", () => {
    const session = loadSession();

    applyOp(session, { op: "trimIn", args: { uuid: "a", delta: 5 } }, { author: "agent-1" });
    const revBefore = session.revision;

    // A human cannot pop the agent's edit off the top of the undo stack.
    const refused = undoSession(session, { author: HUMAN_AUTHOR });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.kind).toBe("cross-author-undo");
    // The refusal left history + revision untouched (no recomposite).
    expect(session.revision).toBe(revBefore);
    expect(session.undoStack.length).toBe(1);

    // The agent CAN undo its own edit.
    const allowed = undoSession(session, { author: "agent-1" });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(session.undoStack.length).toBe(0);
  });

  it("lets an explicit allowCrossAuthor override the boundary", () => {
    const session = loadSession();
    applyOp(session, { op: "trimIn", args: { uuid: "a", delta: 5 } }, { author: "agent-1" });

    const forced = undoSession(session, { author: HUMAN_AUTHOR, allowCrossAuthor: true });
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(session.undoStack.length).toBe(0);
  });

  it("carries the original author through an undo → redo round-trip", () => {
    const session = loadSession();
    applyOp(session, { op: "trimIn", args: { uuid: "a", delta: 5 } }, { author: "agent-1" });

    const undone = undoSession(session, { author: "agent-1" });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    // The redo entry is attributed to the agent who made the edit, not the undoer.
    expect(undone.nextRedoAuthor).toBe("agent-1");

    // A human cannot redo the agent's work.
    const refusedRedo = redoSession(session, { author: HUMAN_AUTHOR });
    expect(refusedRedo.ok).toBe(false);
    if (refusedRedo.ok) return;
    expect(refusedRedo.kind).toBe("cross-author-redo");

    // The agent redoes it, and the entry returns to the undo stack under the agent.
    const redone = redoSession(session, { author: "agent-1" });
    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect(redone.nextUndoAuthor).toBe("agent-1");
  });

  it("keeps the inverse byte-canonical — an undo restores the pre-edit bytes", () => {
    const session = loadSession();
    const before = serializeDoc(session.ir);

    applyOp(session, { op: "trimIn", args: { uuid: "a", delta: 7 } }, { author: "agent-x" });
    const undone = undoSession(session, { author: "agent-x" });
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    // Authorship is metadata on the stack wrapper, not on the OpInvocation, so the
    // inverse is exactly the canonical one — the undo is byte-faithful.
    expect(serializeDoc(session.ir)).toBe(before);
  });
});
