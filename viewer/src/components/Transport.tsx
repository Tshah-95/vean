// Transport: play/pause, a frame scrubber, and the timecode readout. Every
// control writes through the master clock (clock.play/pause/seekTo) — the clock
// is the only writer of currentFrame; the <video> and <Player> follow.
import { useEffect, useState } from "react";
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
  const lastFrame = Math.max(0, clock.totalFrames - 1);

  // Enumerate audio OUTPUT devices for the sink picker. Labels may be generic
  // until the user grants media permission (browser privacy) — fall back to a
  // numbered name so the picker is still usable.
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

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 16px",
        borderTop: "1px solid #1b1e26",
        borderBottom: "1px solid #1b1e26",
        background: "#0d0f14",
      }}
    >
      <button
        type="button"
        onClick={() => instance.toggle()}
        style={{
          width: 38,
          height: 32,
          borderRadius: 6,
          border: "1px solid #2a2e3a",
          background: clock.playing ? "#c7ae7a" : "#161922",
          color: clock.playing ? "#0b0c0f" : "#e6e8ee",
          cursor: "pointer",
          fontSize: 14,
          fontWeight: 700,
        }}
        aria-label={clock.playing ? "Pause" : "Play"}
      >
        {clock.playing ? "❚❚" : "▶"}
      </button>

      <input
        type="range"
        min={0}
        max={lastFrame}
        step={1}
        value={clock.currentFrame}
        onMouseDown={() => instance.pause()}
        onChange={(e) => instance.seekTo(Number(e.target.value))}
        style={{ flex: 1, accentColor: "#c7ae7a", cursor: "pointer" }}
      />

      <div
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 13,
          color: "#c7c9d1",
          minWidth: 96,
          textAlign: "right",
        }}
      >
        {timecode(clock.currentFrame, clock.fps)}
      </div>
      <div
        style={{
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          color: "#6b7280",
          minWidth: 84,
        }}
      >
        f{clock.currentFrame} / {lastFrame}
      </div>

      <button
        type="button"
        onClick={() => onMutedChange(!muted)}
        aria-label={muted ? "Unmute" : "Mute"}
        title={muted ? "Unmute" : "Mute"}
        style={{
          width: 34,
          height: 30,
          borderRadius: 6,
          border: "1px solid #2a2e3a",
          background: "#161922",
          color: muted ? "#6b7280" : "#e6e8ee",
          cursor: "pointer",
          fontSize: 14,
        }}
      >
        {muted || volume === 0 ? "🔇" : "🔊"}
      </button>
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
        title="Volume"
        style={{ width: 88, accentColor: "#c7ae7a", cursor: "pointer" }}
      />

      {SINK_SUPPORTED && outputs.length > 0 && (
        <select
          value={sinkId}
          onChange={(e) => onSinkChange(e.target.value)}
          aria-label="Audio output device"
          title="Audio output device"
          style={{
            height: 30,
            maxWidth: 150,
            borderRadius: 6,
            border: "1px solid #2a2e3a",
            background: "#161922",
            color: "#c7c9d1",
            fontSize: 12,
            padding: "0 6px",
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
      )}
    </div>
  );
}
