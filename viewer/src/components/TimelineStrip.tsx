// The timeline strip — drawn purely from the parsed IR. Video tracks (top→bottom)
// then audio tracks, a frame ruler across the top, and a draggable playhead.
// Click/drag in the lane area seeks the master clock (scrub): pause, then seekTo
// the frame under the cursor continuously. Both preview layers follow via the
// clock's frameupdate.
import { useCallback, useMemo, useRef, useState } from "react";
import { useClockInstance } from "../ClockProvider";
import type { Timeline } from "../types";
import { Playhead } from "./Playhead";
import { TrackRow } from "./TrackRow";

const GUTTER = 56;
const ROW_HEIGHT = 34;
const RULER_HEIGHT = 22;

export interface TimelineStripProps {
  timeline: Timeline;
  totalFrames: number;
}

export function TimelineStrip({ timeline, totalFrames }: TimelineStripProps) {
  const clock = useClockInstance();
  const laneRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const scrubbing = useRef(false);

  // Fit-to-width default: divide a nominal lane width by total frames, then scale
  // by the zoom control. Recompute lazily; a ResizeObserver is overkill for v0.
  const fitWidth = 900;
  const basePxPerFrame = Math.max(0.5, fitWidth / Math.max(1, totalFrames));
  const pxPerFrame = basePxPerFrame * zoom;

  const fps = timeline.profile.fps;
  const fpsWhole = Math.max(1, Math.round(fps[0] / fps[1]));

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

  // Ruler ticks: one labeled tick per second.
  const ticks = useMemo(() => {
    const out: Array<{ frame: number; label: string }> = [];
    for (let f = 0; f <= totalFrames; f += fpsWhole) {
      out.push({ frame: f, label: `${Math.round(f / fpsWhole)}s` });
    }
    return out;
  }, [totalFrames, fpsWhole]);

  const laneWidth = GUTTER + totalFrames * pxPerFrame;

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
        <button type="button" onClick={() => setZoom((z) => Math.max(0.25, z / 1.5))} style={zoomBtn}>
          −
        </button>
        <span style={{ fontFamily: "ui-monospace, monospace", minWidth: 40, textAlign: "center" }}>
          {zoom.toFixed(2)}×
        </span>
        <button type="button" onClick={() => setZoom((z) => Math.min(20, z * 1.5))} style={zoomBtn}>
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
        <div style={{ minWidth: laneWidth, position: "relative" }}>
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
