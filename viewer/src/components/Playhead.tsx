// The vertical playhead line at currentFrame * pxPerFrame, overlaid on the strip
// lanes (right of the gutter). Reads the master clock for its position.
import { useClock } from "../ClockProvider";

export interface PlayheadProps {
  pxPerFrame: number;
  gutterWidth: number;
}

export function Playhead({ pxPerFrame, gutterWidth }: PlayheadProps) {
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
        background: "#e2574c",
        pointerEvents: "none",
        zIndex: 5,
        boxShadow: "0 0 6px rgba(226,87,76,0.6)",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: -1,
          left: -4,
          width: 10,
          height: 8,
          background: "#e2574c",
          clipPath: "polygon(0 0, 100% 0, 50% 100%)",
        }}
      />
    </div>
  );
}
