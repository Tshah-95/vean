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

// ─── Authorship (the agent-scoped undo boundary) ─────────────────────────────
// Multiple authors mutate ONE working IR: the human at the GUI, and one or more
// agent sessions driving the same document through the bridge. A single LIFO undo
// stack shared across them is a footgun (the Palmier `agentUndoStack` lesson): a
// human's Cmd+Z would silently revert an agent's last edit, and an agent's `undo`
// would revert the human's — neither author can reason about what their own undo
// does. The fix is the same one Palmier reached for after the fact: tag every
// applied op with WHO applied it, and refuse an undo/redo that would cross an
// authorship boundary unless the caller explicitly opts in.
//
// This is metadata ALONGSIDE the history, never inside it. The `OpInvocation`
// inverse stays canonical and untouched (op contract law: the inverse is exactly
// what `apply` needs to undo the forward op) — authorship lives on the stack
// ENTRY that wraps the inverse, so determinism and byte-faithful round-trips are
// unaffected. Authorship is in-memory working-copy state, never serialized to the
// `.mlt` (same as `revision` / `dirty`).

/** Who applied an edit. `"human"` is the GUI operator; any other string is an
 *  agent/session id (e.g. a worktree slug or an MCP session token). Free-form so a
 *  caller can scope as finely as it wants (per-agent, per-session) without a schema
 *  change; the ONLY semantics the session enforces is string equality. */
export type EditAuthor = string;

/** The default author when a caller does not name one — the GUI operator. The
 *  existing viewer keyboard/gesture path applies ops with no author, so it keeps
 *  behaving as a single human author with a private, never-crossed undo stack. */
export const HUMAN_AUTHOR: EditAuthor = "human";

/** One entry on the undo/redo history: the canonical inverse (re-applied to move
 *  history) plus the author who created the edit it undoes/redoes. Keeping author
 *  on the entry — not on the `OpInvocation` — is what lets the inverse stay
 *  byte-canonical while the boundary check reads the wrapper. */
export type AuthoredOp = {
  /** The canonical invocation to re-apply (the inverse for an undo entry; the
   *  forward op for a redo entry). Unchanged from the edit algebra's output. */
  invocation: OpInvocation;
  /** The author of the edit this entry undoes (undo stack) or redoes (redo stack). */
  author: EditAuthor;
};

/** One route's live working copy: the in-memory IR + the undo/redo history. The
 *  `uri` is the resolved `.mlt` path (the same string the action runtime + the
 *  diagnostics surface use as a document id). */
export type TimelineSession = {
  /** The resolved `.mlt` path this session was loaded from (the document id). */
  uri: string;
  /** The current in-memory IR. Mutated only by replacing the whole reference with
   *  the fresh state an op returns (ops are pure; we never mutate in place). */
  ir: Timeline;
  /** Authored inverse invocations, newest last. Pop to undo. Each entry carries the
   *  author of the edit it undoes, so an undo can refuse to cross authorship. */
  undoStack: AuthoredOp[];
  /** Authored forward invocations of undone ops, newest last. Pop to redo. Cleared
   *  by a fresh apply. Each entry carries the author of the edit it redoes. */
  redoStack: AuthoredOp[];
  /** True once a mutation/undo/redo has diverged the working IR from the last
   *  saved (or loaded) on-disk content, so the UI can show an unsaved indicator. */
  dirty: boolean;
  /** A monotonic counter bumped on EVERY successful op/undo/redo. The live-preview
   *  compositor keys its draw effect on `(currentFrame, revision)` — the analog of
   *  OpenReel's `project.modifiedAt` / OpenCut's `renderTree` identity — so a
   *  same-frame edit invalidates the cached frame and triggers a recomposite
   *  WITHOUT deep-diffing the IR. It is the HMR trigger (DESIGN-LIVE-PREVIEW §3,
   *  §4). Starts at 0 on load (the initial, un-edited state); the first edit makes
   *  it 1. It is in-memory working-copy state, never serialized to the `.mlt`. */
  revision: number;
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
  /** The author of the edit a NEXT undo would revert (top of the undo stack), or
   *  `null` when the stack is empty. The GUI uses this to label/guard its undo —
   *  e.g. disable a human's Cmd+Z, or warn, when the top edit belongs to an agent
   *  so a human never silently reverts agent work (the agent-scoped undo boundary). */
  nextUndoAuthor: EditAuthor | null;
  /** The author of the edit a NEXT redo would re-apply (top of the redo stack), or
   *  `null` when the stack is empty. Symmetric to `nextUndoAuthor`. */
  nextRedoAuthor: EditAuthor | null;
  /** The session's monotonic revision AFTER this edit (see `TimelineSession`).
   *  The viewer's live-preview compositor keys its recomposite on this — every
   *  op/undo/redo returns a strictly greater value than the prior result, so the
   *  client knows the IR changed even when the playhead frame did not. */
  revision: number;
};

/** A typed failure (no state change). Mirrors the bridge `ToolError` shape plus the
 *  `ok:false` the viewer branches on. */
export type SessionEditError = {
  ok: false;
  /** The EditError kind (`clip-not-found`, `invalid-args`, …) or a session reason
   *  (`nothing-to-undo`, `nothing-to-redo`, `cross-author-undo`, `cross-author-redo`). */
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
      revision: 0,
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
    nextUndoAuthor: peekAuthor(session.undoStack),
    nextRedoAuthor: peekAuthor(session.redoStack),
    revision: session.revision,
  };
}

/** The author at the top of a history stack (the next one an undo/redo would
 *  touch), or `null` when the stack is empty. */
