// The preview SESSION model — the in-memory write-back / undo / redo / save loop
// behind the viewer's edit surface. The preview server (`./server.ts`) is a
// 127.0.0.1 local coordinator (like the future Tauri IPC); this module gives it a
// short-lived working copy of a timeline that the GUI mutates interactively WITHOUT
// touching disk until an explicit save.
//
// It owns NO domain logic. Every mutation routes through the SAME shared-core path
// the action runtime's `timeline.applyOp` uses — the bridge `mutate`/`undoTool`
// helpers, which call the edit algebra (`src/ops`, the only mutation path) and the
// diagnostics engine (`src/diagnostics`, the only rule source). Parse/serialize go
// through the bridge `parseDoc`/`serializeDoc` (deterministic `fromMlt`/`toMlt`),
// so a saved document is byte-identical to the golden output.
//
// The session is the missing piece the disk-based `timeline.applyOp` action does
// not have: an UNDO/REDO history. `timeline.applyOp` reads a file, applies one op,
// writes the file — stateless, no history. The viewer needs a live working IR plus
// undo/redo stacks. We layer that here on top of the same primitives rather than
// forking the mutation path.
//
//   • Working IR — held in memory per resolved timeline path, lazy-loaded from the
//     `.mlt` on first touch via `parseDoc(fromMlt)`.
//   • undo stack — the INVERSE invocation of each applied op (re-apply to undo).
//   • redo stack — the FORWARD invocation of each undone op (re-apply to redo).
//     A fresh apply CLEARS the redo stack (the standard editor history contract).
//
// Frame-exact throughout: the IR carries integer frames + rational fps; we never
// coerce a float. Determinism is preserved because the inverse of a randomness-
// minting op captures its minted ids (op contract law #3), so undo is exact.
import { mutate, parseDoc, serializeDoc, undoTool } from "../bridge/tools/core";
import { isToolError } from "../bridge/tools/types";
import type { ToolOutcome } from "../bridge/tools/types";
import { type Diagnostic, collectDiagnostics, summarize } from "../diagnostics";
import type { DiagnosticHealth } from "../diagnostics";
import type { Timeline } from "../ir/types";
import type { Consequences, OpInvocation } from "../ops";

/** One route's live working copy: the in-memory IR + the undo/redo history. The
 *  `uri` is the resolved `.mlt` path (the same string the action runtime + the
 *  diagnostics surface use as a document id). */
export type TimelineSession = {
  /** The resolved `.mlt` path this session was loaded from (the document id). */
  uri: string;
  /** The current in-memory IR. Mutated only by replacing the whole reference with
   *  the fresh state an op returns (ops are pure; we never mutate in place). */
  ir: Timeline;
  /** Inverse invocations, newest last. Pop to undo. */
  undoStack: OpInvocation[];
  /** Forward invocations of undone ops, newest last. Pop to redo. Cleared by a
   *  fresh apply. */
  redoStack: OpInvocation[];
  /** True once a mutation/undo/redo has diverged the working IR from the last
   *  saved (or loaded) on-disk content, so the UI can show an unsaved indicator. */
  dirty: boolean;
};

/** The successful payload an apply/undo/redo returns to the viewer. The full
 *  diagnostic set is included DELIBERATELY: the viewer is the local app GUI (it
 *  draws the timeline + its health from the IR), not an MCP agent, so it is the
 *  ambient-diagnostics consumer the way an LSP client is — the mutation-local
 *  `alerts` discipline is an MCP-tool concern, not a GUI one. */
export type SessionEditResult = {
  ok: true;
  /** The new working IR (the viewer re-renders the timeline from this). */
  ir: Timeline;
  /** The structured "what changed" report from the edit algebra. */
  consequences: Consequences;
  /** The FULL current diagnostic set for the new IR (LSP-style ambient set). */
  diagnostics: Diagnostic[];
  /** Compact counts + clean flag over `diagnostics`. */
  health: DiagnosticHealth;
  /** Undo/redo availability + dirty state, so the UI can enable/disable buttons. */
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
};

/** A typed failure (no state change). Mirrors the bridge `ToolError` shape plus the
 *  `ok:false` the viewer branches on. */
export type SessionEditError = {
  ok: false;
  /** The EditError kind (`clip-not-found`, `invalid-args`, …) or a session reason
   *  (`nothing-to-undo`, `nothing-to-redo`). */
  kind: string;
  detail: string;
};

export type SessionEditOutcome = SessionEditResult | SessionEditError;

/** Holds one `TimelineSession` per resolved timeline path. Keyed by the RESOLVED
 *  `.mlt` path (not the route alias) so two aliases pointing at the same file share
 *  one working copy and one history — the document, not the address, is the
 *  identity (the same principle as op identity being the stable uuid, not an
 *  ephemeral index). */
export class SessionStore {
  private readonly sessions = new Map<string, TimelineSession>();

