// The editing brain for the timeline strip. Owns the WORKING IR (which overrides
// the server's last-loaded `timeline` once the user starts editing), the current
// selection, the ambient diagnostic set, and the dirty/undo/redo state. Every
// mutating gesture funnels through `commit(invocation)`, which POSTs the op to the
// server's in-memory session and re-renders from the returned IR + diagnostics.
//
// The viewer is the local-app GUI consumer of the ambient diagnostic stream (the
// "Agent feedback contract" in AGENTS.md): an apply/undo/redo returns the FULL
// current diagnostic set, which we index by clip uuid so the strip can paint a
// per-clip badge. Frame math stays integer everywhere — the hook never invents a
// float frame; it passes the UI's already-rounded integers to the edit algebra.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyOp, redoEdit, saveTimeline, undoEdit } from "./api";
import type { Diagnostic, OpInvocation, SessionEditResult, Timeline } from "./types";

export interface TimelineEditor {
  /** The IR to draw: the working copy once edited, else the server's load. */
  timeline: Timeline;
  /** The session's monotonic edit revision (0 on load; bumped on every
   *  op/undo/redo). The live-preview footage stage keys its recomposite on
   *  `(currentFrame, revision)` — the HMR trigger (DESIGN-LIVE-PREVIEW §3, §4): a
   *  same-frame edit changes `revision` so the stage re-resolves the live IR and
   *  re-seeks the footage `<video>` WITH NO SAVE. */
  revision: number;
  /** Total timeline frames for the working IR (max across all tracks). */
  totalFrames: number;
  /** The selected clip's uuid, or null. */
  selectedId: string | null;
  select: (uuid: string | null) => void;
  /** Diagnostics for the working IR, indexed by clip uuid (others under ""). */
  diagnosticsByClip: Map<string, Diagnostic[]>;
  /** Apply one op against the working IR (optimistic-free: server is the truth). */
  commit: (invocation: OpInvocation) => Promise<SessionEditResult | null>;
  undo: () => void;
  redo: () => void;
  save: () => void;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  /** Transient "Saved" pulse for the indicator. */
  justSaved: boolean;
  /** The last op/undo/redo error (clip-not-found, frame-out-of-range, …), if any. */
  lastError: string | null;
  /** True while a commit/undo/redo/save request is in flight. */
  busy: boolean;
}

/** The number of timeline frames a track occupies (sum of its item playtimes). */
function trackFrames(items: Timeline["tracks"]["video"][number]["items"]): number {
  let n = 0;
  for (const item of items) {
    if (item.kind === "clip") n += item.out - item.in + 1;
    else if (item.kind === "blank") n += item.length;
    else n += item.frames;
  }
  return n;
}

function computeTotalFrames(tl: Timeline): number {
  let max = 1;
  for (const t of [...tl.tracks.video, ...tl.tracks.audio]) {
    max = Math.max(max, trackFrames(t.items));
  }
  return max;
}

/** Index the ambient diagnostic set by the clip uuid it anchors to (`""` for
 *  document/track-level diagnostics that have no clip anchor). */
function indexByClip(diags: Diagnostic[]): Map<string, Diagnostic[]> {
  const map = new Map<string, Diagnostic[]>();
  for (const d of diags) {
    const key = d.location.clip ?? "";
    const bucket = map.get(key);
    if (bucket) bucket.push(d);
    else map.set(key, [d]);
  }
  return map;
}

export function useTimelineEditor(
  serverTimeline: Timeline,
  serverTotalFrames: number,
  route: string | undefined,
): TimelineEditor {
  // `working` is null until the first successful edit; before that we draw the
  // server's load verbatim. After an edit we draw the returned IR.
  const [working, setWorking] = useState<Timeline | null>(null);
  // Monotonic edit revision (the HMR trigger). 0 = the un-edited server load; the
  // first edit makes it 1. Mirrors the server session's `revision`, so the footage
  // stage repaints on a same-frame edit even though `currentFrame` did not move.
  const [revision, setRevision] = useState(0);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const savedTimer = useRef<number | null>(null);

  // A new server load (route change / reload) resets the working copy: the server
  // session is the source of truth and a fresh fetch means a fresh document.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed on the server IR identity only.
  useEffect(() => {
    setWorking(null);
    setRevision(0);
    setDiagnostics([]);
    setSelectedId(null);
    setCanUndo(false);
    setCanRedo(false);
    setDirty(false);
    setLastError(null);
  }, [serverTimeline]);

  const timeline = working ?? serverTimeline;
  const totalFrames = working ? computeTotalFrames(working) : serverTotalFrames;

  const ingest = useCallback((res: SessionEditResult) => {
    setWorking(res.ir);
    setRevision(res.revision);
    setDiagnostics(res.diagnostics);
    setCanUndo(res.canUndo);
    setCanRedo(res.canRedo);
    setDirty(res.dirty);
    setLastError(null);
  }, []);

  const commit = useCallback(
    async (invocation: OpInvocation): Promise<SessionEditResult | null> => {
      setBusy(true);
      try {
        const res = await applyOp(invocation, route);
        ingest(res);
        return res;
      } catch (e) {
        setLastError(String((e as Error)?.message ?? e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [route, ingest],
  );

  const undo = useCallback(() => {
    setBusy(true);
    undoEdit(route)
      .then(ingest)
      .catch((e) => setLastError(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(false));
  }, [route, ingest]);

  const redo = useCallback(() => {
    setBusy(true);
    redoEdit(route)
      .then(ingest)
      .catch((e) => setLastError(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(false));
  }, [route, ingest]);

  const save = useCallback(() => {
    setBusy(true);
    saveTimeline(route)
      .then(() => {
        setDirty(false);
        setJustSaved(true);
        if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
        savedTimer.current = window.setTimeout(() => setJustSaved(false), 1600);
      })
      .catch((e) => setLastError(String((e as Error)?.message ?? e)))
      .finally(() => setBusy(false));
  }, [route]);

  useEffect(
    () => () => {
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
    },
    [],
  );

  const diagnosticsByClip = useMemo(() => indexByClip(diagnostics), [diagnostics]);

  return {
    timeline,
    revision,
    totalFrames,
    selectedId,
    select: setSelectedId,
    diagnosticsByClip,
    commit,
    undo,
    redo,
    save,
    canUndo,
    canRedo,
    dirty,
    justSaved,
    lastError,
    busy,
  };
}
