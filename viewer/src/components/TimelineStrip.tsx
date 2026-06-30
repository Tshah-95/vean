// The timeline strip — drawn purely from the parsed IR. Video tracks (top→bottom)
// then audio tracks, an adaptive time ruler, and a draggable playhead. Click/drag
// in the lane area seeks the master clock (scrub). Both preview layers follow.
//
// ZOOM MODEL (fixed-width, not stretch-wide): at "Fit" (1×) the WHOLE timeline
// fills the actual pane width — no giant horizontal scroll for a short clip.
// Zooming in (2×…8×) magnifies: each second gets wider, fewer seconds are visible
// at once, and the lane scrolls to pan. The ruler picks a "nice" seconds-per-tick
// so labels never crowd — so the *scale* changes, the container width doesn't.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useClockInstance } from "../ClockProvider";
import type { Timeline } from "../types";
import { Playhead } from "./Playhead";
import { TrackRow } from "./TrackRow";

const GUTTER = 56;
const ROW_HEIGHT = 34;
const RULER_HEIGHT = 22;
const MIN_TICK_PX = 56; // ruler ticks stay at least this far apart

// Normalized zoom ladder. Index 0 = "Fit" (whole timeline across the pane);
// higher indices magnify by a clean factor. No sub-1 values (Fit already shows
// everything), so the direction is unambiguous: + elongates, − returns to Fit.
const ZOOM_STEPS = [1, 2, 3, 4, 6, 8] as const;
// "Nice" tick intervals in seconds; the ruler snaps to the first that fits.
const NICE_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600] as const;

export interface TimelineStripProps {
  timeline: Timeline;
  totalFrames: number;
}

function tickLabel(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const r = seconds % 60;
  return r === 0 ? `${m}m` : `${m}:${String(r).padStart(2, "0")}`;
}

export function TimelineStrip({ timeline, totalFrames }: TimelineStripProps) {
  const clock = useClockInstance();
  const laneRef = useRef<HTMLDivElement>(null);
  const [zoomIdx, setZoomIdx] = useState(0);
  const [paneWidth, setPaneWidth] = useState(900);
  const scrubbing = useRef(false);

  // Measure the real pane width so "Fit" actually fits — and stays fit on resize.
  useEffect(() => {
    const el = laneRef.current;
    if (!el) return;
    const measure = () => setPaneWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const zoom = ZOOM_STEPS[zoomIdx] ?? 1;
  const fps = timeline.profile.fps;
  const fpsWhole = Math.max(1, Math.round(fps[0] / fps[1]));

  // Fit-to-pane base: the lane content area (pane minus the label gutter) holds
  // the whole timeline at 1×; zoom magnifies from there.
  const contentWidth = Math.max(120, paneWidth - GUTTER);
  const basePxPerFrame = contentWidth / Math.max(1, totalFrames);
  const pxPerFrame = basePxPerFrame * zoom;
  const laneWidth = GUTTER + totalFrames * pxPerFrame;

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

  // Adaptive ruler: pick the first "nice" seconds-per-tick that keeps labels
  // ≥ MIN_TICK_PX apart, so the scale (not the width) responds to zoom.
  const pxPerSecond = pxPerFrame * fpsWhole;
  const secPerTick = NICE_SECONDS.find((s) => s * pxPerSecond >= MIN_TICK_PX) ?? 600;
  const ticks = useMemo(() => {
    const out: Array<{ frame: number; label: string }> = [];
    const framesPerTick = secPerTick * fpsWhole;
    for (let f = 0; f <= totalFrames; f += framesPerTick) {
      out.push({ frame: f, label: tickLabel(Math.round(f / fpsWhole)) });
    }
    return out;
  }, [totalFrames, fpsWhole, secPerTick]);

  return (
    <div style={{ display: "flex", flexDirection: "column", background: "#0a0b0f" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 12px",
          fontSize: 11,
          color: "#6b7280",
          borderBottom: "1px solid #14171f",
        }}
      >
        <span>timeline</span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
          disabled={zoomIdx === 0}
          style={{ ...zoomBtn, opacity: zoomIdx === 0 ? 0.4 : 1 }}
          aria-label="Zoom out"
        >
          −
        </button>
        <span style={{ fontFamily: "ui-monospace, monospace", minWidth: 40, textAlign: "center" }}>
          {zoomIdx === 0 ? "Fit" : `${zoom}×`}
        </span>
        <button
          type="button"
          onClick={() => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
          disabled={zoomIdx === ZOOM_STEPS.length - 1}
          style={{ ...zoomBtn, opacity: zoomIdx === ZOOM_STEPS.length - 1 ? 0.4 : 1 }}
          aria-label="Zoom in"
        >
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
                  }}
                >
                  {t.label}
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
  width: 22,
  height: 20,
  borderRadius: 4,
  border: "1px solid #2a2e3a",
  background: "#161922",
  color: "#9aa0ae",
  cursor: "pointer",
  fontSize: 13,
  lineHeight: 1,
};
