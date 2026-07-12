import { Button } from "@/components/ui/button";
// The timeline strip — drawn from the working IR (the editor's live copy). Video
// tracks (top→bottom) then audio tracks, an adaptive time ruler that is the ONLY
// scrub zone, and a draggable CTI handle. Clips are interactive: pointerdown
// selects + begins a contextual gesture whose tool is inferred from WHERE you grab
// (move / trim / roll / slip / slide) with modifiers; the drag rubber-bands locally
// and COMMITS on pointerup via the edit algebra (POST /api/apply-op).
//
// SCRUB ZONE: seeking happens ONLY in the time ruler (a distinct control strip with
// the CTI flag handle). The track lanes never seek — a pointerdown there selects a
// clip or deselects. The playhead is solid through the ruler and dashed/dimmed over
// the rows (a position indicator there, not a click target).
//
// ZOOM MODEL (fixed time→pixel scale, like every pro NLE): the scale is an ABSOLUTE
// pixels-per-frame the USER owns, NOT a fraction of content. It is frozen against
// edits — adding/trimming/deleting a clip changes the scroll extent, never the
// scale, so a given frame always sits at the same pixel and nothing "bounces". Only
// explicit zoom (+/−/=/−) or "Fit" (\) changes it; "Fit" is a one-shot command that
// solves scale = paneWidth/totalFrames ONCE, not a live binding. We fit on load and
// on document change, then leave it alone. The ruler picks a "nice" interval + label
// format from the current scale.
import {
  AudioLines,
  Expand,
  Eye,
  EyeOff,
  Film,
  Magnet,
  Redo2,
  Save,
  Slice,
  Undo2,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useClockInstance } from "../ClockProvider";
import { usePreviewInstance } from "../PreviewProvider";
import { MEDIA_DRAG_MIME, type MediaDragPayload } from "../SourceProvider";
import { buildDragPreview } from "../dragPreview";
import {
  type Gesture,
  type Tool,
  buildInvocation,
  cursorFor,
  gestureDxBounds,
  resolveGesture,
  snapFrame,
} from "../timelineGestures";
import {
  type EditTarget,
  adjacentTrackMove,
  browseDestination,
  clipAccessibleName,
  findClip,
  keyboardInvocation,
  selectableClips,
  trackLabel,
} from "../timelineKeyboard";
import type { Diagnostic, PlacedItem, Track } from "../types";
import { placeItems } from "../types";
import { type TimelineEditor, humanHistoryOptions } from "../useTimelineEditor";
import { ClipBlock } from "./ClipBlock";
import { Playhead } from "./Playhead";

const GUTTER = 104; // header column: type icon + name + the eye/mute toggles
// Per-kind track heights (variable — video taller for a thumbnail-ready lane, audio
// medium for a waveform). The pointer→track math walks cumulative offsets (below),
// NOT a single uniform row height, so the drag/trim/move gestures still hit the
// right lane at any height.
const TRACK_H = { video: 56, audio: 40 } as const;
const trackH = (t: Track): number => TRACK_H[t.kind];
const RULER_HEIGHT = 36; // taller: reads as a dedicated control strip (the scrub zone)
// Drop-zone strips above the top track and below the bottom track: dragging a clip
// (or a media tile / the source-monitor chip) into one CREATES a new track of the
// matching kind (video above, audio below) and places it there.
const GUTTER_H = 14;
const MIN_TICK_PX = 64; // ruler ticks stay at least this far apart
const MAX_PX_PER_FRAME = 60; // zoom-in ceiling (frame-level granularity)
const MIN_PX_PER_FRAME = 0.02; // zoom-out floor (absolute; ~0.6px/sec at 30fps)
const STEP = 1.6; // per-click zoom factor
// Trailing open time past the last clip: a bit of empty workspace to scroll into and
// drop onto, so trimming the tail never collapses the world to hug content.
const TRAIL_SLACK_PX = 320;
const visuallyHidden: React.CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export interface TimelineStripProps {
  editor: TimelineEditor;
  /** Track ids muted/hidden in the MONITOR (view state, not the document): a video
   *  track's eye hides its layers; an audio track's speaker silences it. Optional so
   *  the strip mounts standalone (the a11y component harness) with no monitor. */
  previewMuted?: Set<string>;
  onTogglePreviewMute?: (trackId: string) => void;
}

const NO_PREVIEW_MUTED: ReadonlySet<string> = new Set<string>();

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** DISPLAY order of the tracks — the pro-NLE stack: video tracks TOP-of-compositing
 *  first (V(n)…V1 downward, since the serializer emits `[...video, ...audio]` and
 *  MLT composites LATER multitrack entries on top), then audio A1…A(n) downward.
 *  Every pointer↔track mapping and the render itself use this one order. */
function displayTracks(timeline: { tracks: { video: Track[]; audio: Track[] } }): Track[] {
  return [...timeline.tracks.video].reverse().concat(timeline.tracks.audio);
}

/** Resolve which track lane a local Y (relative to the lanes' top — i.e. already
 *  past the ruler) falls in, by walking the ordered tracks' cumulative heights.
 *  Replaces the old uniform-ROW_HEIGHT division so variable-height lanes still map a
 *  pointer to the correct track for a move/drop. Clamps to the last track past the end. */
function trackAtY(ordered: Track[], yLocal: number): Track | null {
  let top = 0;
  for (const t of ordered) {
    const h = trackH(t);
    if (yLocal >= top && yLocal < top + h) return t;
    top += h;
  }
  return ordered.length ? (ordered[ordered.length - 1] ?? null) : null;
}

/** Adaptive ruler interval (in frames) + a label formatter, chosen so ticks are
 *  ≥ MIN_TICK_PX apart. */
function rulerScale(pxPerFrame: number, fpsWhole: number) {
  const subSecond = [1, 2, 5, 10, 15];
  const secondBased = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].map((s) => s * fpsWhole);
  const candidates = [...new Set([...subSecond, ...secondBased])].sort((a, b) => a - b);
  const framesPerTick =
    candidates.find((f) => f * pxPerFrame >= MIN_TICK_PX) ?? candidates[candidates.length - 1] ?? 1;
  const label = (frame: number): string => {
    const totalSec = Math.floor(frame / fpsWhole);
    if (framesPerTick < fpsWhole) {
      const ff = frame % fpsWhole;
      return `${totalSec}:${String(ff).padStart(2, "0")}`;
    }
    if (framesPerTick < 60 * fpsWhole) return `${totalSec}s`;
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  };
  return { framesPerTick, label };
}

/** The live drag state captured at gesture start + updated on each move. */
interface DragState {
  gesture: Gesture;
  /** Pointer clientX at gesture start. */
  startClientX: number;
  /** The committed integer-frame delta (snapped) at the latest move. */
  dxFrames: number;
  /** The snap target frame the drag is currently locked to (for the guide). */
  snappedTo: number | null;
  /** Whether the gesture ripples (Alt at start, for move/trim). */
  ripple: boolean;
  /** The track the clip will land on (move only) — updated from the pointer's Y as
   *  it crosses lanes. Defaults to the source track; a different (same-kind) id is a
   *  cross-track move. */
  toTrackId: string;
  /** A move whose pointer is over a gutter drop-zone → create a NEW track of the
   *  clip's kind and move onto it. "top" = a new video track above; "bottom" = a new
   *  audio track below. null = a normal (existing-track) move. */
  newTrack: "top" | "bottom" | null;
  /** True once the pointer has travelled past the drag threshold. Until then the
   *  gesture is a CLICK-IN-PROGRESS: no snap, no delta, no monitor preview — so a
   *  plain click selects without the timeline or monitor reacting (the pro-NLE
   *  drag-doesn't-start-until-you-move contract). */
  moved: boolean;
}

/** Pointer travel (px) before a pointerdown becomes a DRAG. Below this it's a click. */
const DRAG_THRESHOLD_PX = 4;

