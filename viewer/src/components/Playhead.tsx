// The vertical playhead line at currentFrame * pxPerFrame, overlaid on the strip
// (right of the gutter). Reads the master clock for its position.
//
// Deliberately QUIET: a 1px dimmed hairline over the TRACK ROWS only (a position
// indicator, not a click target). It does not run through the ruler — the only
// marker there is the small CTI arrow docked at the ruler's bottom edge
// (TimelineStrip owns it as the grab affordance). No glow, no solid bar.
import { useClock } from "../ClockProvider";

export interface PlayheadProps {
  pxPerFrame: number;
  gutterWidth: number;
  /** Ruler height — the line starts below it (rows only, never through the ruler). */
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
        top: rulerHeight,
        bottom: 0,
        width: 0,
        borderLeft: "1px solid rgba(226, 87, 76, 0.5)",
        pointerEvents: "none",
        zIndex: 5,
      }}
    />
  );
}
