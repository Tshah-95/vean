// The vertical playhead line at currentFrame * pxPerFrame, overlaid on the strip
// (right of the gutter). Reads the master clock for its position.
//
// Two visual registers, per the scrub-zone contract: the line is SOLID + full
// opacity through the RULER (where it is the seek control) and DASHED + dimmed over
// the TRACK ROWS (where it is only a position indicator, not a click target). The
// CTI flag handle lives in the ruler (TimelineStrip owns it as the grab target);
// this component is purely a non-interactive indicator.
import { useClock } from "../ClockProvider";

export interface PlayheadProps {
  pxPerFrame: number;
  gutterWidth: number;
  /** Ruler height — the boundary between the solid (ruler) + dashed (rows) parts. */
  rulerHeight: number;
}

export function Playhead({ pxPerFrame, gutterWidth, rulerHeight }: PlayheadProps) {
  const clock = useClock();
  const x = gutterWidth + clock.currentFrame * pxPerFrame;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: 0,
        bottom: 0,
        width: 2,
        marginLeft: -1,
        pointerEvents: "none",
        zIndex: 5,
      }}
    >
      {/* Solid segment through the ruler (the seek register). */}
      <div
        style={{
          position: "absolute",
          top: 0,
          height: rulerHeight,
          left: 0,
          width: 2,
          background: "#e2574c",
          boxShadow: "0 0 6px rgba(226,87,76,0.6)",
        }}
      />
      {/* Dashed, dimmed segment over the track rows (position indicator only). */}
      <div
        style={{
          position: "absolute",
          top: rulerHeight,
          bottom: 0,
          left: 0,
          width: 0,
          borderLeft: "2px dashed #e2574c",
          opacity: 0.5,
        }}
      />
    </div>
  );
}