export function TimelineStrip({
  editor,
  previewMuted = NO_PREVIEW_MUTED as Set<string>,
  onTogglePreviewMute = () => {},
}: TimelineStripProps) {
  const { timeline, totalFrames, selectedId, diagnosticsByClip } = editor;
  const clock = useClockInstance();
  // The drag-preview channel to the footage stage: push a compositor override on
  // each drag move so the monitor shows the trimmed edge / drop frame; clear it once
  // the gesture commits (kept until the commit lands, to avoid a snap-back flash).
  const previewStore = usePreviewInstance();
  const laneRef = useRef<HTMLDivElement>(null);
  // The ABSOLUTE scale in pixels-per-frame. `null` means "not yet fitted" (on mount
  // or after a document change) — the fit effect below sets it once. After that it is
  // the frozen coordinate space; edits never touch it.
  const [pxpf, setPxpf] = useState<number | null>(null);
  const [paneWidth, setPaneWidth] = useState(900);
  const scrubbing = useRef(false);
  const prevPxPerFrame = useRef<number | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  // Snapping toggle (magnet). On by default; turn OFF for free-frame positioning —
  // the fix for "it snaps to random points / won't stop where I want".
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const [editMode, setEditMode] = useState<{ clipId: string; target: EditTarget } | null>(null);
  const optionRefs = useRef(new Map<string, HTMLDivElement>());
  const regionRef = useRef<HTMLElement>(null);
  const previousClipIds = useRef<string[]>([]);
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const transactionRef = useRef<{
    author: string;
    clipId: string;
    expectedRevision: number;
    undoCount: number;
    failed: boolean;
  } | null>(null);
  const lastBoundaryRef = useRef<string | null>(null);
  const burstRef = useRef<{
    key: "ArrowLeft" | "ArrowRight";
    dx: number;
    alt: boolean;
    meta: boolean;
    target: EditTarget;
    timer: number | null;
  } | null>(null);
  const flushPromiseRef = useRef<Promise<boolean> | null>(null);

  // Measure before paint so the initial fit uses the real pane width (no scale flash).
  useLayoutEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    const measure = () => setPaneWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fps = timeline.profile.fps;
  const fpsWhole = Math.max(1, Math.round(fps[0] / fps[1]));

  const contentWidth = Math.max(120, paneWidth - GUTTER);
  // The scale that would fit all content in the pane. Cap the TOP so a 3-frame
  // timeline doesn't fit at an absurd 300px/frame; leave the BOTTOM uncapped so an
  // hours-long timeline can still fit. This feeds "Fit" and the initial fit only —
  // it is NOT the live scale.
  const fitPxPerFrame = Math.min(MAX_PX_PER_FRAME, contentWidth / Math.max(1, totalFrames));
  // Zoom-out floor: never above the fit scale, so "Fit" is always reachable.
  const minScale = Math.min(MIN_PX_PER_FRAME, fitPxPerFrame);
  // The live, frozen scale. Falls back to fit only for the pre-fit render(s).
  const pxPerFrame = pxpf ?? fitPxPerFrame;
  // The strip always FILLS the pane — the timeline is a standing entity, it never
  // stops short of the right edge just because the content does.
  const laneWidth = Math.max(GUTTER + totalFrames * pxPerFrame + TRAIL_SLACK_PX, paneWidth);

  const zoomIn = useCallback(
    () => setPxpf((p) => clamp((p ?? fitPxPerFrame) * STEP, minScale, MAX_PX_PER_FRAME)),
    [fitPxPerFrame, minScale],
  );
  const zoomOut = useCallback(
    () => setPxpf((p) => clamp((p ?? fitPxPerFrame) / STEP, minScale, MAX_PX_PER_FRAME)),
    [fitPxPerFrame, minScale],
  );
  const zoomFit = useCallback(() => setPxpf(fitPxPerFrame), [fitPxPerFrame]);
  const atFit = Math.abs(pxPerFrame - fitPxPerFrame) <= fitPxPerFrame * 0.01;

  // Fit the scale to the pane on first load, and re-fit when a different document
  // loads (route change). Between those, the scale is frozen — this is what stops the
  // timeline rescaling ("bouncing") on every edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-fit only on document identity.
  useEffect(() => {
    setPxpf(null);
  }, [editor.route]);
  useEffect(() => {
    if (pxpf === null && paneWidth > 0) setPxpf(clamp(fitPxPerFrame, minScale, MAX_PX_PER_FRAME));
  }, [pxpf, paneWidth, fitPxPerFrame, minScale]);

  // Keyboard: = zoom in, - zoom out, \ zoom-to-fit (Premiere). Ignore while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomIn();
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomOut();
      } else if (e.key === "\\") {
        e.preventDefault();
        zoomFit();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomIn, zoomOut, zoomFit]);

  // Anchor zoom to the playhead: when the scale changes (only on explicit zoom/Fit,
  // never on edits), keep the playhead centred so it doesn't fly to an edge. The
  // first fit seeds the ref without scrolling.
  useLayoutEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    if (prevPxPerFrame.current === null) {
      prevPxPerFrame.current = pxPerFrame;
      return;
    }
    if (prevPxPerFrame.current === pxPerFrame) return;
    const frame = clock.getSnapshot().currentFrame;
    const x = GUTTER + frame * pxPerFrame;
    el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
    prevPxPerFrame.current = pxPerFrame;
  }, [pxPerFrame, clock]);

  // ── Scrub (RULER ONLY) ──────────────────────────────────────────────────
  const frameFromClientX = useCallback(
    (clientX: number): number => {
      const el = laneRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left - GUTTER + el.scrollLeft;
      return Math.max(0, Math.min(Math.round(x / pxPerFrame), totalFrames - 1));
    },
    [pxPerFrame, totalFrames],
  );

  const onRulerPointerDown = useCallback(
    (e: React.PointerEvent) => {
      scrubbing.current = true;
      clock.pause();
      clock.seekTo(frameFromClientX(e.clientX));
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [clock, frameFromClientX],
  );
  const onRulerPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!scrubbing.current) return;
      clock.seekTo(frameFromClientX(e.clientX));
    },
    [clock, frameFromClientX],
  );
  const onRulerPointerUp = useCallback(() => {
    scrubbing.current = false;
  }, []);

  // ── Snap candidates: every clip edge (start + end) on the timeline, plus the
  // playhead and frame 0. Recomputed per render from the working IR. Excludes the
  // dragged clip's own edges so it doesn't snap to itself.
  const snapCandidates = useMemo(() => {
    const set = new Set<number>([0]);
    const draggedUuid = drag?.gesture.uuid ?? editMode?.clipId;
    for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
      for (const p of placeItems(track)) {
        if (p.item.kind !== "clip") continue;
        if (p.item.id === draggedUuid) continue;
        set.add(p.start);
        set.add(p.start + p.length);
      }
    }
    set.add(clock.getSnapshot().currentFrame);
    return [...set];
  }, [timeline, drag, editMode?.clipId, clock]);

  const clips = useMemo(() => selectableClips(timeline), [timeline]);
  const entryId =
    selectedId && clips.some((clip) => clip.id === selectedId) ? selectedId : clips[0]?.id;

  const focusClip = useCallback(
    (id: string) => {
      editor.select(id);
      window.requestAnimationFrame(() => optionRefs.current.get(id)?.focus());
    },
    [editor],
  );

  useEffect(() => {
    const currentIds = clips.map((clip) => clip.id);
    if (selectedId && !currentIds.includes(selectedId)) {
      const removedIndex = previousClipIds.current.indexOf(selectedId);
      const following = previousClipIds.current
        .slice(Math.max(0, removedIndex + 1))
        .find((id) => currentIds.includes(id));
      const previous = previousClipIds.current
        .slice(0, Math.max(0, removedIndex))
        .reverse()
        .find((id) => currentIds.includes(id));
      const destination = following ?? previous ?? currentIds[0];
      if (destination) focusClip(destination);
      else {
        editor.select(null);
        window.requestAnimationFrame(() => regionRef.current?.focus());
      }
    }
    previousClipIds.current = currentIds;
  }, [clips, editor.select, focusClip, selectedId]);

  const announceSelection = useCallback((id: string) => {
    const clip = findClip(editorRef.current.timeline, id);
    if (!clip) return;
    const blocking = (editorRef.current.diagnosticsByClip.get(id) ?? []).filter(
      (diagnostic) => diagnostic.severity === "error",
    ).length;
    setAnnouncement(clipAccessibleName(clip, editorRef.current.timeline, blocking));
  }, []);

  const flushBurst = useCallback((): Promise<boolean> => {
    if (flushPromiseRef.current) return flushPromiseRef.current;
    const discardPendingBurst = () => {
      const pending = burstRef.current;
      if (pending?.timer != null) window.clearTimeout(pending.timer);
      burstRef.current = null;
    };
    const work = (async (): Promise<boolean> => {
      while (burstRef.current) {
        const burst = burstRef.current;
        burstRef.current = null;
        if (burst.timer != null) window.clearTimeout(burst.timer);
        const transaction = transactionRef.current;
        if (!transaction || transaction.clipId !== editMode?.clipId) return false;
        const result = keyboardInvocation({
          timeline: editorRef.current.timeline,
          clipId: transaction.clipId,
          target: burst.target,
          dx: burst.dx,
          alt: burst.alt,
          meta: burst.meta,
          snapEnabled,
          pxPerFrame,
          snapCandidates,
        });
        if (!result) {
          transaction.failed = true;
          discardPendingBurst();
          setAnnouncement("The selected clip is no longer available");
          return false;
        }
        if (!result.invocation) {
          transaction.failed = false;
          const limitation = result.limitation ?? "No timeline change";
          if (lastBoundaryRef.current !== limitation) setAnnouncement(limitation);
          lastBoundaryRef.current = limitation;
          continue;
        }
        const response = await editorRef.current.commit(result.invocation, {
          author: transaction.author,
        });
        if (!response) {
          transaction.failed = true;
          discardPendingBurst();
          const error = editorRef.current.lastError;
          setAnnouncement(error ? `${error.kind}: ${error.detail}` : "Timeline edit failed");
          return false;
        }
        transaction.expectedRevision = response.revision;
        transaction.undoCount++;
        transaction.failed = false;
        lastBoundaryRef.current = null;
        const direction = result.appliedDx > 0 ? "+" : "";
        const updated = findClip(response.ir, transaction.clipId);
        const item = updated?.placed.item;
        const resultingRange =
          updated && item?.kind === "clip"
            ? `, ${trackLabel(updated.track, response.ir)}, timeline ${updated.placed.start} to ${updated.placed.start + updated.placed.length - 1}, source ${item.in} to ${item.out}`
            : "";
        setAnnouncement(
          `${result.tool} ${direction}${result.appliedDx} frames${resultingRange}${result.snappedTo == null ? "" : `, snapped to frame ${result.snappedTo}`}${burst.alt ? ", ripple modifier" : ""}${burst.meta ? ", roll or slide modifier" : ""}`,
        );
      }
      return transactionRef.current?.failed !== true;
    })();
    flushPromiseRef.current = work;
    void work.finally(() => {
      if (flushPromiseRef.current === work) flushPromiseRef.current = null;
    });
    return work;
  }, [editMode, pxPerFrame, snapCandidates, snapEnabled]);

  const scheduleBurst = useCallback(
    (key: "ArrowLeft" | "ArrowRight", step: number, alt: boolean, meta: boolean) => {
      if (transactionRef.current) transactionRef.current.failed = false;
      const existing = burstRef.current;
      if (existing && (existing.key !== key || existing.alt !== alt || existing.meta !== meta)) {
        void flushBurst();
      }
      const burst =
        existing &&
        existing.key === key &&
        existing.alt === alt &&
        existing.meta === meta &&
        existing.target === editMode?.target
          ? existing
          : { key, dx: 0, alt, meta, target: editMode?.target ?? "body", timer: null };
      burst.dx += key === "ArrowLeft" ? -step : step;
      if (burst.timer != null) window.clearTimeout(burst.timer);
      burst.timer = window.setTimeout(() => void flushBurst(), 500);
      burstRef.current = burst;
    },
    [editMode?.target, flushBurst],
  );

  const leaveEditMode = useCallback((clipId: string) => {
    setEditMode(null);
    transactionRef.current = null;
    window.requestAnimationFrame(() => optionRefs.current.get(clipId)?.focus());
  }, []);

  const cancelEditMode = useCallback(async () => {
    const mode = editMode;
    const transaction = transactionRef.current;
    if (!mode || !transaction) return;
    if (!(await flushBurst())) return;
    if (editorRef.current.revision !== transaction.expectedRevision) {
      setAnnouncement("Cancel refused: the timeline changed outside this keyboard edit session");
      return;
    }
    for (let index = 0; index < transaction.undoCount; index++) {
      const response = await editorRef.current.undo({ author: transaction.author });
      if (!response) {
        setAnnouncement("Cancel refused: another author owns the newest timeline edit");
        return;
      }
      transaction.expectedRevision = response.revision;
    }
    setAnnouncement("Keyboard edit cancelled; the pre-entry timeline was restored");
    leaveEditMode(mode.clipId);
  }, [editMode, flushBurst, leaveEditMode]);

  const bladeAndRestoreFocus = useCallback(async () => {
    const id = editorRef.current.selectedId;
    if (!id) return;
    const before = findClip(editorRef.current.timeline, id);
    const frame = clock.getSnapshot().currentFrame;
    const response = await editorRef.current.commit({ op: "split", args: { uuid: id, frame } });
    if (!response || !before) return;
    const candidates = selectableClips(response.ir).filter(
      (clip) =>
        clip.track.id === before.track.id &&
        frame >= clip.placed.start &&
        frame < clip.placed.start + clip.placed.length,
    );
    const destination = candidates[0];
    if (destination) focusClip(destination.id);
    setAnnouncement(`Split at frame ${frame}`);
  }, [clock, focusClip]);

  const runGlobalShortcut = useCallback(
    async (action: "undo" | "redo" | "save", clipId: string) => {
      let settledUndoAuthor: string | null = null;
      if (editMode) {
        // A global history/save command is an explicit end to the current edit
        // session. Drain every queued burst first, then leave edit mode before
        // touching global history so Escape can never overclaim an exact restore.
        if (editMode.clipId !== clipId || !(await flushBurst())) return;
        const transaction = transactionRef.current;
        if (transaction && transaction.undoCount > 0) settledUndoAuthor = transaction.author;
        leaveEditMode(clipId);
      }
      if (action === "undo") {
        await editorRef.current.undo(
          settledUndoAuthor
            ? { author: settledUndoAuthor }
            : humanHistoryOptions(editorRef.current.nextUndoAuthor),
        );
      } else if (action === "redo") {
        await editorRef.current.redo(humanHistoryOptions(editorRef.current.nextRedoAuthor));
      } else {
        await editorRef.current.save();
      }
    },
    [editMode, flushBurst, leaveEditMode],
  );

  const onClipKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>, id: string) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && (event.key === "z" || event.key === "Z")) {
        event.preventDefault();
        event.stopPropagation();
        if (event.shiftKey) {
          void runGlobalShortcut("redo", id);
        } else {
          void runGlobalShortcut("undo", id);
        }
        return;
      }
      if (meta && (event.key === "y" || event.key === "Y")) {
        event.preventDefault();
        event.stopPropagation();
        void runGlobalShortcut("redo", id);
        return;
      }
      if (meta && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
        event.stopPropagation();
        void runGlobalShortcut("save", id);
        return;
      }
      if (!editMode) {
        if (
          event.key === "ArrowLeft" ||
          event.key === "ArrowRight" ||
          event.key === "ArrowUp" ||
          event.key === "ArrowDown" ||
          event.key === "Home" ||
          event.key === "End"
        ) {
          event.preventDefault();
          event.stopPropagation();
          const destination = browseDestination(editorRef.current.timeline, id, event.key, meta);
          if (destination) {
            focusClip(destination.id);
            announceSelection(destination.id);
          }
        } else if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          const author = `human:timeline-keyboard:${crypto.randomUUID()}`;
          transactionRef.current = {
            author,
            clipId: id,
            expectedRevision: editorRef.current.revision,
            undoCount: 0,
            failed: false,
          };
          setEditMode({ clipId: id, target: "body" });
          setAnnouncement(
            "Editing clip body. Arrow keys move; Alt slips; Command or Control slides",
          );
        } else if (event.key === " " || event.code === "Space") {
          event.preventDefault();
          event.stopPropagation();
          clock.toggle();
          setAnnouncement(clock.getSnapshot().playing ? "Playing" : "Paused");
        } else if (!meta && (event.key === "n" || event.key === "N")) {
          event.preventDefault();
          event.stopPropagation();
          setSnapEnabled((enabled) => {
            setAnnouncement(`Snapping ${enabled ? "off" : "on"}`);
            return !enabled;
          });
        } else if (!meta && (event.key === "b" || event.key === "B")) {
          event.preventDefault();
          event.stopPropagation();
          void bladeAndRestoreFocus();
        } else if (event.key === "Escape") {
          setAnnouncement("");
        }
        return;
      }

      if (editMode.clipId !== id) return;
      if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        const order: EditTarget[] = ["body", "head", "tail"];
        const index = order.indexOf(editMode.target);
        const next = order[(index + (event.shiftKey ? 2 : 1)) % order.length] ?? "body";
        setEditMode({ clipId: id, target: next });
        setAnnouncement(`Editing clip ${next}`);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        scheduleBurst(event.key, event.shiftKey ? 10 : 1, event.altKey, meta);
      } else if (
        (event.key === "ArrowUp" || event.key === "ArrowDown") &&
        editMode.target === "body"
      ) {
        event.preventDefault();
        event.stopPropagation();
        void flushBurst().then(async (flushed) => {
          if (!flushed) return;
          const transaction = transactionRef.current;
          const invocation = adjacentTrackMove(
            editorRef.current.timeline,
            id,
            event.key === "ArrowUp" ? "up" : "down",
          );
          if (!transaction || !invocation) {
            setAnnouncement("No compatible adjacent track in that direction");
            return;
          }
          const response = await editorRef.current.commit(invocation, {
            author: transaction.author,
          });
          if (!response) return;
          transaction.expectedRevision = response.revision;
          transaction.undoCount++;
          setAnnouncement("Moved to the nearest compatible adjacent track");
        });
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        void flushBurst().then((flushed) => {
          if (!flushed) return;
          setAnnouncement("Keyboard edit committed");
          leaveEditMode(id);
        });
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        void cancelEditMode();
      }
    },
    [
      announceSelection,
      bladeAndRestoreFocus,
      cancelEditMode,
      clock,
      editMode,
      flushBurst,
      focusClip,
      leaveEditMode,
      runGlobalShortcut,
      scheduleBurst,
    ],
  );

  const onClipKeyUp = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") void flushBurst();
    },
    [flushBurst],
  );

  useEffect(() => {
    if (editor.lastError) setAnnouncement(`${editor.lastError.kind}: ${editor.lastError.detail}`);
  }, [editor.lastError]);
  useEffect(() => {
    if (editor.justSaved) setAnnouncement("Saved; timeline is clean");
  }, [editor.justSaved]);
  useEffect(() => {
    if (editor.lastEvent?.kind === "undo") {
      setAnnouncement(`Undo complete; timeline is ${editor.lastEvent.dirty ? "dirty" : "clean"}`);
    } else if (editor.lastEvent?.kind === "redo") {
      setAnnouncement(`Redo complete; timeline is ${editor.lastEvent.dirty ? "dirty" : "clean"}`);
    } else if (editor.lastEvent?.kind === "save") {
      setAnnouncement("Save complete; timeline is clean");
    }
  }, [editor.lastEvent]);
  useEffect(
    () => () => {
      const timer = burstRef.current?.timer;
      if (timer != null) window.clearTimeout(timer);
    },
    [],
  );

  // ── Clip gesture: pointerdown selects + begins the contextual drag ──────────
  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, placed: PlacedItem, track: Track) => {
      if (placed.item.kind !== "clip") return;
      e.stopPropagation(); // don't let the lane deselect
      const uuid = placed.item.id;
      editor.select(uuid);

      const target = e.currentTarget as HTMLElement;
      target.focus();
      const rect = target.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const widthPx = rect.width;
      const mods = { alt: e.altKey, meta: e.metaKey || e.ctrlKey };
      const { zone, bodyTool } = resolveGesture(localX, widthPx, mods);

      // Resolve same-track neighbours (for roll + readouts).
      const placedTrack = placeItems(track);
      const idx = placedTrack.findIndex((p) => p.item.kind === "clip" && p.item.id === uuid);
      const prev = idx > 0 ? placedTrack[idx - 1] : null;
      const next = idx >= 0 && idx < placedTrack.length - 1 ? placedTrack[idx + 1] : null;
      const leftClip = prev && prev.item.kind === "clip" ? prev : null;
      const rightClip = next && next.item.kind === "clip" ? next : null;

      // An EDGE grab with a flush same-track clip on that side becomes a ROLL
      // (a roll needs the pair). A lone edge is a TRIM. The roll's seam pair is
      // (left-half, right-half) flush at the grabbed boundary:
      //   • left edge  → seam between leftClip (left half) and this clip (right half)
      //   • right edge → seam between this clip (left half) and rightClip (right half)
      // A clip's OWN edge always trims THAT clip — even when butted against a
      // neighbour. ROLL (the shared cut) is opt-in via Cmd/Meta with a flush
      // same-track neighbour on that side, so head/tail trimming a butted clip
      // works by default (the common case the old auto-roll broke).
      let tool: Tool;
      let seamLeft: PlacedItem | null = null;
      let seamRight: PlacedItem | null = null;
      if (zone === "left-edge") {
        if (mods.meta && leftClip) {
          tool = "roll";
          seamLeft = leftClip;
          seamRight = placed;
        } else {
          tool = "trimIn";
        }
      } else if (zone === "right-edge") {
        if (mods.meta && rightClip) {
          tool = "roll";
          seamLeft = placed;
          seamRight = rightClip;
        } else {
          tool = "trimOut";
        }
      } else {
        tool = bodyTool;
      }

      // Frames the clip may EXTEND on its trim side before a NON-RIPPLE wall: a
      // neighbour blank yields its length; real content (clip/dissolve) or the track
      // head yields 0; open trailing space (a trimOut with nothing to the right) is
      // unbounded. Captured now — the timeline is static for the drag's lifetime.
      let extendRoom: number | undefined;
      if (tool === "trimIn") {
        extendRoom = prev?.item.kind === "blank" ? prev.length : 0;
      } else if (tool === "trimOut") {
        extendRoom =
          next == null ? Number.POSITIVE_INFINITY : next.item.kind === "blank" ? next.length : 0;
      }

      const gesture: Gesture = {
        tool,
        uuid,
        trackId: track.id,
        placed,
        neighbours: { left: seamLeft, right: seamRight },
        ripple: mods.alt && (tool === "trimIn" || tool === "trimOut" || tool === "move"),
        extendRoom,
      };

      target.setPointerCapture?.(e.pointerId);
      setDrag({
        gesture,
        startClientX: e.clientX,
        dxFrames: 0,
        snappedTo: null,
        ripple: gesture.ripple,
        toTrackId: track.id,
        newTrack: null,
        moved: false,
      });
    },
    [editor],
  );

  const onLanePointerMove = useCallback(
    (e: React.PointerEvent) => {
      // Capture coords before the functional update (the synthetic event outlives it
      // in React 19, but reading them up front is cleaner + lets us resolve the lane).
      const clientX = e.clientX;
      const clientY = e.clientY;
      // Which track lane is the pointer over? The rows follow the ruler, ROW_HEIGHT
      // each, video tracks then audio. Used ONLY by a MOVE to pick the target track.
      const laneEl = laneRef.current;
      const orderedTracks: Track[] = displayTracks(timeline);
      let pointerTrack: Track | null = null;
      let gutterZone: "top" | "bottom" | null = null;
      if (laneEl) {
        const rect = laneEl.getBoundingClientRect();
        // The tracks start GUTTER_H below the ruler (the top drop-zone strip). Above
        // that strip → top gutter; past the last track's bottom → bottom gutter; else
        // walk cumulative track heights (variable lanes) to the lane under the pointer.
        const yLocal = clientY - rect.top - RULER_HEIGHT;
        const tracksH = orderedTracks.reduce((sum, t) => sum + trackH(t), 0);
        if (yLocal < GUTTER_H) gutterZone = "top";
        else if (yLocal >= GUTTER_H + tracksH) gutterZone = "bottom";
        else pointerTrack = trackAtY(orderedTracks, yLocal - GUTTER_H);
      }
      setDrag((d) => {
        if (!d) return d;
        // Below the drag threshold this is still a CLICK: no snap, no delta, no
        // preview — the clip just stays selected and nothing reacts. (Snapping on a
        // raw pointerdown could otherwise yank dxFrames non-zero at fit zoom, which
        // made a plain click jump the monitor.)
        if (!d.moved && Math.abs(clientX - d.startClientX) < DRAG_THRESHOLD_PX) return d;
        const rawFrames = Math.round((clientX - d.startClientX) / pxPerFrame);
        const g = d.gesture;
        let dxFrames = rawFrames;
        let snappedTo: number | null = null;
        // Cross-track: a MOVE lands on the lane under the pointer, but never crosses
        // KIND (video↔audio — the op rejects it). If the pointer is over a
        // different-kind lane, keep the last valid (same-kind) target. Over a matching
        // gutter drop-zone, flag a NEW-track drop (video→top, audio→bottom).
        let toTrackId = d.toTrackId;
        let newTrack: "top" | "bottom" | null = null;
        if (g.tool === "move") {
          const srcKind = orderedTracks.find((t) => t.id === g.trackId)?.kind;
          if (gutterZone === "top" && srcKind === "video") newTrack = "top";
          else if (gutterZone === "bottom" && srcKind === "audio") newTrack = "bottom";
          else if (pointerTrack && pointerTrack.kind === srcKind) toTrackId = pointerTrack.id;
        }
        // Snap the moved EDGE(S) to nearby candidates, unless snapping is off or this
        // is a slip (no edge to snap). A MOVE considers BOTH of its edges (start AND
        // end) and locks to whichever is closest to a candidate — so a clip aligns on
        // either side, not just its head (the "snaps to random points / never snaps"
        // fix: only the start used to be a candidate). Other tools snap their one
        // moved edge (trimIn/roll: the head; trimOut: the tail; slide: the start).
        if (snapEnabled && g.tool !== "slip") {
          const edges: number[] =
            g.tool === "move"
              ? [g.placed.start + rawFrames, g.placed.start + g.placed.length + rawFrames]
              : g.tool === "trimOut"
                ? [g.placed.start + g.placed.length + rawFrames]
                : g.tool === "roll"
                  ? [(g.neighbours.right?.start ?? g.placed.start) + rawFrames]
                  : [g.placed.start + rawFrames]; // move-start / slide / trimIn
          let bestAdj = 0;
          let bestDist = Number.POSITIVE_INFINITY;
          for (const anchor of edges) {
            const snapped = snapFrame(anchor, snapCandidates, pxPerFrame);
            if (snapped.snappedTo != null && Math.abs(snapped.frame - anchor) < bestDist) {
              bestDist = Math.abs(snapped.frame - anchor);
              bestAdj = snapped.frame - anchor;
              snappedTo = snapped.snappedTo;
            }
          }
          dxFrames = rawFrames + bestAdj;
        }
        // Clamp the snapped delta to the gesture's NATURAL LIMITS so an edge stops
        // dead at the media / min-length / neighbour wall (Premiere/Resolve) instead
        // of travelling past it and erroring on commit. Clamp AFTER snapping so the
        // wall wins over a snap target beyond it; if the clamp overrode a snap, drop
        // the guide (the edge never reached it). (move/slide keep their frame-0 floor
        // through the same bounds.)
        const bounds = gestureDxBounds(g);
        const clamped = Math.max(bounds.min, Math.min(bounds.max, dxFrames));
        if (clamped !== dxFrames) snappedTo = null;
        dxFrames = clamped;
        return { ...d, dxFrames, snappedTo, toTrackId, newTrack, moved: true };
      });
    },
    [pxPerFrame, snapCandidates, snapEnabled, timeline],
  );

  const onLanePointerUp = useCallback(() => {
    setDrag((d) => {
      if (!d) return null;
      // Gutter drop → create a new track of the clip's kind, then move onto it.
      if (d.gesture.tool === "move" && d.newTrack) {
        const kind = d.newTrack === "top" ? "video" : "audio";
        // The VISUAL top = the compositing top = the LAST entry of tracks.video (the
        // serializer emits [...video, ...audio] and MLT stacks later entries on top),
        // which is addTrack's `position: "bottom"` (append). The op's arg names the
        // ARRAY end, not the visual stack. Audio always appends (= visual bottom).
        const position = "bottom";
        const newId = crypto.randomUUID();
        const name =
          kind === "video"
            ? `V${timeline.tracks.video.length + 1}`
            : `A${timeline.tracks.audio.length + 1}`;
        const toPosition = Math.max(0, d.gesture.placed.start + d.dxFrames);
        void (async () => {
          await editor.commit({ op: "addTrack", args: { kind, id: newId, name, position } });
          await editor.commit({
            op: "move",
            args: {
              uuid: d.gesture.uuid,
              toTrack: { trackId: newId },
              toPosition,
              ripple: false,
              rippleAllTracks: false,
            },
          });
        })().finally(() => previewStore.clear());
        return null;
      }
      const inv = buildInvocation(d.gesture, d.dxFrames, d.ripple, d.toTrackId);
      if (inv) {
        // Keep the previewed frame on screen until the commit lands, THEN clear —
        // the monitor returns to the playhead over the newly-committed IR with no
        // snap-back flash (the preview ≈ the commit result, so the transition is
        // continuous). Clears on rejection too (finally), restoring the live frame.
        void editor.commit(inv).finally(() => previewStore.clear());
      } else {
        previewStore.clear();
      }
      return null;
    });
  }, [editor, timeline, previewStore]);

  // Push the live drag as a compositor override so the preview monitor reacts to the
  // in-flight gesture — the frame at the new in/out point on a trim, the clip landed
  // at the drop position on a move. Only SET here; the CLEAR is deferred to pointerup
  // (so the preview doesn't snap back before the commit lands). `buildDragPreview`
  // returns null for a zero-frame / non-clip / graphic drag → the monitor holds the
  // live playhead frame until the drag actually bites.
  useEffect(() => {
    if (!drag || !drag.moved) return; // a plain click never touches the monitor
    previewStore.set(buildDragPreview(timeline, drag.gesture, drag.dxFrames));
  }, [drag, timeline, previewStore]);

  // Belt-and-suspenders: never leave a stale override behind if the strip unmounts
  // (route change / teardown) while a drag is in flight.
  useEffect(() => () => previewStore.clear(), [previewStore]);

  // Deselect on a pointerdown in empty lane area (not on a clip).
  const onLaneBackgroundPointerDown = useCallback(() => {
    editor.select(null);
  }, [editor]);

  // A media drag (from the Media panel or the source monitor) dropped on a lane →
  // place exactly the carried span via the overwrite op at the drop frame.
  const onMediaDrop = useCallback(
    (track: Track, e: React.DragEvent, laneEl: HTMLElement) => {
      const raw = e.dataTransfer.getData(MEDIA_DRAG_MIME);
      if (!raw) return;
      e.preventDefault();
      let payload: MediaDragPayload;
      try {
        payload = JSON.parse(raw) as MediaDragPayload;
      } catch {
        return;
      }
      // Kind guard: audio sources land on audio lanes; video/graphic on video lanes.
      if ((payload.kind === "audio") !== (track.kind === "audio")) return;
      const rect = laneEl.getBoundingClientRect();
      const position = Math.max(0, Math.round((e.clientX - rect.left) / pxPerFrame));
      void editor.commit({
        op: "overwrite",
        args: {
          track: { trackId: track.id },
          clip: {
            kind: "clip",
            id: crypto.randomUUID(),
            resource: payload.path,
            in: payload.in,
            out: payload.out,
            filters: [],
          },
          position,
        },
      });
    },
    [editor, pxPerFrame],
  );

  // A media drag dropped on a GUTTER → create a new track of the matching kind
  // (video above / audio below), then place the span on it.
  const onGutterMediaDrop = useCallback(
    (side: "top" | "bottom", e: React.DragEvent, stripEl: HTMLElement) => {
      const raw = e.dataTransfer.getData(MEDIA_DRAG_MIME);
      if (!raw) return;
      e.preventDefault();
      let payload: MediaDragPayload;
      try {
        payload = JSON.parse(raw) as MediaDragPayload;
      } catch {
        return;
      }
      const kind = side === "top" ? "video" : "audio";
      if ((payload.kind === "audio") !== (kind === "audio")) return;
      const rect = stripEl.getBoundingClientRect();
      const position = Math.max(0, Math.round((e.clientX - rect.left) / pxPerFrame));
      const newId = crypto.randomUUID();
      const name =
        kind === "video"
          ? `V${timeline.tracks.video.length + 1}`
          : `A${timeline.tracks.audio.length + 1}`;
      void (async () => {
        // position:"bottom" APPENDS — the array end = the visual/compositing top.
        await editor.commit({
          op: "addTrack",
          args: { kind, id: newId, name, position: "bottom" },
        });
        await editor.commit({
          op: "overwrite",
          args: {
            track: { trackId: newId },
            clip: {
              kind: "clip",
              id: crypto.randomUUID(),
              resource: payload.path,
              in: payload.in,
              out: payload.out,
              filters: [],
            },
            position,
          },
        });
      })();
    },
    [editor, timeline, pxPerFrame],
  );

  // Blade — split the selected clip at the current playhead frame (the button; the
  // B key wires the same op in App's edit keyboard).
  const onBlade = useCallback(() => {
    if (!selectedId) return;
    void editor.commit({
      op: "split",
      args: { uuid: selectedId, frame: clock.getSnapshot().currentFrame },
    });
  }, [editor, selectedId, clock]);

  const { framesPerTick, label } = useMemo(
    () => rulerScale(pxPerFrame, fpsWhole),
    [pxPerFrame, fpsWhole],
  );
  const ticks = useMemo(() => {
    // Label the WHOLE visible timeline (content + the trailing open workspace), not
    // just to the last clip — the timeline is a standing entity, its ruler doesn't
    // stop where the video happens to end (Premiere behavior).
    const extentFrames = totalFrames + Math.ceil(TRAIL_SLACK_PX / pxPerFrame);
    const out: Array<{ frame: number; text: string }> = [];
    for (let f = 0; f <= extentFrames; f += framesPerTick) out.push({ frame: f, text: label(f) });
    return out;
  }, [totalFrames, framesPerTick, label, pxPerFrame]);

  const cursor = drag ? cursorFor(drag.gesture.tool) : "default";

  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-label="Timeline editor"
      aria-describedby="timeline-keyboard-help"
      style={{ display: "flex", flexDirection: "column", background: "var(--vean-bg)" }}
    >
      <p id="timeline-keyboard-help" style={visuallyHidden}>
        Use arrow keys to browse clips. Press Enter to edit the clip body, then Tab to choose its
        head or tail. Shift changes the edit step to ten frames. Press Enter to commit or Escape to
        cancel.
      </p>
      <div
        role="toolbar"
        aria-label="Timeline edit controls"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 12px",
          borderBottom: "1px solid var(--vean-border-faint)",
        }}
      >
        {/* Edit tools — lucide icons, tooltips carry the words. */}
        <IconBtn
          onClick={onBlade}
          disabled={!selectedId}
          label="Blade — split the selected clip at the playhead ( B )"
        >
          <Slice size={14} strokeWidth={1.75} />
        </IconBtn>
        <IconBtn
          onClick={() => void editor.undo(humanHistoryOptions(editor.nextUndoAuthor))}
          disabled={!editor.canUndo}
          label="Undo ( ⌘Z )"
        >
          <Undo2 size={14} strokeWidth={1.75} />
        </IconBtn>
        <IconBtn
          onClick={() => void editor.redo(humanHistoryOptions(editor.nextRedoAuthor))}
          disabled={!editor.canRedo}
          label="Redo ( ⌘⇧Z )"
        >
          <Redo2 size={14} strokeWidth={1.75} />
        </IconBtn>
        {/* Autosave makes this ambient, but an explicit Save stays — it forces the
            write NOW (like ⌘S) and is part of the approved a11y contract. */}
        <IconBtn
          onClick={() => void editor.save()}
          disabled={!editor.dirty && !editor.justSaved}
          active={editor.dirty}
          label="Save to disk ( ⌘S )"
        >
          <Save size={14} strokeWidth={1.75} />
        </IconBtn>
        {editor.lastError ? (
          <span
            style={{
              color: "var(--vean-red)",
              fontFamily: "ui-monospace, monospace",
              fontSize: 10,
              marginLeft: 6,
            }}
            title={`${editor.lastError.kind}: ${editor.lastError.detail}`}
          >
            {`${editor.lastError.kind}: ${editor.lastError.detail}`.length > 36
              ? `${`${editor.lastError.kind}: ${editor.lastError.detail}`.slice(0, 33)}…`
              : `${editor.lastError.kind}: ${editor.lastError.detail}`}
          </span>
        ) : null}

        <div style={{ flex: 1 }} />
        <IconBtn
          onClick={() => setSnapEnabled((s) => !s)}
          active={snapEnabled}
          pressed={snapEnabled}
          label={`Toggle snapping (${snapEnabled ? "on" : "off"}) — align edges to clips + the playhead`}
        >
          <Magnet size={14} strokeWidth={1.75} />
        </IconBtn>
        <div style={{ width: 6 }} />
        <IconBtn onClick={zoomOut} disabled={pxPerFrame <= minScale + 1e-9} label="Zoom out ( − )">
          <ZoomOut size={14} strokeWidth={1.75} />
        </IconBtn>
        <IconBtn onClick={zoomFit} active={atFit} label="Fit the whole timeline in view ( \\ )">
          <Expand size={14} strokeWidth={1.75} />
        </IconBtn>
        <IconBtn
          onClick={zoomIn}
          disabled={pxPerFrame >= MAX_PX_PER_FRAME - 1e-6}
          label="Zoom in ( = )"
        >
          <ZoomIn size={14} strokeWidth={1.75} />
        </IconBtn>
      </div>

      <div
        ref={laneRef}
        style={{ position: "relative", overflowX: "auto", overflowY: "hidden", cursor }}
        // Always attached; both handlers no-op when there is no active drag, so the
        // first pointermove after pointerdown is never dropped to a re-render gap.
        onPointerMove={onLanePointerMove}
        onPointerUp={onLanePointerUp}
        onPointerLeave={onLanePointerUp}
      >
        {/* width === laneWidth is the ONLY thing that should drive the horizontal
            scrollbar (i.e. zoom: content wider than the pane). Frame-anchored
            decorations — the CTI handle (centred, ±6.5px), the playhead line, and
            the last ruler tick's label — extend a few px past laneWidth when the
            playhead/last tick sits at the final frame; without clipping that few-px
            poke flips overflowX:auto into a scrollbar that eats height and shoves the
            UI up. Clip them at the content edge so the scrollbar reflects width, not
            scroll/playhead position. */}
        {/* Frozen per-track monitor toggles (eye / speaker) — rendered OUTSIDE the
            listbox because listbox>group semantics admit only option children
            (axe aria-required-children). A zero-size sticky rail keeps them frozen
            with the header gutter; each button is absolutely placed over its
            track header's right edge (the same deterministic y-walk the pointer
            math uses). */}
        <div
          style={{
            position: "sticky",
            left: 0,
            width: 0,
            height: 0,
            overflow: "visible",
            zIndex: 8,
          }}
        >
          {(() => {
            let top = RULER_HEIGHT + GUTTER_H;
            return displayTracks(timeline).map((track) => {
              const h = trackH(track);
              const y = top + (h - 18) / 2;
              top += h;
              const isMuted = previewMuted.has(track.id);
              const MuteIcon =
                track.kind === "audio" ? (isMuted ? VolumeX : Volume2) : isMuted ? EyeOff : Eye;
              return (
                <button
                  key={track.id}
                  type="button"
                  onClick={() => onTogglePreviewMute(track.id)}
                  aria-pressed={isMuted}
                  aria-label={
                    track.kind === "audio"
                      ? `${isMuted ? "Unmute" : "Mute"} track ${track.name ?? track.id} in the monitor`
                      : `${isMuted ? "Show" : "Hide"} track ${track.name ?? track.id} in the monitor`
                  }
                  title={
                    track.kind === "audio"
                      ? "Mute this track in the monitor"
                      : "Hide this track in the monitor"
                  }
                  style={{
                    position: "absolute",
                    left: GUTTER - 24,
                    top: y,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 20,
                    height: 18,
                    borderRadius: 4,
                    border: "none",
                    background: "transparent",
                    color: isMuted ? "var(--vean-gold)" : "var(--vean-fg-3)",
                    cursor: "pointer",
                  }}
                >
                  <MuteIcon size={13} strokeWidth={1.75} />
                </button>
              );
            });
          })()}
        </div>
        {/* Roving options, rather than the composite itself, own the one tab stop. */}
        {/* biome-ignore lint/a11y/useFocusableInteractive: listbox uses roving option focus. */}
        {/* biome-ignore lint/a11y/useSemanticElements: rich timeline cannot be represented by native select. */}
        <div
          role="listbox"
          aria-label="Timeline clips"
          aria-multiselectable="false"
          style={{ width: laneWidth, position: "relative", overflow: "hidden" }}
        >
          {/* Ruler — the ONLY scrub zone. Distinct background + a CTI flag handle. */}
          {/* De-boxed: same field as the lanes, no strip borders — each tick is just
              a left hairline + its label (the Premiere "quiet ruler"). */}
          <div
            style={{
              display: "flex",
              height: RULER_HEIGHT,
              position: "relative",
              cursor: "ew-resize",
            }}
            onPointerDown={onRulerPointerDown}
            onPointerMove={onRulerPointerMove}
            onPointerUp={onRulerPointerUp}
            onPointerLeave={onRulerPointerUp}
          >
            <div
              style={{
                width: GUTTER,
                flex: "0 0 auto",
                position: "sticky",
                left: 0,
                zIndex: 7,
                background: "var(--vean-header-bg)",
                borderRight: "1px solid var(--vean-border-faint)",
                cursor: "default",
              }}
            />
            <div style={{ position: "relative", flex: 1 }}>
              {ticks.map((t) => (
                <div
                  key={t.frame}
                  style={{
                    position: "absolute",
                    left: t.frame * pxPerFrame,
                    top: 0,
                    bottom: 0,
                    borderLeft: "1px solid var(--vean-border-faint)",
                    paddingLeft: 4,
                    paddingTop: 3,
                    fontSize: 10,
                    color: "var(--vean-fg-3)",
                    fontFamily: "ui-monospace, monospace",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.text}
                </div>
              ))}
              <CtiHandle pxPerFrame={pxPerFrame} />
            </div>
          </div>

          {/* Tracks in DISPLAY order — V(n)…V1 (compositing top first), then A1…A(n) —
              bracketed by the new-track gutter drop-zones. */}
          <GutterDropZone
            side="top"
            active={drag?.newTrack === "top"}
            dragActive={Boolean(drag?.moved && drag.gesture.tool === "move")}
            onMediaDrop={onGutterMediaDrop}
          />
          {displayTracks(timeline).map((track) => (
            <TrackLane
              key={track.id}
              track={track}
              pxPerFrame={pxPerFrame}
              selectedId={selectedId}
              diagnosticsByClip={diagnosticsByClip}
              drag={drag}
              timeline={timeline}
              entryId={entryId}
              editMode={editMode}
              optionRefs={optionRefs}
              onClipFocus={(id) => {
                editor.select(id);
                announceSelection(id);
              }}
              onClipKeyDown={onClipKeyDown}
              onClipKeyUp={onClipKeyUp}
              onClipPointerDown={onClipPointerDown}
              onBackgroundPointerDown={onLaneBackgroundPointerDown}
              route={editor.route}
              previewMuted={previewMuted.has(track.id)}
              onMediaDrop={onMediaDrop}
            />
          ))}
          <GutterDropZone
            side="bottom"
            active={drag?.newTrack === "bottom"}
            dragActive={Boolean(drag?.moved && drag.gesture.tool === "move")}
            onMediaDrop={onGutterMediaDrop}
          />

          <Playhead pxPerFrame={pxPerFrame} gutterWidth={GUTTER} rulerHeight={RULER_HEIGHT} />

          {/* Snap guide — a faint vertical line at the locked snap frame. */}
          {drag?.snappedTo != null ? (
            <div
              style={{
                position: "absolute",
                left: GUTTER + drag.snappedTo * pxPerFrame,
                top: RULER_HEIGHT,
                bottom: 0,
                width: 0,
                borderLeft: "1px dashed var(--vean-guide)",
                opacity: 0.8,
                pointerEvents: "none",
                zIndex: 4,
              }}
            />
          ) : null}
        </div>
      </div>
      <output aria-live="polite" aria-atomic="true" style={visuallyHidden}>
        {announcement}
      </output>
    </section>
  );
}