function peekAuthor(stack: AuthoredOp[]): EditAuthor | null {
  return stack.at(-1)?.author ?? null;
}

/** True when `author` is allowed to undo/redo the top entry of `stack`. The rule:
 *  an author may only move history entries it authored, UNLESS it explicitly opts
 *  into crossing the boundary (`allowCrossAuthor`). An empty stack is "allowed" so
 *  the caller surfaces the canonical `nothing-to-undo`/`nothing-to-redo` reason
 *  rather than a spurious authorship error. */
function mayCross(stack: AuthoredOp[], author: EditAuthor, allowCrossAuthor: boolean): boolean {
  const top = stack.at(-1);
  if (!top) return true;
  if (allowCrossAuthor) return true;
  return top.author === author;
}

/** Options shared by `applyOp`/`undoSession`/`redoSession`. All optional, so every
 *  existing single-author call site keeps compiling and behaving as the human. */
export type EditOptions = {
  /** The author of this edit (apply) or the author requesting the move (undo/redo).
   *  Defaults to {@link HUMAN_AUTHOR}. */
  author?: EditAuthor;
  /** When true, an undo/redo may cross an authorship boundary (revert/redo an edit
   *  authored by someone else). Defaults to false — the safe, Palmier-lesson
   *  behavior where each author's undo is private. The GUI can set this for an
   *  explicit "undo anyway" affordance; an agent should leave it false. */
  allowCrossAuthor?: boolean;
};

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
export function applyOp(
  session: TimelineSession,
  invocation: OpInvocation,
  opts: EditOptions = {},
): SessionEditOutcome {
  const author = opts.author ?? HUMAN_AUTHOR;
  const { outcome, newState } = mutate(session.ir, invocation, session.uri);
  if (isToolError(outcome) || !newState) {
    return fromToolOutcome(session, outcome, outcome as never);
  }
  session.ir = newState;
  // Tag the undo entry with the author who applied this edit; the inverse itself
  // stays canonical (authorship is on the wrapper, never inside the invocation).
  session.undoStack.push({ invocation: outcome.inverse, author });
  session.redoStack = [];
  session.dirty = true;
  session.revision++;
  return editResult(session, outcome.consequences);
}

/** undo — pop the top inverse off the undo stack and apply it. The inverse's OWN
 *  inverse (returned by applying it) is the FORWARD op that redoes the edit, which
 *  we push onto the redo stack. Stacks are swapped in spirit: undo feeds redo.
 *  Returns `nothing-to-undo` when the undo stack is empty. */
export function undoSession(session: TimelineSession, opts: EditOptions = {}): SessionEditOutcome {
  const author = opts.author ?? HUMAN_AUTHOR;
  // Authorship boundary: refuse to undo an edit `author` did not make (unless they
  // explicitly opt in). Checked BEFORE the pop so the stack is untouched on refusal.
  if (!mayCross(session.undoStack, author, opts.allowCrossAuthor ?? false)) {
    const owner = peekAuthor(session.undoStack);
    return {
      ok: false,
      kind: "cross-author-undo",
      detail: `top of the undo stack was authored by "${owner}", not "${author}"; pass allowCrossAuthor to undo it anyway`,
    };
  }
  const top = session.undoStack.pop();
  if (!top) {
    return { ok: false, kind: "nothing-to-undo", detail: "undo stack is empty" };
  }
  const { outcome, newState } = undoTool(session.ir, top.invocation, session.uri);
  if (isToolError(outcome) || !newState) {
    // Re-applying the inverse failed — restore the stack so history is consistent.
    session.undoStack.push(top);
    return fromToolOutcome(session, outcome, outcome as never);
  }
  session.ir = newState;
  // The inverse-of-the-inverse is the forward op that redoes this edit. It carries
  // the ORIGINAL author so a later redo is attributed to whoever made the edit, not
  // to whoever undid it — the redo restores their work under their name.
  session.redoStack.push({ invocation: outcome.inverse, author: top.author });
  session.dirty = true;
  session.revision++;
  return editResult(session, outcome.consequences);
}

/** redo — pop the top forward op off the redo stack and re-apply it. The op's
 *  inverse goes back onto the undo stack, restoring the pre-undo history shape.
 *  Returns `nothing-to-redo` when the redo stack is empty. */
export function redoSession(session: TimelineSession, opts: EditOptions = {}): SessionEditOutcome {
  const author = opts.author ?? HUMAN_AUTHOR;
  // Symmetric authorship boundary: refuse to redo an edit `author` did not author.
  if (!mayCross(session.redoStack, author, opts.allowCrossAuthor ?? false)) {
    const owner = peekAuthor(session.redoStack);
    return {
      ok: false,
      kind: "cross-author-redo",
      detail: `top of the redo stack was authored by "${owner}", not "${author}"; pass allowCrossAuthor to redo it anyway`,
    };
  }
  const top = session.redoStack.pop();
  if (!top) {
    return { ok: false, kind: "nothing-to-redo", detail: "redo stack is empty" };
  }
  const { outcome, newState } = mutate(session.ir, top.invocation, session.uri);
  if (isToolError(outcome) || !newState) {
    // Re-applying the forward op failed — restore the redo stack.
    session.redoStack.push(top);
    return fromToolOutcome(session, outcome, outcome as never);
  }
  session.ir = newState;
  // Restore the entry to the undo stack under its ORIGINAL author.
  session.undoStack.push({ invocation: outcome.inverse, author: top.author });
  session.dirty = true;
  session.revision++;
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
