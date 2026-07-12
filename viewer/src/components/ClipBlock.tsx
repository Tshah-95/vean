// A single placed item on a track row: a clip, a blank gap, or a dissolve marker,
// drawn at frame-accurate x = start * pxPerFrame, width = length * pxPerFrame.
//
// Clips are now INTERACTIVE: a pointerdown selects + begins a contextual gesture
// (the strip infers the tool from where you grab). A selected clip shows a border
// highlight, edge brackets (the trim grab targets), an optional diagnostic badge,
// and an optional live readout (the slip in/out, DaVinci-style). Blanks + dissolves
// stay inert (no selection, no gesture).
import type { Diagnostic, PlacedItem } from "../types";
import { isGraphicClip, isRemotionOverlay } from "../types";

export interface ClipBlockProps {
  placed: PlacedItem;
  pxPerFrame: number;
  kind: "video" | "audio";
  /** Is this the selected clip? (draws the highlight + edge brackets). */
  selected?: boolean;
  /** Diagnostics anchored to this clip (drives a warning/error badge). */
  diagnostics?: Diagnostic[];
  /** A transient readout to show centred over the clip (e.g. slip in/out). */
  readout?: string | null;
  /** True while this clip is being dragged (dims it as a "ghost" at the origin). */
  dragging?: boolean;
  /** Render as a translucent SHELL (the live move preview at the drag target): you
   *  see the label + outline but see THROUGH it to the content it will land on. */
  ghost?: boolean;
  /** Pointerdown on the clip body — begins a contextual gesture (clips only). */
  onPointerDown?: (e: React.PointerEvent) => void;
  /** The hover cursor (the lane sets it per zone via pointer-move; default grab). */
  cursor?: string;
  /** Semantic option contract for selectable clips. Structural items receive a
   *  descriptive note instead and never enter roving focus. */
  accessibleName?: string;
  tabIndex?: 0 | -1;
  editMode?: boolean;
  editTarget?: "body" | "head" | "tail";
  optionRef?: (node: HTMLDivElement | null) => void;
  onFocus?: () => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
  onKeyUp?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
}

function basename(resource: string): string {
  const cleaned = resource.replace(/\\/g, "/");
  const last = cleaned.split("/").pop() ?? cleaned;
  return last.length > 28 ? `${last.slice(0, 25)}…` : last;
}

