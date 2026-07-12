// One row of the timeline strip = one track. Draws its placed items left-to-right
// at frame-accurate positions. The row label (V1, A1, …) sits in a fixed gutter.
import type { Track } from "../types";
import { placeItems } from "../types";
import { ClipBlock } from "./ClipBlock";

export interface TrackRowProps {
  track: Track;
  pxPerFrame: number;
  rowHeight: number;
  gutterWidth: number;
}

export function TrackRow({ track, pxPerFrame, rowHeight, gutterWidth }: TrackRowProps) {
  const placed = placeItems(track);
  const label = track.name ?? track.id;

  return (
    <div style={{ display: "flex", height: rowHeight, borderBottom: "1px solid #14171f" }}>
      <div
        style={{
          width: gutterWidth,
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
      <div style={{ position: "relative", flex: 1, background: "#0a0b0f" }}>
        {placed.map((p, i) => (
          <ClipBlock
            key={`${track.id}-${i}`}
            placed={p}
            pxPerFrame={pxPerFrame}
            kind={track.kind}
          />
        ))}
      </div>
    </div>
  );
}