/** The CTI (current-time indicator) marker docked at the BOTTOM of the ruler — a
 *  small, dimmed downward arrow whose tip meets the track rows at the playhead
 *  frame. Deliberately quiet: no solid bar, no glow (the ruler itself is the scrub
 *  surface; this just marks where you are). */
function CtiHandle({ pxPerFrame }: { pxPerFrame: number }) {
  const clock = useClockInstance();
  const [frame, setFrame] = useState(clock.getSnapshot().currentFrame);
  useEffect(() => clock.subscribe(() => setFrame(clock.getSnapshot().currentFrame)), [clock]);
  return (
    <div
      style={{
        position: "absolute",
        left: frame * pxPerFrame,
        bottom: 0,
        transform: "translateX(-50%)",
        width: 9,
        height: 7,
        background: "color-mix(in srgb, var(--vean-red) 65%, transparent)",
        clipPath: "polygon(0 0, 100% 0, 50% 100%)",
        pointerEvents: "none",
        zIndex: 6,
      }}
    />
  );
}

/** A thin drop-zone strip above the top track / below the bottom track. Dragging a
 *  clip of the matching kind into it creates a new track and moves the clip onto it.
 *  Subtly dashed at rest; gold when a matching drag is over it. */
function GutterDropZone({
  side,
  active,
  dragActive,
  onMediaDrop,
}: {
  side: "top" | "bottom";
  active: boolean;
  /** True while ANY drag that could land here is in flight (an internal clip move
   *  or a media drag) — lights the zone up so it's discoverable. */
  dragActive: boolean;
  onMediaDrop: (side: "top" | "bottom", e: React.DragEvent, stripEl: HTMLElement) => void;
}) {
  const [mediaOver, setMediaOver] = useState(false);
  const lit = active || mediaOver;
  return (
    <div style={{ display: "flex", height: GUTTER_H }}>
      {/* frozen spacer under the header column */}
      <div
        style={{
          width: GUTTER,
          flex: "0 0 auto",
          position: "sticky",
          left: 0,
          zIndex: 7,
          display: "flex",
          alignItems: "center",
          paddingLeft: 10,
          background: "var(--vean-header-bg)",
          borderRight: "1px solid var(--vean-border-faint)",
          fontSize: 9,
          fontFamily: "ui-monospace, monospace",
          letterSpacing: "0.08em",
          color: lit
            ? "var(--vean-gold)"
            : dragActive
              ? "var(--vean-fg-2)"
              : "color-mix(in srgb, var(--vean-fg-3) 60%, transparent)",
        }}
      >
        + {side === "top" ? "V" : "A"}
      </div>
      <div
        title={
          side === "top"
            ? "drop a video clip or media here → new video track above"
            : "drop an audio clip or media here → new audio track below"
        }
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(MEDIA_DRAG_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setMediaOver(true);
          }
        }}
        onDragLeave={() => setMediaOver(false)}
        onDrop={(e) => {
          setMediaOver(false);
          onMediaDrop(side, e, e.currentTarget as HTMLElement);
        }}
        style={{
          flex: 1,
          background: lit ? "color-mix(in srgb, var(--vean-gold) 18%, transparent)" : "transparent",
          border: `1px dashed ${lit ? "var(--vean-gold)" : dragActive ? "color-mix(in srgb, var(--vean-gold) 35%, transparent)" : "color-mix(in srgb, var(--vean-fg-1) 8%, transparent)"}`,
          borderLeft: "none",
          borderRight: "none",
          transition: "background 120ms, border-color 120ms",
        }}
      />
    </div>
  );
}

