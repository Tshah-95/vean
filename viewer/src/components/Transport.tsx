// Transport: play/pause, a frame scrubber, and the timecode readout. Every
// control writes through the master clock (clock.play/pause/seekTo) — the clock
// is the only writer of currentFrame; the <video> and <Player> follow.
import { useClock, useClockInstance } from "../ClockProvider";
import type { Fps } from "../types";

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

export function Transport() {
  const clock = useClock();
  const instance = useClockInstance();
  const lastFrame = Math.max(0, clock.totalFrames - 1);

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
    </div>
  );
}
