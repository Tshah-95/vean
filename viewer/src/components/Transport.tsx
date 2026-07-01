// Transport: play/pause + the timecode readout + one audio control. Every control
// writes through the master clock (clock.play/pause) — the clock is the only
// writer of currentFrame; the <video> and <Player> follow.
//
// Deliberately MINIMAL: there is no scrub slider here — the TIMELINE is the scrub
// surface and the source of truth for position (the ruler seeks; this bar plays).
// No frame counter either; the timecode carries it. Audio is ONE speaker button
// whose popover holds the vertical volume slider, mute, and the output device —
// zero standing horizontal footprint.
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useClock, useClockInstance } from "../ClockProvider";
import type { Fps } from "../types";

const SINK_SUPPORTED =
  typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

/** HH:MM:SS:FF timecode from an integer frame at a rational fps. */
export function timecode(frame: number, fps: Fps): string {
  const fpsWhole = Math.max(1, Math.round(fps[0] / fps[1]));
  const totalSeconds = Math.floor(frame / fpsWhole);
  const ff = frame % fpsWhole;
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

export interface TransportProps {
  /** Playback volume 0–1. */
  volume: number;
  /** Whether audio is muted. */
  muted: boolean;
  onVolumeChange: (v: number) => void;
  onMutedChange: (m: boolean) => void;
  /** Selected audio output device id ("" = system default). */
  sinkId: string;
  onSinkChange: (id: string) => void;
}

export function Transport({
  volume,
  muted,
  onVolumeChange,
  onMutedChange,
  sinkId,
  onSinkChange,
}: TransportProps) {
  const clock = useClock();
  const instance = useClockInstance();
  const [audioOpen, setAudioOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);

  // Enumerate audio OUTPUT devices for the sink picker (inside the popover).
  const [outputs, setOutputs] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => {
    if (!SINK_SUPPORTED || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    const refresh = () =>
      navigator.mediaDevices
        .enumerateDevices()
        .then((devs) => {
          if (cancelled) return;
          const outs = devs
            .filter((d) => d.kind === "audiooutput")
            .map((d, i) => ({ id: d.deviceId, label: d.label || `Output ${i + 1}` }));
          setOutputs(outs);
        })
        .catch(() => {});
    refresh();
    navigator.mediaDevices.addEventListener?.("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  // Dismiss the audio popover on an outside pointerdown.
  useEffect(() => {
    if (!audioOpen) return;
    const onDown = (e: PointerEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setAudioOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [audioOpen]);

  const audioOff = muted || volume === 0;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "8px 14px",
        borderTop: "1px solid #1b1e26",
        borderBottom: "1px solid #1b1e26",
        background: "#0d0f14",
      }}
    >
      <button
        type="button"
        onClick={() => instance.toggle()}
        aria-label={clock.playing ? "Pause" : "Play"}
        title={`${clock.playing ? "Pause" : "Play"} ( space )`}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 30,
          height: 26,
          borderRadius: 5,
          border: "none",
          background: clock.playing ? "#c7ae7a" : "transparent",
          color: clock.playing ? "#0b0c0f" : "#E6E3DA",
          cursor: "pointer",
        }}
      >
        {clock.playing ? <Pause size={15} strokeWidth={1.75} /> : <Play size={15} strokeWidth={1.75} />}
      </button>

      <span style={{ flex: 1 }} />
      <div
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          color: "#E6E3DA",
        }}
      >
        {timecode(clock.currentFrame, clock.fps)}
      </div>
      <span style={{ flex: 1 }} />

      {/* Audio — one icon; volume (vertical) + mute + output device live in the popover. */}
      <div ref={popRef} style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setAudioOpen((o) => !o)}
          aria-label="Audio"
          aria-expanded={audioOpen}
          title="Volume + audio output"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 24,
            borderRadius: 5,
            border: "none",
            background: audioOpen ? "#1b1e23" : "transparent",
            color: audioOff ? "#6B716A" : "#9BA39B",
            cursor: "pointer",
          }}
        >
          {audioOff ? <VolumeX size={15} strokeWidth={1.75} /> : <Volume2 size={15} strokeWidth={1.75} />}
        </button>
        {audioOpen ? (
          <div
            style={{
              position: "absolute",
              bottom: 30,
              right: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
              padding: "10px 8px 8px",
              borderRadius: 8,
              border: "1px solid #262a2e",
              background: "#131519",
              boxShadow: "0 12px 28px -16px rgba(0,0,0,0.6)",
              zIndex: 20,
            }}
          >
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => {
                const v = Number(e.target.value);
                onVolumeChange(v);
                if (v > 0 && muted) onMutedChange(false);
              }}
              aria-label="Volume"
              // Vertical slider — both the modern and the WebKit spelling.
              style={{
                writingMode: "vertical-lr",
                direction: "rtl",
                WebkitAppearance: "slider-vertical",
                width: 18,
                height: 84,
                accentColor: "#c7ae7a",
                cursor: "pointer",
              }}
            />
            <button
              type="button"
              onClick={() => onMutedChange(!muted)}
              aria-label={muted ? "Unmute" : "Mute"}
              title={muted ? "Unmute" : "Mute"}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 26,
                height: 22,
                borderRadius: 4,
                border: "none",
                background: "transparent",
                color: muted ? "#c7ae7a" : "#9BA39B",
                cursor: "pointer",
              }}
            >
              {muted ? <VolumeX size={14} strokeWidth={1.75} /> : <Volume2 size={14} strokeWidth={1.75} />}
            </button>
            {SINK_SUPPORTED && outputs.length > 0 ? (
              <select
                value={sinkId}
                onChange={(e) => onSinkChange(e.target.value)}
                aria-label="Audio output device"
                title="Audio output device"
                style={{
                  maxWidth: 130,
                  borderRadius: 5,
                  border: "1px solid #262a2e",
                  background: "#0c0d0f",
                  color: "#9BA39B",
                  fontSize: 11,
                  padding: "3px 4px",
                  cursor: "pointer",
                }}
              >
                <option value="">System default</option>
                {outputs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