/** One interactive track lane = one track row. Renders its placed items (with a
 *  live rubber-band override for the dragged clip) and routes pointer events to the
 *  gesture handlers. The label gutter (V1/A1) is fixed at the left. */
interface TrackLaneProps {
  track: Track;
  timeline: TimelineEditor["timeline"];
  pxPerFrame: number;
  selectedId: string | null;
  diagnosticsByClip: Map<string, Diagnostic[]>;
  drag: DragState | null;
  entryId: string | undefined;
  editMode: { clipId: string; target: EditTarget } | null;
  optionRefs: React.RefObject<Map<string, HTMLDivElement>>;
  onClipFocus: (id: string) => void;
  onClipKeyDown: (event: React.KeyboardEvent<HTMLDivElement>, id: string) => void;
  onClipKeyUp: (event: React.KeyboardEvent<HTMLDivElement>, id: string) => void;
  onClipPointerDown: (e: React.PointerEvent, placed: PlacedItem, track: Track) => void;
  onBackgroundPointerDown: () => void;
  /** Active route — passed to ClipBlock so audio clips can fetch their waveform. */
  route?: string;
  /** Monitor mute/hide state for this track (dims the lane; the toggle itself lives
   *  in TimelineStrip's frozen rail, outside the listbox). */
  previewMuted: boolean;
  /** A media drag dropped on this lane (from the Media panel / source monitor). */
  onMediaDrop: (track: Track, e: React.DragEvent, laneEl: HTMLElement) => void;
}

