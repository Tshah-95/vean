// The SOURCE selection store — which media item is "loaded" in the source monitor
// (Premiere's source/program split, vean-shaped). MediaPanel sets it on tile click;
// the monitor's Source tab, the Inspector, and drag-to-timeline all read it. The
// in/out range is the user's selection over that source (timeline-fps frames),
// carried by a drag so a drop places exactly the chosen span.
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export interface SourceMedia {
  /** Absolute path of the media file (streams via /api/media). */
  path: string;
  name: string;
  kind: "video" | "audio" | "graphic";
}

export interface SourceRange {
  /** Inclusive in/out, integer frames at the TIMELINE fps. */
  in: number;
  out: number;
}

interface SourceState {
  source: SourceMedia | null;
  /** The selected span over the source; null until metadata loads (defaults to all). */
  range: SourceRange | null;
  /** Which monitor tab is showing. Selecting a source switches to "source". */
  monitor: "program" | "source";
  select: (media: SourceMedia | null) => void;
  setRange: Dispatch<SetStateAction<SourceRange | null>>;
  setMonitor: (m: "program" | "source") => void;
}

const Ctx = createContext<SourceState | null>(null);

export function SourceProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<SourceMedia | null>(null);
  const [range, setRange] = useState<SourceRange | null>(null);
  const [monitor, setMonitor] = useState<"program" | "source">("program");

  const select = useCallback((media: SourceMedia | null) => {
    setSource(media);
    setRange(null); // re-derived from the new source's duration
    setMonitor(media ? "source" : "program");
  }, []);

  const value = useMemo(
    () => ({ source, range, monitor, select, setRange, setMonitor }),
    [source, range, monitor, select],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSource(): SourceState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSource outside SourceProvider");
  return ctx;
}

/** The drag payload a media tile / the source monitor hands to the timeline. */
export interface MediaDragPayload {
  path: string;
  name: string;
  kind: "video" | "audio" | "graphic";
  /** Inclusive source frames at timeline fps. */
  in: number;
  out: number;
}

export const MEDIA_DRAG_MIME = "application/x-vean-media";
