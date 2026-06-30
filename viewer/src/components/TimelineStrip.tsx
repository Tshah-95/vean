// The timeline strip — drawn purely from the parsed IR. Video tracks (top→bottom)
// then audio tracks, an adaptive time ruler, and a draggable playhead. Click/drag
// in the lane area seeks the master clock (scrub).
//
// ZOOM MODEL (Premiere-style):
//   • "Fit" (the default) sizes the whole timeline to the actual pane width — no
//     horizontal scroll in the base case.
//   • Zoom IN magnifies (each frame gets wider) for granular edits/inspection; the
//     lane scrolls and zoom keeps the playhead centred.
//   • Zoom OUT shrinks below fit (clips compress, empty space to the right) for an
//     overview.
//   • The ruler picks a "nice" interval and label format (frames → seconds →
//     minutes) from the current scale, so the LABELS change with zoom.
//   • +/− buttons, a Fit button, and keyboard =/−/\ (Premiere's zoom-to-fit).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useClockInstance } from "../ClockProvider";
import type { Timeline } from "../types";
import { Playhead } from "./Playhead";
import { TrackRow } from "./TrackRow";

const GUTTER = 56;
const ROW_HEIGHT = 34;
const RULER_HEIGHT = 22;
const MIN_TICK_PX = 64; // ruler ticks stay at least this far apart
const MAX_PX_PER_FRAME = 60; // zoom-in ceiling (frame-level granularity)
const MIN_ZOOM = 0.25; // zoom-out floor (quarter of fit)
const STEP = 1.6; // per-click zoom factor

export interface TimelineStripProps {
  timeline: Timeline;
  totalFrames: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Adaptive ruler interval (in frames) + a label formatter, chosen so ticks are
 *  ≥ MIN_TICK_PX apart. Sub-second intervals read as `s:ff` (seconds:frames),
 *  whole seconds as `Ns`, and ≥1min as `m:ss`. */
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

export function TimelineStrip({ timeline, totalFrames }: TimelineStripProps) {
  const clock = useClockInstance();
  const laneRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1); // 1 = Fit; <1 zoomed out; >1 zoomed in
  const [paneWidth, setPaneWidth] = useState(900);
  const scrubbing = useRef(false);
  const prevZoom = useRef(1);

  // Measure the real pane width so "Fit" actually fits — and re-measure on resize.
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

  // Keep the playhead centred when zoom changes (Premiere zooms around the head).
  useLayoutEffect(() => {
    const el = laneRef.current;
    if (!el || prevZoom.current === zoom) return;
    const frame = clock.getSnapshot().currentFrame;
    const x = GUTTER + frame * pxPerFrame;
    el.scrollLeft = Math.max(0, x - el.clientWidth / 2);
    prevZoom.current = zoom;
  }, [zoom, pxPerFrame, clock]);

  const frameFromEvent = useCallback(
    (clientX: number): number => {
      const el = laneRef.current;
      if (!el) return 0;
      const rect = el.getBoundingClientRect();
      const x = clientX - rect.left - GUTTER + el.scrollLeft;
      return Math.max(0, Math.min(Math.round(x / pxPerFrame), totalFrames - 1));
    },
    [pxPerFrame, totalFrames],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      scrubbing.current = true;
      clock.pause();
      clock.seekTo(frameFromEvent(e.clientX));
      (e.target as Element).setPointerCapture?.(e.pointerId);
    },
    [clock, frameFromEvent],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!scrubbing.current) return;
      clock.seekTo(frameFromEvent(e.clientX));
    },
    [clock, frameFromEvent],
  );

  const onPointerUp = useCallback(() => {
    scrubbing.current = false;
  }, []);

  const { framesPerTick, label } = useMemo(
    () => rulerScale(pxPerFrame, fpsWhole),
    [pxPerFrame, fpsWhole],
  );
  const ticks = useMemo(() => {
    const out: Array<{ frame: number; text: string }> = [];
    for (let f = 0; f <= totalFrames; f += framesPerTick) out.push({ frame: f, text: label(f) });
    return out;
  }, [totalFrames, framesPerTick, label]);

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
        style={{ position: "relative", overflowX: "auto", overflowY: "hidden" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div style={{ width: laneWidth, position: "relative" }}>
          {/* Ruler */}
          <div style={{ display: "flex", height: RULER_HEIGHT, position: "relative" }}>
            <div style={{ width: GUTTER, flex: "0 0 auto", background: "#0d0f14", borderRight: "1px solid #1b1e26" }} />
            <div style={{ position: "relative", flex: 1 }}>
              {ticks.map((t) => (
                <div
                  key={t.frame}
                  style={{
                    position: "absolute",
                    left: t.frame * pxPerFrame,
                    top: 0,
                    bottom: 0,
                    borderLeft: "1px solid #1b1e26",
                    paddingLeft: 4,
                    fontSize: 10,
                    color: "#4b5563",
                    fontFamily: "ui-monospace, monospace",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t.text}
                </div>
              ))}
            </div>
          </div>

          {/* Tracks: video (top) then audio. */}
          {timeline.tracks.video.map((track) => (
            <TrackRow key={track.id} track={track} pxPerFrame={pxPerFrame} rowHeight={ROW_HEIGHT} gutterWidth={GUTTER} />
          ))}
          {timeline.tracks.audio.map((track) => (
            <TrackRow key={track.id} track={track} pxPerFrame={pxPerFrame} rowHeight={ROW_HEIGHT} gutterWidth={GUTTER} />
          ))}

          <Playhead pxPerFrame={pxPerFrame} gutterWidth={GUTTER} />
        </div>
      </div>
    </div>
  );
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