function TrackLane({
  track,
  timeline,
  pxPerFrame,
  selectedId,
  diagnosticsByClip,
  drag,
  entryId,
  editMode,
  optionRefs,
  onClipFocus,
  onClipKeyDown,
  onClipKeyUp,
  onClipPointerDown,
  onBackgroundPointerDown,
  route,
  previewMuted,
  onMediaDrop,
}: TrackLaneProps) {
  const placed = placeItems(track);
  const label = track.name ?? track.id;
  const previewed = applyPreview(placed, drag);

  return (
    // A fieldset would add form semantics that do not exist; this is a row group
    // inside a composite listbox.
    // biome-ignore lint/a11y/useSemanticElements: timeline track is an ARIA group.
    <div
      role="group"
      aria-label={trackLabel(track, timeline)}
      style={{
        display: "flex",
        height: trackH(track),
        borderBottom: "1px solid var(--vean-border-faint)",
      }}
    >
      {/* FROZEN header column — sticky against horizontal scroll; the lanes slide
          under it (the Premiere frozen-gutter feel). */}
      <div
        style={{
          width: GUTTER,
          flex: "0 0 auto",
          position: "sticky",
          left: 0,
          zIndex: 7,
          display: "flex",
          alignItems: "center",
          gap: 6,
          paddingLeft: 10,
          paddingRight: 4,
          fontSize: 11,
          fontFamily: "ui-monospace, monospace",
          color: track.kind === "audio" ? "var(--vean-track-audio)" : "var(--vean-track-video)",
          background: "var(--vean-header-bg)",
          borderRight: "1px solid var(--vean-border-faint)",
          overflow: "hidden",
        }}
      >
        {track.kind === "audio" ? (
          <AudioLines size={13} strokeWidth={1.75} style={{ flexShrink: 0 }} />
        ) : (
          <Film size={13} strokeWidth={1.75} style={{ flexShrink: 0 }} />
        )}
        <span
          style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {label}
        </span>
        {/* Reserve the eye/speaker slot — the toggle itself renders in the frozen
            rail OUTSIDE the listbox (see TimelineStrip) so listbox>group children
            stay pure options. */}
        <span style={{ width: 20, flexShrink: 0 }} aria-hidden />
      </div>
      {/* Lane background: a pointerdown here (not on a clip) deselects. Also the
          drop target for media drags (Media panel tiles / the source monitor chip). */}
      <div
        style={{
          position: "relative",
          flex: 1,
          background: "var(--vean-bg)",
          opacity: previewMuted ? 0.45 : 1,
        }}
        onPointerDown={onBackgroundPointerDown}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(MEDIA_DRAG_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => onMediaDrop(track, e, e.currentTarget as HTMLElement)}
      >
        {previewed.map((p, i) => {
          const isClip = p.item.kind === "clip";
          const uuid = isClip ? (p.item as { id: string }).id : null;
          const selected = uuid != null && uuid === selectedId;
          const beingDragged = drag != null && uuid === drag.gesture.uuid;
          // A MOVE leaves the clip DIMMED at its origin while a translucent ghost
          // (MoveOverlay, on the TARGET lane) shows where it will land — so a
          // cross-track drop reads correctly. Other tools preview in place.
          const isMoveSource = beingDragged && drag?.moved && drag?.gesture.tool === "move";
          const diags = uuid ? diagnosticsByClip.get(uuid) : undefined;
          const readout = beingDragged && drag?.moved ? gestureReadout(drag, p) : null;
          const clip = uuid ? findClip(timeline, uuid) : null;
          const blockingCount =
            (uuid ? diagnosticsByClip.get(uuid) : undefined)?.filter(
              (diagnostic) => diagnostic.severity === "error",
            ).length ?? 0;
          // Same-track flush neighbours decide whether an edge hover reads as a
          // roll (col-resize) or a trim (ew-resize).
          const prev = i > 0 ? placed[i - 1] : null;
          const next = i < placed.length - 1 ? placed[i + 1] : null;
          const hasLeftClip = prev?.item.kind === "clip";
          const hasRightClip = next?.item.kind === "clip";
          return (
            <ClipBlock
              key={`${track.id}-${i}`}
              placed={p}
              pxPerFrame={pxPerFrame}
              kind={track.kind}
              selected={selected}
              diagnostics={diags}
              readout={readout}
              accessibleName={clip ? clipAccessibleName(clip, timeline, blockingCount) : undefined}
              tabIndex={uuid === entryId ? 0 : -1}
              editMode={uuid === editMode?.clipId}
              editTarget={uuid === editMode?.clipId ? editMode.target : undefined}
              optionRef={
                uuid
                  ? (node) => {
                      if (node) optionRefs.current.set(uuid, node);
                      else optionRefs.current.delete(uuid);
                    }
                  : undefined
              }
              onFocus={uuid ? () => onClipFocus(uuid) : undefined}
              onKeyDown={uuid ? (event) => onClipKeyDown(event, uuid) : undefined}
              onKeyUp={uuid ? (event) => onClipKeyUp(event, uuid) : undefined}
              dragging={isMoveSource}
              cursor={isClip ? "grab" : "default"}
              route={route}
              {...(isClip
                ? {
                    onPointerDown: (e: React.PointerEvent) => {
                      // Capture the ORIGINAL (un-previewed) placement for gesture math.
                      onClipPointerDown(e, p.base ?? p, track);
                      // Set the cursor for the live drag immediately.
                      (e.currentTarget as HTMLElement).style.cursor = hoverCursor(
                        e,
                        e.altKey,
                        e.metaKey,
                        hasLeftClip,
                        hasRightClip,
                      );
                    },
                    onPointerMove: (e: React.PointerEvent) => {
                      // Hover affordance: only when NOT mid-drag (drag owns the lane cursor).
                      if (drag) return;
                      (e.currentTarget as HTMLElement).style.cursor = hoverCursor(
                        e,
                        e.altKey,
                        e.metaKey,
                        hasLeftClip,
                        hasRightClip,
                      );
                    },
                  }
                : {})}
            />
          );
        })}
        {/* MOVE overlay: drawn on the SOURCE lane (a dashed origin outline) and on
            the TARGET lane (the translucent ghost shell + a red wash over content the
            drop will OVERWRITE). Same lane when it's a same-track move. */}
        {drag?.moved &&
        drag.gesture.tool === "move" &&
        (drag.gesture.trackId === track.id || drag.toTrackId === track.id) ? (
          <MoveOverlay track={track} drag={drag} placed={placed} pxPerFrame={pxPerFrame} />
        ) : null}
      </div>
    </div>
  );
}

