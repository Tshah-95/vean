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
// ZOOM MODEL (Premiere-style): "Fit" sizes the whole timeline to the pane; zoom in
// magnifies; zoom out shrinks below fit. The ruler picks a "nice" interval + label
// format from the scale. +/− buttons, a Fit button, and =/−/\ keys.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useClockInstance } from "../ClockProvider";
import {
  type Gesture,
  type Tool,
  buildInvocation,
  cursorFor,
  resolveGesture,
  snapFrame,
} from "../timelineGestures";
import type { Diagnostic, PlacedItem, Track } from "../types";
import { placeItems } from "../types";
import type { TimelineEditor } from "../useTimelineEditor";
import { ClipBlock } from "./ClipBlock";
import { Playhead } from "./Playhead";

const GUTTER = 56;
const ROW_HEIGHT = 34;
const RULER_HEIGHT = 36; // taller: reads as a dedicated control strip (the scrub zone)
const MIN_TICK_PX = 64; // ruler ticks stay at least this far apart
const MAX_PX_PER_FRAME = 60; // zoom-in ceiling (frame-level granularity)
const MIN_ZOOM = 0.25; // zoom-out floor (quarter of fit)
const STEP = 1.6; // per-click zoom factor

export interface TimelineStripProps {
  editor: TimelineEditor;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

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
}

