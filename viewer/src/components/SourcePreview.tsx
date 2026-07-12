import { Button } from "@/components/ui/button";
// The SOURCE monitor — preview a media file (not the timeline): stream it over
// /api/media, mark an in/out span on the two-thumb range bar, and drag the chip
// onto the timeline to place exactly that span (Premiere's source-monitor flow).
// Range frames are at the TIMELINE fps (sources are conformed to the project).
import { GripHorizontal, Pause, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useClock } from "../ClockProvider";
import { MEDIA_DRAG_MIME, type MediaDragPayload, useSource } from "../SourceProvider";
import { mediaUrl } from "../api";
import { timecode } from "./Transport";

export function SourcePreview({ route }: { route?: string }) {
  const { source, range, setRange } = useSource();
  const clock = useClock(); // timeline fps — the frame unit for in/out
  const fpsWhole = Math.max(1, Math.round(clock.fps[0] / clock.fps[1]));
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [durationF, setDurationF] = useState(0);
  const [posF, setPosF] = useState(0);
  const [playing, setPlaying] = useState(false);
  const dragging = useRef<"in" | "out" | null>(null);

  // Follow the element's real position/duration (the source has its own clock —
  // the master timeline clock is untouched by source preview).
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onMeta = () => {
      const frames = Math.max(1, Math.round(v.duration * fpsWhole));
      setDurationF(frames);
      setRange((r) => r ?? { in: 0, out: frames - 1 });
    };
    const onTime = () => setPosF(Math.round(v.currentTime * fpsWhole));
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    if (v.readyState >= 1) onMeta();
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
    };
  }, [fpsWhole, setRange]);

  const frameAtX = useCallback(
    (clientX: number): number => {
      const el = barRef.current;
      if (!el || durationF === 0) return 0;
      const r = el.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return Math.round(t * (durationF - 1));
    },
    [durationF],
  );

  // Range-thumb drag + bar seek.
  const onBarPointerDown = useCallback(
    (e: React.PointerEvent) => {
      const f = frameAtX(e.clientX);
      const v = videoRef.current;
      if (dragging.current === null && v) {
        v.currentTime = f / fpsWhole;
        setPosF(f);
      }
    },
    [frameAtX, fpsWhole],
  );
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const f = frameAtX(e.clientX);
      setRange((r) => {
        if (!r) return r;
        return dragging.current === "in"
          ? { in: Math.min(f, r.out), out: r.out }
          : { in: r.in, out: Math.max(f, r.in) };
      });
    };
    const onUp = () => {
      dragging.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [frameAtX, setRange]);

  if (!source) return null;
  const r = range ?? { in: 0, out: Math.max(0, durationF - 1) };
  const pct = (f: number) => (durationF <= 1 ? 0 : (f / (durationF - 1)) * 100);

  const onDragStart = (e: React.DragEvent) => {
    const payload: MediaDragPayload = {
      path: source.path,
      name: source.name,
      kind: source.kind,
      in: r.in,
      out: r.out,
    };
    e.dataTransfer.setData(MEDIA_DRAG_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <>
      {/* The source video, framed like the program monitor. */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
        }}
      >
        {/* biome-ignore lint/a11y/useMediaCaption: editor source preview */}
        <video
          ref={videoRef}
          src={mediaUrl(source.path, route)}
          playsInline
          style={{
            maxWidth: "100%",
            maxHeight: "100%",
            borderRadius: 8,
            background: "var(--vean-bg-inset)",
            boxShadow: "0 4px 32px rgba(0, 0, 0, 0.6)",
          }}
        />
      </div>

      {/* Source transport: play/pause · in/out range bar · timecode · drag chip. */}
      <div className="flex items-center gap-3 border-t border-border-faint bg-header px-3.5 py-2">
        <Button
          size="icon"
          variant={playing ? "default" : "ghost"}
          onClick={() => {
            const v = videoRef.current;
            if (!v) return;
            if (v.paused) void v.play().catch(() => {});
            else v.pause();
          }}
          aria-label={playing ? "Pause source" : "Play source"}
        >
          {playing ? <Pause size={15} strokeWidth={1.75} /> : <Play size={15} strokeWidth={1.75} />}
        </Button>

        {/* The two-thumb range: the selected span is gold; thumbs set in/out. */}
        <div
          ref={barRef}
          onPointerDown={onBarPointerDown}
          style={{ position: "relative", flex: 1, height: 18, cursor: "ew-resize" }}
          title="Click to seek · drag the handles to set in/out"
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 8,
              height: 3,
              borderRadius: 2,
              background: "var(--vean-bg-hover)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: `${pct(r.in)}%`,
              width: `${Math.max(0, pct(r.out) - pct(r.in))}%`,
              top: 8,
              height: 3,
              borderRadius: 2,
              background: "var(--vean-gold)",
            }}
          />
          {/* position hairline */}
          <div
            style={{
              position: "absolute",
              left: `${pct(Math.min(posF, Math.max(0, durationF - 1)))}%`,
              top: 4,
              width: 1,
              height: 11,
              background: "var(--vean-fg-1)",
              opacity: 0.6,
              pointerEvents: "none",
            }}
          />
          {(["in", "out"] as const).map((side) => (
            <div
              key={side}
              onPointerDown={(e) => {
                e.stopPropagation();
                dragging.current = side;
              }}
              title={side === "in" ? `in ${r.in}f` : `out ${r.out}f`}
              style={{
                position: "absolute",
                left: `${pct(side === "in" ? r.in : r.out)}%`,
                top: 3,
                width: 7,
                height: 13,
                transform: "translateX(-50%)",
                borderRadius: 2,
                background: "var(--vean-gold)",
                cursor: "ew-resize",
                touchAction: "none",
              }}
            />
          ))}
        </div>

        <span className="font-mono text-xs text-fg-2" title="selected span (in → out)">
          {timecode(r.in, clock.fps)} → {timecode(r.out, clock.fps)}
        </span>

        {/* Drag this onto a timeline track to place the selected span. */}
        <div
          draggable
          onDragStart={onDragStart}
          title="Drag onto a timeline track to place the selected span"
          className="flex cursor-grab select-none items-center gap-1 rounded-md border border-dashed border-gold-edge px-2 py-0.5 text-[11px] text-primary"
        >
          <GripHorizontal size={13} strokeWidth={1.75} />
          place {r.out - r.in + 1}f
        </div>
      </div>
    </>
  );
}