/** The live MOVE affordance, drawn PER LANE for the track it's rendered in:
 *   • on the SOURCE lane — a dashed outline at the clip's ORIGIN (where it leaves);
 *   • on the TARGET lane — the translucent ghost SHELL at the drop position (a real
 *     `ClipBlock ghost`, so it carries the label + readout) PLUS a red wash over every
 *     clip the shell will OVERWRITE (the destructive drop, previewed before release —
 *     non-ripple move stamps over content). The two coincide on a same-track move.
 *  `placed` is this lane's RAW (un-previewed) items — so collision math on the target
 *  lane is against that lane's real content. Purely visual; pointer-transparent. */
function MoveOverlay({
  track,
  drag,
  placed,
  pxPerFrame,
}: {
  track: Track;
  drag: DragState;
  placed: PlacedItem[];
  pxPerFrame: number;
}) {
  const g = drag.gesture;
  const isSource = g.trackId === track.id;
  const isTarget = drag.toTrackId === track.id;
  const target = Math.max(0, g.placed.start + drag.dxFrames);
  const len = g.placed.length;

  const collisions: Array<{ start: number; width: number }> = [];
  if (isTarget) {
    for (const p of placed) {
      if (p.item.kind !== "clip") continue;
      if ((p.item as { id: string }).id === g.uuid) continue; // its own origin isn't overwritten
      const iStart = Math.max(target, p.start);
      const iEnd = Math.min(target + len, p.start + p.length);
      if (iEnd > iStart) collisions.push({ start: iStart, width: iEnd - iStart });
    }
  }

  return (
    <>
      {isSource ? (
        <div
          style={{
            position: "absolute",
            left: g.placed.start * pxPerFrame,
            width: g.placed.length * pxPerFrame,
            top: 2,
            bottom: 2,
            border: "1px dashed var(--vean-border-bright)",
            borderRadius: 4,
            background: "rgba(0,0,0,0.22)",
            pointerEvents: "none",
            zIndex: 0,
          }}
        />
      ) : null}
      {isTarget ? (
        <>
          {collisions.map((c) => (
            <div
              key={`ov-${c.start}`}
              title="this content will be overwritten"
              style={{
                position: "absolute",
                left: c.start * pxPerFrame,
                width: c.width * pxPerFrame,
                top: 2,
                bottom: 2,
                background: "color-mix(in srgb, var(--vean-red) 28%, transparent)",
                border: "1px solid color-mix(in srgb, var(--vean-red) 70%, transparent)",
                borderRadius: 4,
                pointerEvents: "none",
                zIndex: 4,
              }}
            />
          ))}
          <ClipBlock
            placed={{ item: g.placed.item, start: target, length: len }}
            pxPerFrame={pxPerFrame}
            kind={track.kind}
            ghost
            readout={`→ ${target}f${isSource ? "" : ` · ${track.name ?? track.id}`}`}
          />
        </>
      ) : null}
    </>
  );
}

