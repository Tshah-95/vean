// A single placed item on a track row: a clip, a blank gap, or a dissolve marker,
// drawn at frame-accurate x = start * pxPerFrame, width = length * pxPerFrame.
import type { PlacedItem } from "../types";
import { isGraphicClip } from "../types";

export interface ClipBlockProps {
  placed: PlacedItem;
  pxPerFrame: number;
  kind: "video" | "audio";
}

function basename(resource: string): string {
  const cleaned = resource.replace(/\\/g, "/");
  const last = cleaned.split("/").pop() ?? cleaned;
  return last.length > 28 ? `${last.slice(0, 25)}…` : last;
}

export function ClipBlock({ placed, pxPerFrame, kind }: ClipBlockProps) {
  const { item, start, length } = placed;
  const left = start * pxPerFrame;
  const width = Math.max(2, length * pxPerFrame);

  if (item.kind === "blank") {
    return (
      <div
        style={{
          position: "absolute",
          left,
          width,
          top: 0,
          bottom: 0,
          // Gaps read as empty space (a faint hatch).
          background:
            "repeating-linear-gradient(45deg, transparent, transparent 5px, #14171f 5px, #14171f 6px)",
        }}
        title={`blank · ${length}f`}
      />
    );
  }

  if (item.kind === "dissolve") {
    return (
      <div
        style={{
          position: "absolute",
          left,
          width,
          top: 0,
          bottom: 0,
          background: "linear-gradient(90deg, #2a2e3a, #c7ae7a55, #2a2e3a)",
          borderRadius: 3,
        }}
        title={`dissolve · ${length}f`}
      />
    );
  }

  // clip
  const graphic = isGraphicClip(item);
  const bg = graphic
    ? "linear-gradient(180deg, #3a2f5e, #2c244a)"
    : kind === "audio"
      ? "linear-gradient(180deg, #1f3a34, #173029)"
      : "linear-gradient(180deg, #233042, #1a2533)";
  const border = graphic ? "#7a6bd0" : kind === "audio" ? "#2f6b5c" : "#345070";

  return (
    <div
      style={{
        position: "absolute",
        left,
        width,
        top: 2,
        bottom: 2,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 4,
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        paddingLeft: 6,
        fontSize: 11,
        color: "#cfd3dc",
        whiteSpace: "nowrap",
      }}
      title={`${item.label ?? basename(item.resource)} · ${length}f · src[${item.in}-${item.out}]`}
    >
      {graphic ? <span style={{ marginRight: 4 }}>◆</span> : null}
      {item.label ? item.label.split(":")[0] : basename(item.resource)}
    </div>
  );
}