export function ClipBlock({
  placed,
  pxPerFrame,
  kind,
  selected = false,
  diagnostics,
  readout = null,
  dragging = false,
  ghost = false,
  onPointerDown,
  cursor = "grab",
  accessibleName,
  tabIndex = -1,
  editMode = false,
  editTarget,
  optionRef,
  onFocus,
  onKeyDown,
  onKeyUp,
}: ClipBlockProps) {
  const { item, start, length } = placed;
  const left = start * pxPerFrame;
  const width = Math.max(2, length * pxPerFrame);

  if (item.kind === "blank") {
    return (
      <div
        role="option"
        aria-disabled="true"
        aria-selected="false"
        tabIndex={-1}
        aria-label={`Blank gap, ${length} frames, timeline frames ${start} to ${start + length - 1}`}
        style={{
          position: "absolute",
          left,
          width,
          top: 0,
          bottom: 0,
          // Gaps read as empty space (a faint hatch).
          background:
            "repeating-linear-gradient(45deg, transparent, transparent 5px, #14171f 5px, #14171f 6px)",
          pointerEvents: "none",
        }}
        title={`blank · ${length}f`}
      />
    );
  }

  if (item.kind === "dissolve") {
    return (
      <div
        role="option"
        aria-disabled="true"
        aria-selected="false"
        tabIndex={-1}
        aria-label={`Dissolve, ${length} frames, timeline frames ${start} to ${start + length - 1}`}
        style={{
          position: "absolute",
          left,
          width,
          top: 0,
          bottom: 0,
          background: "linear-gradient(90deg, #2a2e3a, #c7ae7a55, #2a2e3a)",
          borderRadius: 3,
          pointerEvents: "none",
        }}
        title={`dissolve · ${length}f`}
      />
    );
  }

  // clip — a Remotion overlay (composition-baked .mov) reads like a graphic clip in
  // the strip (purple gradient + ◆ marker), even though it composites as footage.
  const graphic = isGraphicClip(item) || isRemotionOverlay(item);
  const bg = graphic
    ? "linear-gradient(180deg, #3a2f5e, #2c244a)"
    : kind === "audio"
      ? "linear-gradient(180deg, #1f3a34, #173029)"
      : "linear-gradient(180deg, #233042, #1a2533)";
  const baseBorder = graphic ? "#7a6bd0" : kind === "audio" ? "#2f6b5c" : "#345070";
  const border = selected ? "#c7ae7a" : baseBorder;

  const errs = diagnostics?.filter((d) => d.severity === "error") ?? [];
  const warns = diagnostics?.filter((d) => d.severity === "warning") ?? [];
  const badge = errs.length > 0 ? "error" : warns.length > 0 ? "warn" : null;
  const badgeTitle = [...errs, ...warns].map((d) => `${d.code}: ${d.message}`).join("\n");

  // Media-limit cues (Premiere-style): the head is at the source's FIRST frame, or
  // the tail at its LAST — no source frames left to extend that side, so the strip's
  // trim wall stops the drag there. A color generator is positionless (no source
  // window) and an un-probed clip has an unknown tail, so neither flags that edge.
  const atMediaStart = item.service !== "color" && item.in <= 0;
  const atMediaEnd = item.service !== "color" && item.length != null && item.out >= item.length - 1;

  return (
    // A native <option> cannot host the editor's rich clip content or roving focus;
    // this is the ARIA listbox pattern with focusable option descendants.
    // biome-ignore lint/a11y/useSemanticElements: rich listbox option, not a native select option.
    <div
      role="option"
      ref={optionRef}
      aria-label={accessibleName}
      aria-selected={selected}
      aria-describedby="timeline-keyboard-help"
      aria-roledescription={editMode ? `clip editing ${editTarget ?? "body"}` : "timeline clip"}
      tabIndex={tabIndex}
      data-clip-id={item.id}
      data-edit-mode={editMode ? "true" : "false"}
      data-edit-target={editTarget}
      onPointerDown={onPointerDown}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      style={{
        position: "absolute",
        left,
        width,
        top: 2,
        bottom: 2,
        // A ghost is a translucent shell: a see-through fill + a dashed accent border
        // so the target content shows through and the "this is a preview" reads.
        background: ghost ? "rgba(199,174,122,0.14)" : bg,
        border: ghost ? "1.5px dashed #c7ae7a" : `1px solid ${border}`,
        boxShadow:
          !ghost && selected ? "0 0 0 1px #c7ae7a, 0 0 8px rgba(199,174,122,0.35)" : "none",
        borderRadius: 4,
        overflow: "visible",
        display: "flex",
        alignItems: "center",
        paddingLeft: 6,
        fontSize: 11,
        color: ghost ? "#e6d6b0" : "#cfd3dc",
        whiteSpace: "nowrap",
        opacity: dragging ? 0.4 : 1,
        // The moving shell floats above the static rows (and their collision tints).
        zIndex: ghost ? 5 : selected ? 3 : 1,
        pointerEvents: ghost ? "none" : undefined,
        cursor,
        touchAction: "none",
      }}
      title={`${item.composition ? `${item.composition.id} · comp` : (item.label ?? basename(item.resource))} · ${length}f · src[${item.in}-${item.out}]`}
    >
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          // leave room for the edge brackets so the label never sits under them
          marginLeft: selected ? 4 : 0,
          marginRight: 6,
        }}
      >
        {graphic ? <span style={{ marginRight: 4 }}>◆</span> : null}
        {/* A live Remotion comp is a first-class entity — show its COMPOSITION id
            (e.g. "EnterJourney"), not the cache `.mov` its resource points at (that
            path is just the live-detection key + the export bake target). */}
        {item.composition
          ? item.composition.id
          : item.label
            ? item.label.split(":")[0]
            : basename(item.resource)}
      </span>

      {/* Edge brackets — the explicit TRIM grab targets on the selected clip. */}
      {selected ? (
        <>
          <EdgeBracket side="left" />
          <EdgeBracket side="right" />
        </>
      ) : null}

      {/* Media-limit markers — a corner triangle when this side is at the source's
          first/last frame (no handle left to extend). Informational + always on (not
          tied to selection); a ghost preview shell omits them. */}
      {!ghost && atMediaStart ? <MediaLimit side="left" /> : null}
      {!ghost && atMediaEnd ? <MediaLimit side="right" /> : null}

      {/* Diagnostic badge (ambient; never blocks). */}
      {badge ? (
        <div
          title={badgeTitle}
          style={{
            position: "absolute",
            top: -7,
            right: -6,
            width: 15,
            height: 15,
            borderRadius: "50%",
            background: badge === "error" ? "#e2574c" : "#e2c275",
            color: "#1a1206",
            fontSize: 10,
            fontWeight: 700,
            lineHeight: "15px",
            textAlign: "center",
            boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
            zIndex: 6,
            pointerEvents: "none",
          }}
        >
          !
        </div>
      ) : null}

      {/* Transient readout (slip in/out, etc.) centred over the clip. */}
      {readout ? (
        <div
          style={{
            position: "absolute",
            top: -20,
            left: "50%",
            transform: "translateX(-50%)",
            background: "#0b0c0f",
            border: "1px solid #c7ae7a",
            color: "#e6d6b0",
            fontFamily: "ui-monospace, monospace",
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 4,
            whiteSpace: "nowrap",
            zIndex: 7,
            pointerEvents: "none",
          }}
        >
          {readout}
        </div>
      ) : null}
    </div>
  );
}

/** A small corner triangle marking that the clip is at its SOURCE limit on this side
 *  — the head is at the source's first frame (left) or the tail at its last (right),
 *  so there are no more frames to extend into. Premiere's "media limit" cue: purely
 *  informational (the strip's `gestureDxBounds` wall is what actually stops the drag),
 *  neutral-toned so it reads as "hard stop", not an error. */
function MediaLimit({ side }: { side: "left" | "right" }) {
  return (
    <div
      title={
        side === "left"
          ? "at media start — no source frames left to extend the head"
          : "at media end — no source frames left to extend the tail"
      }
      style={{
        position: "absolute",
        top: 1,
        [side]: 1,
        width: 7,
        height: 7,
        background: "rgba(232,234,242,0.6)",
        // A right triangle hugging this corner (top + this-side edges).
        clipPath:
          side === "left" ? "polygon(0 0, 100% 0, 0 100%)" : "polygon(0 0, 100% 0, 100% 100%)",
        zIndex: 6,
      }}
    />
  );
}

/** A thin resize bracket flush to one edge of the selected clip — the visible
 *  affordance that the edge is a trim grab target (cursor handled by the lane). */
function EdgeBracket({ side }: { side: "left" | "right" }) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side]: 0,
        width: 5,
        background: "#c7ae7a",
        opacity: 0.85,
        borderTopLeftRadius: side === "left" ? 3 : 0,
        borderBottomLeftRadius: side === "left" ? 3 : 0,
        borderTopRightRadius: side === "right" ? 3 : 0,
        borderBottomRightRadius: side === "right" ? 3 : 0,
        pointerEvents: "none",
      }}
    />
  );
}