/** A placed item plus (optionally) its un-previewed base, so the pointerdown
 *  handler can capture the clip's ORIGINAL placement for the gesture math. */
type PreviewedItem = PlacedItem & { base?: PlacedItem };

/**
 * Apply the live gesture to a track's placed items, returning a rubber-banded copy
 * for rendering. This is PURELY VISUAL — the authoritative result comes from the
 * server on commit; here we just give immediate feedback. Frame-exact integer math.
 *
 *   • move / slide → shift the dragged clip's `start` by dxFrames.
 *   • trimIn       → move start + shrink/grow length by dxFrames (head).
 *   • trimOut      → grow/shrink length by dxFrames (tail).
 *   • roll         → move the seam: the left half's tail and the right half's head.
 *   • slip         → no position change (the readout shows the source window shift).
 */
function applyPreview(placed: PlacedItem[], drag: DragState | null): PreviewedItem[] {
  if (!drag) return placed;
  const { gesture: g, dxFrames } = drag;
  if (dxFrames === 0) return placed;

  // Identity by clip id (robust against PlacedItem wrapper churn between renders).
  const clipId = (p: PlacedItem): string | null =>
    p.item.kind === "clip" ? (p.item as { id: string }).id : null;
  const seamLeftId = g.tool === "roll" && g.neighbours.left ? clipId(g.neighbours.left) : null;
  const seamRightId = g.tool === "roll" && g.neighbours.right ? clipId(g.neighbours.right) : null;

  return placed.map((p) => {
    const id = clipId(p);
    if (id == null) return p;

    // Roll: BOTH seam halves move (left tail grows, right head retracts), so the
    // total duration is conserved. Handled by id so it covers the dragged clip and
    // its partner uniformly.
    if (g.tool === "roll") {
      if (id === seamLeftId) return { ...p, base: p, length: Math.max(1, p.length + dxFrames) };
      if (id === seamRightId)
        return {
          ...p,
          base: p,
          start: p.start + dxFrames,
          length: Math.max(1, p.length - dxFrames),
        };
      return p;
    }

    if (id !== g.uuid) return p;
    switch (g.tool) {
      case "move":
        // A MOVE does NOT rubber-band the clip in place — it stays dimmed at its
        // ORIGIN while a translucent ghost (MoveOverlay, on the TARGET lane) shows
        // where it will land. This is what makes a cross-track drop previewable.
        return { ...p, base: p };
      case "slide":
        return { ...p, base: p, start: Math.max(0, p.start + dxFrames) };
      case "trimIn": {
        // +dx trims the head (later start, shorter); −dx extends it.
        const newLen = Math.max(1, p.length - dxFrames);
        const newStart = Math.max(0, p.start + (p.length - newLen));
        return { ...p, base: p, start: newStart, length: newLen };
      }
      case "trimOut": {
        // +dx extends the tail; −dx shortens it.
        return { ...p, base: p, length: Math.max(1, p.length + dxFrames) };
      }
      default:
        // slip: no position/length change (the readout shows the window shift).
        return { ...p, base: p };
    }
  });
}

