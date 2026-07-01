// Transport: timecode (left) · skip-back / play / skip-forward (CENTER) · audio
// menu (right). Every control writes through the master clock — the clock is the
// only writer of currentFrame; the <video> and <Player> follow.
//
// No scrub slider (the TIMELINE is the seek surface) and no frame counter (the
// timecode carries it). Skip buttons jump to the previous/next EDIT POINT (clip
// boundaries), the pro-NLE convention. Audio is ONE speaker button opening the
// macOS-Sound-menu pattern: a horizontal volume slider row, then the output
// devices as check-items — built on the shadcn dropdown/slider primitives.
import { Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Slider } from "@/components/ui/slider";
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
  /** Sorted unique clip boundaries (timeline frames) — the skip-button targets. */
  editPoints: number[];
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
  editPoints,
  volume,
  muted,
  onVolumeChange,
  onMutedChange,
  sinkId,
  onSinkChange,
}: TransportProps) {
  const clock = useClock();
  const instance = useClockInstance();

  // Enumerate audio OUTPUT devices for the menu.
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

  const skip = (dir: -1 | 1) => {
    const f = clock.currentFrame;
    const target =
      dir === 1
        ? (editPoints.find((p) => p > f) ?? Math.max(0, clock.totalFrames - 1))
        : ([...editPoints].reverse().find((p) => p < f) ?? 0);
    instance.pause();
    instance.seekTo(target);
  };

  const audioOff = muted || volume === 0;

  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center border-y border-border-faint bg-header px-3.5 py-1.5">
      {/* left: where we are */}
      <div className="justify-self-start font-mono text-[13px] text-foreground">
        {timecode(clock.currentFrame, clock.fps)}
      </div>

      {/* center: the transport cluster */}
      <div className="flex items-center gap-1 justify-self-center">
        <Button size="icon" onClick={() => skip(-1)} aria-label="Previous edit point" title="Previous edit point">
          <SkipBack size={14} strokeWidth={1.75} />
        </Button>
        <Button
          size="icon"
          variant={clock.playing ? "default" : "ghost"}
          onClick={() => instance.toggle()}
          aria-label={clock.playing ? "Pause" : "Play"}
          title={`${clock.playing ? "Pause" : "Play"} ( space )`}
        >
          {clock.playing ? <Pause size={15} strokeWidth={1.75} /> : <Play size={15} strokeWidth={1.75} />}
        </Button>
        <Button size="icon" onClick={() => skip(1)} aria-label="Next edit point" title="Next edit point">
          <SkipForward size={14} strokeWidth={1.75} />
        </Button>
      </div>

      {/* right: audio */}
      <div className="justify-self-end">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon" aria-label="Audio" title="Volume + audio output">
              {audioOff ? <VolumeX size={15} strokeWidth={1.75} /> : <Volume2 size={15} strokeWidth={1.75} />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end" className="w-[220px]">
            <div className="flex items-center gap-2 px-2 py-2">
              <button
                type="button"
                onClick={() => onMutedChange(!muted)}
                aria-label={muted ? "Unmute" : "Mute"}
                title={muted ? "Unmute" : "Mute"}
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60"
              >
                {audioOff ? <VolumeX size={14} strokeWidth={1.75} /> : <Volume2 size={14} strokeWidth={1.75} />}
              </button>
              <Slider
                value={[muted ? 0 : Math.round(volume * 100)]}
                max={100}
                step={1}
                aria-label="Volume"
                onValueChange={([v]) => {
                  const vol = (v ?? 0) / 100;
                  onVolumeChange(vol);
                  if (vol > 0 && muted) onMutedChange(false);
                }}
              />
              <span className="w-7 shrink-0 text-right font-mono text-[10px] text-muted-foreground">
                {muted ? 0 : Math.round(volume * 100)}
              </span>
            </div>
            {SINK_SUPPORTED && outputs.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Output</DropdownMenuLabel>
                <DropdownMenuCheckboxItem
                  checked={sinkId === ""}
                  onCheckedChange={() => onSinkChange("")}
                >
                  System default
                </DropdownMenuCheckboxItem>
                {outputs.map((o) => (
                  <DropdownMenuCheckboxItem
                    key={o.id}
                    checked={sinkId === o.id}
                    onCheckedChange={() => onSinkChange(o.id)}
                  >
                    {o.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