  /** Get the live session for `uri`, lazy-loading + parsing the `.mlt` from disk on
   *  first touch via `loadXml`. `loadXml(uri)` returns the file text; the store
   *  owns the parse so the working IR comes from the same deterministic `fromMlt`
   *  path the rest of the engine uses. Throws only if the load/parse itself throws
   *  (a malformed document) — the server maps that to a typed 500. */
  get(uri: string, loadXml: (uri: string) => string): TimelineSession {
    const existing = this.sessions.get(uri);
    if (existing) return existing;
    const ir = parseDoc(loadXml(uri));
    const session: TimelineSession = {
      uri,
      ir,
      undoStack: [],
      redoStack: [],
      dirty: false,
    };
    this.sessions.set(uri, session);
    return session;
  }

  /** Peek a loaded session without loading (for a save of an untouched route). */
  peek(uri: string): TimelineSession | undefined {
    return this.sessions.get(uri);
  }

  /** Drop a session (e.g. after a successful save the caller may keep it; this is
   *  here for completeness / tests). */
  reset(uri: string): void {
    this.sessions.delete(uri);
  }
}

/** Build the success payload for the session's CURRENT IR (after an op/undo/redo).
 *  Runs the FULL diagnostics set once over the new IR. */
function editResult(session: TimelineSession, consequences: Consequences): SessionEditResult {
  const diagnostics = collectDiagnostics(session.ir);
  return {
    ok: true,
    ir: session.ir,
    consequences,
    diagnostics,
    health: summarize(diagnostics),
    canUndo: session.undoStack.length > 0,
    canRedo: session.redoStack.length > 0,
    dirty: session.dirty,
  };
}

/** Map a bridge `ToolOutcome` to a session outcome. On success, the caller has
 *  already advanced the session IR + history; we only need its `consequences` to
 *  build the payload. On failure, pass the typed error straight through. */
function fromToolOutcome(
  session: TimelineSession,
  outcome: ToolOutcome,
  consequences: Consequences,
): SessionEditOutcome {
  if (isToolError(outcome)) {
    return { ok: false, kind: outcome.kind, detail: outcome.detail };
  }
  return editResult(session, consequences);
}

/** apply-op — validate + apply `invocation` against the session's working IR via
 *  the shared mutating-tool path. On success: replace the working IR, push the
 *  returned INVERSE onto the undo stack, CLEAR the redo stack, mark dirty, and
 *  return the consequences + full diagnostics. On an `EditError` the IR + history
 *  are untouched and a typed error is returned (never a throw). Disk is NOT
 *  written here — that is `saveSession`. */
export function applyOp(session: TimelineSession, invocation: OpInvocation): SessionEditOutcome {
  const { outcome, newState } = mutate(session.ir, invocation, session.uri);
  if (isToolError(outcome) || !newState) {
    return fromToolOutcome(session, outcome, outcome as never);
  }
  session.ir = newState;
  session.undoStack.push(outcome.inverse);
  session.redoStack = [];
  session.dirty = true;
  return editResult(session, outcome.consequences);
}

/** undo — pop the top inverse off the undo stack and apply it. The inverse's OWN
 *  inverse (returned by applying it) is the FORWARD op that redoes the edit, which
 *  we push onto the redo stack. Stacks are swapped in spirit: undo feeds redo.
 *  Returns `nothing-to-undo` when the undo stack is empty. */
export function undoSession(session: TimelineSession): SessionEditOutcome {
  const inverse = session.undoStack.pop();
  if (!inverse) {
    return { ok: false, kind: "nothing-to-undo", detail: "undo stack is empty" };
  }
  const { outcome, newState } = undoTool(session.ir, inverse, session.uri);
  if (isToolError(outcome) || !newState) {
    // Re-applying the inverse failed — restore the stack so history is consistent.
    session.undoStack.push(inverse);
    return fromToolOutcome(session, outcome, outcome as never);
  }
  session.ir = newState;
  // The inverse-of-the-inverse is the forward op that redoes this edit.
  session.redoStack.push(outcome.inverse);
  session.dirty = true;
  return editResult(session, outcome.consequences);
}

/** redo — pop the top forward op off the redo stack and re-apply it. The op's
 *  inverse goes back onto the undo stack, restoring the pre-undo history shape.
 *  Returns `nothing-to-redo` when the redo stack is empty. */
export function redoSession(session: TimelineSession): SessionEditOutcome {
  const forward = session.redoStack.pop();
  if (!forward) {
    return { ok: false, kind: "nothing-to-redo", detail: "redo stack is empty" };
  }
  const { outcome, newState } = mutate(session.ir, forward, session.uri);
  if (isToolError(outcome) || !newState) {
    // Re-applying the forward op failed — restore the redo stack.
    session.redoStack.push(forward);
    return fromToolOutcome(session, outcome, outcome as never);
  }
  session.ir = newState;
  session.undoStack.push(outcome.inverse);
  session.dirty = true;
  return editResult(session, outcome.consequences);
}

/** save — serialize the session's working IR back to `targetPath` (the route's
 *  `.mlt`) via the deterministic `serializeDoc(toMlt)`, so the written bytes are
 *  byte-identical to the golden output. The caller (`./server.ts`) owns the file
 *  write; this returns the text + clears the dirty flag on success. Returns the
 *  serialized XML so the writer stays the single I/O point. */
export function serializeSession(session: TimelineSession): string {
  return serializeDoc(session.ir);
}

/** Mark a session clean after its bytes have been written to disk. */
export function markSaved(session: TimelineSession): void {
  session.dirty = false;
}