/** The hover cursor for a pointer over a clip: ew-resize near an edge that trims,
 *  col-resize near an edge that rolls (a flush same-track clip there), grabbing for
 *  a slip/slide body, grab otherwise. Reads the pointer's local X off the clip box. */
function hoverCursor(
  e: React.PointerEvent,
  alt: boolean,
  meta: boolean,
  hasLeftClip: boolean,
  hasRightClip: boolean,
): string {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const localX = e.clientX - rect.left;
  const { zone, bodyTool } = resolveGesture(localX, rect.width, { alt, meta });
  if (zone === "left-edge") return hasLeftClip ? "col-resize" : "ew-resize";
  if (zone === "right-edge") return hasRightClip ? "col-resize" : "ew-resize";
  if (bodyTool === "slip" || bodyTool === "slide") return "grabbing";
  return "grab";
}

/** The transient readout for a live gesture over the dragged clip (DaVinci-style):
 *  the in/out for a slip, the delta for a trim/roll, the new position for a move. */
function gestureReadout(drag: DragState, previewed: PlacedItem): string | null {
  const { gesture: g, dxFrames } = drag;
  const item = g.placed.item;
  if (item.kind !== "clip") return null;
  switch (g.tool) {
    case "slip": {
      const newIn = item.in - dxFrames; // slip delta = −dxFrames
      const newOut = item.out - dxFrames;
      return `slip src[${newIn} → ${newOut}]`;
    }
    case "trimIn":
      return `in ${dxFrames > 0 ? "+" : ""}${dxFrames}f`;
    case "trimOut":
      return `out ${dxFrames > 0 ? "+" : ""}${dxFrames}f`;
    case "roll":
      return `roll ${dxFrames > 0 ? "+" : ""}${dxFrames}f`;
    case "move":
      // A move's readout rides the ghost shell (MoveOverlay), not the dimmed origin.
      return null;
    case "slide":
      return `slide → ${previewed.start}f`;
    default:
      return null;
  }
}

/** A quiet square icon button for the timeline toolbar — the shadcn Button in its
 *  iconSm ghost form; gold when `active`. The words live in the tooltip/aria-label. */
function IconBtn({
  onClick,
  disabled,
  active,
  pressed,
  label,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  pressed?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Button
      size="iconSm"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={active ? "text-primary hover:text-primary" : undefined}
    >
      {children}
    </Button>
  );
}