export function TimelineStrip({ editor }: TimelineStripProps) {
  const { timeline, totalFrames, selectedId, diagnosticsByClip } = editor;
  const clock = useClockInstance();
  const laneRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1); // 1 = Fit; <1 zoomed out; >1 zoomed in
  const [paneWidth, setPaneWidth] = useState(900);
  const scrubbing = useRef(false);
  const prevZoom = useRef(1);
  const [drag, setDrag] = useState<DragState | null>(null);

  useEffect(() => {
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
  const fitPxPerFrame = contentWidth / Math.max(1, totalFrames);
  const maxZoom = Math.max(4, MAX_PX_PER_FRAME / fitPxPerFrame);
  const pxPerFrame = fitPxPerFrame * zoom;
  const laneWidth = GUTTER + totalFrames * pxPerFrame;

  const zoomIn = useCallback(() => setZoom((z) => clamp(z * STEP, MIN_ZOOM, maxZoom)), [maxZoom]);
  const zoomOut = useCallback(() => setZoom((z) => clamp(z / STEP, MIN_ZOOM, maxZoom)), [maxZoom]);
  const zoomFit = useCallback(() => setZoom(1), []);
  const atFit = Math.abs(zoom - 1) < 0.01;

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

  // Keep the playhead centred when zoom changes.
  useLayoutEffect(() => {
    const el = laneRef.current;
    if (!el || prevZoom.current === zoom) return;
    const frame = clock.getSnapshot().currentFrame;
    const x = GUTTER + frame * pxPerFrame;
    el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
    prevZoom.current = zoom;
  }, [zoom, pxPerFrame, clock]);

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
    const draggedUuid = drag?.gesture.uuid;
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
  }, [timeline, drag, clock]);

  // ── Clip gesture: pointerdown selects + begins the contextual drag ──────────
  const onClipPointerDown = useCallback(
    (e: React.PointerEvent, placed: PlacedItem, track: Track) => {
      if (placed.item.kind !== "clip") return;
      e.stopPropagation(); // don't let the lane deselect
      const uuid = placed.item.id;
      editor.select(uuid);

      const target = e.currentTarget as HTMLElement;
      const rect = target.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const widthPx = rect.width;
      const mods = { alt: e.altKey, meta: e.metaKey };
      const { zone, bodyTool } = resolveGesture(localX, widthPx, mods);

      // Resolve same-track neighbours (for roll + readouts).
      const placedTrack = placeItems(track);
      const idx = placedTrack.findIndex(
        (p) => p.item.kind === "clip" && p.item.id === uuid,
      );
      const prev = idx > 0 ? placedTrack[idx - 1] : null;
      const next = idx >= 0 && idx < placedTrack.length - 1 ? placedTrack[idx + 1] : null;
      const leftClip = prev && prev.item.kind === "clip" ? prev : null;
      const rightClip = next && next.item.kind === "clip" ? next : null;

      // An EDGE grab with a flush same-track clip on that side becomes a ROLL
      // (a roll needs the pair). A lone edge is a TRIM. The roll's seam pair is
      // (left-half, right-half) flush at the grabbed boundary:
      //   • left edge  → seam between leftClip (left half) and this clip (right half)
      //   • right edge → seam between this clip (left half) and rightClip (right half)
      let tool: Tool;
      let seamLeft: PlacedItem | null = null;
      let seamRight: PlacedItem | null = null;
      if (zone === "left-edge") {
        if (leftClip) {
          tool = "roll";
          seamLeft = leftClip;
          seamRight = placed;
        } else {
          tool = "trimIn";
        }
      } else if (zone === "right-edge") {
        if (rightClip) {
          tool = "roll";
          seamLeft = placed;
          seamRight = rightClip;
        } else {
          tool = "trimOut";
        }
      } else {
        tool = bodyTool;
      }

      const gesture: Gesture = {
        tool,
        uuid,
        trackId: track.id,
        placed,
        neighbours: { left: seamLeft, right: seamRight },
        ripple: mods.alt && (tool === "trimIn" || tool === "trimOut" || tool === "move"),
      };

      target.setPointerCapture?.(e.pointerId);
      setDrag({
        gesture,
        startClientX: e.clientX,
        dxFrames: 0,
        snappedTo: null,
        ripple: gesture.ripple,
      });
    },
    [editor],
  );

  const onLanePointerMove = useCallback(
    (e: React.PointerEvent) => {
      setDrag((d) => {
        if (!d) return d;
        const rawFrames = Math.round((e.clientX - d.startClientX) / pxPerFrame);
        // Snap the MOVED EDGE to nearby candidates (move/slide: the clip start;
        // trimIn/roll: the head; trimOut: the tail). Snapping is on the resulting
        // edge frame, then converted back to a delta.
        const g = d.gesture;
        let anchor: number; // the edge frame this gesture moves, pre-snap
        if (g.tool === "move" || g.tool === "slide") anchor = g.placed.start + rawFrames;
        else if (g.tool === "trimIn") anchor = g.placed.start + rawFrames;
        else if (g.tool === "trimOut") anchor = g.placed.start + g.placed.length + rawFrames;
        else if (g.tool === "roll") {
          // The seam sits at the right half's start (= left half's end).
          const seamBase = g.neighbours.right?.start ?? g.placed.start;
          anchor = seamBase + rawFrames;
        } else anchor = g.placed.start + rawFrames; // slip: no snap meaning, keep raw
        let dxFrames = rawFrames;
        let snappedTo: number | null = null;
        if (g.tool !== "slip") {
          const snapped = snapFrame(anchor, snapCandidates, pxPerFrame);
          if (snapped.snappedTo != null) {
            dxFrames = rawFrames + (snapped.frame - anchor);
            snappedTo = snapped.snappedTo;
          }
        }
        // Clamp move/slide so the clip start never goes negative.
        if (g.tool === "move" || g.tool === "slide") {
          dxFrames = Math.max(dxFrames, -g.placed.start);
        }
        return { ...d, dxFrames, snappedTo };
      });
    },
    [pxPerFrame, snapCandidates],
  );

  const onLanePointerUp = useCallback(() => {
    setDrag((d) => {
      if (!d) return null;
      const inv = buildInvocation(d.gesture, d.dxFrames, d.ripple);
      if (inv) void editor.commit(inv);
      return null;
    });
  }, [editor]);

  // Deselect on a pointerdown in empty lane area (not on a clip).
  const onLaneBackgroundPointerDown = useCallback(() => {
    editor.select(null);
  }, [editor]);

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
    const out: Array<{ frame: number; text: string }> = [];
    for (let f = 0; f <= totalFrames; f += framesPerTick) out.push({ frame: f, text: label(f) });
    return out;
  }, [totalFrames, framesPerTick, label]);

  const cursor = drag ? cursorFor(drag.gesture.tool) : "default";

  return (
    <div style={{ display: "flex", flexDirection: "column", background: "#0a0b0f" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          fontSize: 11,
          color: "#6b7280",
          borderBottom: "1px solid #14171f",
        }}
      >
        <span>timeline</span>
        {drag ? (
          <span style={{ color: "#c7ae7a", fontFamily: "ui-monospace, monospace" }}>
            {drag.gesture.tool}
            {drag.ripple ? " · ripple" : ""}
          </span>
        ) : null}

        {/* Edit controls — blade, undo/redo, save, and the dirty/saved indicator. */}
        <div style={{ width: 8 }} />
        <button
          type="button"
          onClick={onBlade}
          disabled={!selectedId}
          style={{ ...zoomBtn, width: "auto", padding: "0 8px" }}
          aria-label="Blade (split) at playhead"
          title="Blade — split the selected clip at the playhead ( B )"
        >
          ⫶ Blade
        </button>
        <button type="button" onClick={editor.undo} disabled={!editor.canUndo} style={zoomBtn} aria-label="Undo" title="Undo ( ⌘Z )">
          ↶
        </button>
        <button type="button" onClick={editor.redo} disabled={!editor.canRedo} style={zoomBtn} aria-label="Redo" title="Redo ( ⌘⇧Z )">
          ↷
        </button>
        <button
          type="button"
          onClick={editor.save}
          disabled={!editor.dirty && !editor.justSaved}
          style={{
            ...zoomBtn,
            width: "auto",
            padding: "0 8px",
            color: editor.justSaved ? "#7fd99a" : editor.dirty ? "#e2c275" : "#6b7280",
            borderColor: editor.dirty ? "#5a4a1f" : "#2a2e3a",
          }}
          aria-label="Save"
          title="Save to disk ( ⌘S )"
        >
          {editor.justSaved ? "✓ Saved" : editor.dirty ? "● Save" : "Save"}
        </button>
        {editor.lastError ? (
          <span
            style={{ color: "#e08585", fontFamily: "ui-monospace, monospace", fontSize: 10 }}
            title={editor.lastError}
          >
            {editor.lastError.length > 36 ? `${editor.lastError.slice(0, 33)}…` : editor.lastError}
          </span>
        ) : null}

        <div style={{ flex: 1 }} />
        <button type="button" onClick={zoomOut} disabled={zoom <= MIN_ZOOM + 1e-6} style={zoomBtn} aria-label="Zoom out" title="Zoom out ( − )">
          −
        </button>
        <button
          type="button"
          onClick={zoomFit}
          style={{ ...zoomBtn, width: "auto", padding: "0 8px", color: atFit ? "#c7ae7a" : "#9aa0ae" }}
          aria-label="Zoom to fit"
          title="Zoom to fit ( \\ )"
        >
          Fit
        </button>
        <button type="button" onClick={zoomIn} disabled={zoom >= maxZoom - 1e-6} style={zoomBtn} aria-label="Zoom in" title="Zoom in ( = )">
          +
        </button>
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
        <div style={{ width: laneWidth, position: "relative" }}>
          {/* Ruler — the ONLY scrub zone. Distinct background + a CTI flag handle. */}
          <div
            style={{
              display: "flex",
              height: RULER_HEIGHT,
              position: "relative",
              background: "#11141b",
              borderBottom: "1px solid #232838",
              cursor: "ew-resize",
            }}
            onPointerDown={onRulerPointerDown}
            onPointerMove={onRulerPointerMove}
            onPointerUp={onRulerPointerUp}
            onPointerLeave={onRulerPointerUp}
          >
            <div style={{ width: GUTTER, flex: "0 0 auto", background: "#0d0f14", borderRight: "1px solid #1b1e26", cursor: "default" }} />
            <div style={{ position: "relative", flex: 1 }}>
              {ticks.map((t) => (
                <div
                  key={t.frame}
                  style={{
                    position: "absolute",
                    left: t.frame * pxPerFrame,
                    top: 0,
                    bottom: 0,
                    borderLeft: "1px solid #232838",
                    paddingLeft: 4,
                    paddingTop: 3,
                    fontSize: 10,
                    color: "#6b7280",
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

          {/* Tracks: video (top) then audio. */}
          {timeline.tracks.video.map((track) => (
            <TrackLane
              key={track.id}
              track={track}
              pxPerFrame={pxPerFrame}
              selectedId={selectedId}
              diagnosticsByClip={diagnosticsByClip}
              drag={drag}
              onClipPointerDown={onClipPointerDown}
              onBackgroundPointerDown={onLaneBackgroundPointerDown}
            />
          ))}
          {timeline.tracks.audio.map((track) => (
            <TrackLane
              key={track.id}
              track={track}
              pxPerFrame={pxPerFrame}
              selectedId={selectedId}
              diagnosticsByClip={diagnosticsByClip}
              drag={drag}
              onClipPointerDown={onClipPointerDown}
              onBackgroundPointerDown={onLaneBackgroundPointerDown}
            />
          ))}

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
                borderLeft: "1px dashed #7fd9c0",
                opacity: 0.8,
                pointerEvents: "none",
                zIndex: 4,
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The CTI (current-time indicator) flag handle docked in the ruler — the explicit
 *  grab target for scrubbing. A downward triangle pinned to the playhead frame. */
function CtiHandle({ pxPerFrame }: { pxPerFrame: number }) {
  const clock = useClockInstance();
  const [frame, setFrame] = useState(clock.getSnapshot().currentFrame);
  useEffect(() => clock.subscribe(() => setFrame(clock.getSnapshot().currentFrame)), [clock]);
  return (
    <div
      style={{
        position: "absolute",
        left: frame * pxPerFrame,
        top: 0,
        transform: "translateX(-50%)",
        width: 13,
        height: 13,
        background: "#e2574c",
        clipPath: "polygon(0 0, 100% 0, 50% 100%)",
        pointerEvents: "none",
        zIndex: 6,
        filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.5))",
      }}
    />
  );
}

/** One interactive track lane = one track row. Renders its placed items (with a
 *  live rubber-band override for the dragged clip) and routes pointer events to the
 *  gesture handlers. The label gutter (V1/A1) is fixed at the left. */
interface TrackLaneProps {
  track: Track;
  pxPerFrame: number;
  selectedId: string | null;
  diagnosticsByClip: Map<string, Diagnostic[]>;
  drag: DragState | null;
  onClipPointerDown: (e: React.PointerEvent, placed: PlacedItem, track: Track) => void;
  onBackgroundPointerDown: () => void;
}

function TrackLane({
  track,
  pxPerFrame,
  selectedId,
  diagnosticsByClip,
  drag,
  onClipPointerDown,
  onBackgroundPointerDown,
}: TrackLaneProps) {
  const placed = placeItems(track);
  const label = track.name ?? track.id;
  const previewed = applyPreview(placed, drag);

  return (
    <div style={{ display: "flex", height: ROW_HEIGHT, borderBottom: "1px solid #14171f" }}>
      <div
        style={{
          width: GUTTER,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          paddingLeft: 10,
          fontSize: 11,
          fontFamily: "ui-monospace, monospace",
          color: track.kind === "audio" ? "#7fd9c0" : "#9ab4d9",
          background: "#0d0f14",
          borderRight: "1px solid #1b1e26",
        }}
      >
        {label}
      </div>
      {/* Lane background: a pointerdown here (not on a clip) deselects. */}
      <div
        style={{ position: "relative", flex: 1, background: "#0a0b0f" }}
        onPointerDown={onBackgroundPointerDown}
      >
        {previewed.map((p, i) => {
          const isClip = p.item.kind === "clip";
          const uuid = isClip ? (p.item as { id: string }).id : null;
          const selected = uuid != null && uuid === selectedId;
          const beingDragged = drag != null && uuid === drag.gesture.uuid;
          const diags = uuid ? diagnosticsByClip.get(uuid) : undefined;
          const readout = beingDragged && drag ? gestureReadout(drag, p) : null;
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
              dragging={false}
              cursor={isClip ? "grab" : "default"}
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
      </div>
    </div>
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
  const seamLeftId =
    g.tool === "roll" && g.neighbours.left ? clipId(g.neighbours.left) : null;
  const seamRightId =
    g.tool === "roll" && g.neighbours.right ? clipId(g.neighbours.right) : null;

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
    case "slide":
      return `${g.tool} → ${previewed.start}f`;
    default:
      return null;
  }
}

const zoomBtn: React.CSSProperties = {
  height: 20,
  minWidth: 22,
  borderRadius: 4,
  border: "1px solid #2a2e3a",
  background: "#161922",
  color: "#9aa0ae",
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1,
};
