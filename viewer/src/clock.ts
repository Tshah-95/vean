// The MASTER CLOCK — the single source of truth for the playhead. This is the
// load-bearing sync contract of the live viewer (Move 5 gate: "seeking the master
// clock moves the slaved <Player>" and the footage <video> together).
//
// ONE writer of `currentFrame`. Transport (play/pause/seek/scrub) and the strip
// playhead all call `clock.seekTo(frame)` / `clock.play()` / `clock.pause()`.
// Every `currentFrame` change emits to subscribers; two of them slave to it:
//   1. the footage proxy <video>: video.currentTime = frame * fps[1] / fps[0]
//      (only when the delta exceeds ~1 frame, to avoid feedback during playback).
//   2. the @remotion/player: playerRef.seekTo(frame).
//
// Playback driver: a SINGLE requestAnimationFrame loop drives the playhead during
// play. It computes the integer frame from elapsed time on the CLOCK'S TIME SOURCE,
// advances `currentFrame`, and pushes all layers. The <video>'s own timeupdate is
// NOT the master (too coarse — it would desync the Player); the RAF loop owns the
// integer frame number.
//
// ── TIME SOURCE: wall-clock (video-only) → AudioContext (audio online) ─────────
// The clock's TIME BASE is an injectable monotonic seconds source (`timeSource`),
// defaulting to `performance.now()/1000`. When the Web Audio graph comes online
// (Tier 2b, §3 / §6 / §8.6), `attachTimeSource(() => audioContext.currentTime)`
// makes the SAME `AudioContext.currentTime` that schedules the audio sources also
// drive the playhead — so A/V is sample-locked and 29.97 footage does not desync
// over minutes (a direct violation of the rational-time invariant if measured in
// float `performance.now()` ms). The public surface (`seekTo`/`play`/`pause`, one
// `currentFrame` writer) is unchanged — only the internal `now()` it reads changes.
// All frame math stays EXACT integer-rational: `frame = anchorFrame + round(elapsed
// * num / den)`, never a float fps. Re-anchoring on attach/seek keeps `currentFrame`
// continuous across a time-source swap.
import type { Fps } from "./types";

/** A monotonic time source in SECONDS (the semantics of `AudioContext.currentTime`
 *  and `performance.now()/1000`). Injectable so the clock's time base can switch
 *  from wall-clock to the audio clock without changing its public surface. */
export type TimeSource = () => number;

/** The default (video-only) time source: wall-clock seconds. */
const wallClockSeconds: TimeSource = () => performance.now() / 1000;

export interface ClockState {
  /** Integer master playhead. */
  currentFrame: number;
  playing: boolean;
  totalFrames: number;
  fps: Fps;
}

type Listener = () => void;

const EMPTY_FPS: Fps = [30, 1];

export class MasterClock {
  private state: ClockState = {
    currentFrame: 0,
    playing: false,
    totalFrames: 1,
    fps: EMPTY_FPS,
  };
  private listeners = new Set<Listener>();
  private raf: number | null = null;
  /** The clock's TIME BASE (seconds). Wall-clock by default; swapped to
   *  `AudioContext.currentTime` once the audio graph attaches (Tier 2b). */
  private timeSource: TimeSource = wallClockSeconds;
  /** The time-source reading (seconds) at which the current play span began. */
  private playStartTime = 0;
  private playStartFrame = 0;

  // ── store plumbing (useSyncExternalStore) ──────────────────────────────
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ClockState => this.state;

  private emit(next: Partial<ClockState>): void {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  // ── frame ⇄ seconds (exact rational; never a float fps constant) ────────
  secondsForFrame(frame: number): number {
    const [num, den] = this.state.fps;
    return (frame * den) / num;
  }

  frameForSeconds(seconds: number): number {
    const [num, den] = this.state.fps;
    return Math.round((seconds * num) / den);
  }

  // ── time source (wall-clock ⇄ AudioContext) ───────────────────────────────
  /** Swap the clock's time base to `source` (seconds), re-anchoring the current
   *  play span so `currentFrame` is continuous across the swap. Tier 2b calls this
   *  with `() => audioContext.currentTime` once the Web Audio graph is live, so the
   *  audio clock that schedules the sources also drives the playhead (A/V lock,
   *  §8.6). Idempotent: re-attaching the same source is a no-op. */
  attachTimeSource(source: TimeSource): void {
    if (this.timeSource === source) return;
    // Re-anchor BEFORE swapping so the new source continues from the current frame:
    // pin the play span's start to "now" on the NEW source at the current frame.
    this.timeSource = source;
    if (this.state.playing) {
      this.playStartTime = source();
      this.playStartFrame = this.state.currentFrame;
    }
  }

  /** Revert to the wall-clock time base (e.g. the audio graph tore down). Re-anchors
   *  the same way as `attachTimeSource`. */
  detachTimeSource(): void {
    this.attachTimeSource(wallClockSeconds);
  }

  /** The current time-source reading (seconds). Exposed so the audio graph can align
   *  its scheduling math (`when = ctx.currentTime + clipStart − clockTime`) to the
   *  exact same clock the playhead reads. */
  now(): number {
    return this.timeSource();
  }

  // ── config ──────────────────────────────────────────────────────────────
  configure(fps: Fps, totalFrames: number): void {
    this.pause();
    this.emit({
      fps,
      totalFrames: Math.max(1, totalFrames),
      currentFrame: Math.min(this.state.currentFrame, Math.max(0, totalFrames - 1)),
    });
  }

  /** Update the total-frame bound WITHOUT pausing — the live edit path. A ripple /
   *  trim that changes the working IR's length must move the playhead clamp so the
   *  footage stage can resolve frames the edit just created or removed, but it must
   *  NOT interrupt playback or fight the load-time `configure`. Re-anchors the RAF
   *  loop if the clamp moved the current frame mid-play. A no-op when unchanged, so
   *  it is safe to call from an effect keyed on the working IR's length. */
  setTotalFrames(totalFrames: number): void {
    const next = Math.max(1, totalFrames);
    if (next === this.state.totalFrames) return;
    const clampedFrame = Math.min(this.state.currentFrame, next - 1);
    if (this.state.playing && clampedFrame !== this.state.currentFrame) {
      this.playStartTime = this.timeSource();
      this.playStartFrame = clampedFrame;
    }
    this.emit({ totalFrames: next, currentFrame: clampedFrame });
  }

  // ── transport ─────────────────────────────────────────────────────────
  seekTo(frame: number): void {
    const clamped = Math.max(0, Math.min(Math.round(frame), this.state.totalFrames - 1));
    if (this.state.playing) {
      // Re-anchor the RAF loop so playback continues from the new frame.
      this.playStartTime = this.timeSource();
      this.playStartFrame = clamped;
    }
    if (clamped !== this.state.currentFrame) this.emit({ currentFrame: clamped });
  }

  play(): void {
    if (this.state.playing) return;
    if (this.state.currentFrame >= this.state.totalFrames - 1) {
      this.emit({ currentFrame: 0 });
    }
    this.playStartTime = this.timeSource();
    this.playStartFrame = this.state.currentFrame;
    this.emit({ playing: true });
    this.tick();
  }

  pause(): void {
    if (this.raf != null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
    if (this.state.playing) this.emit({ playing: false });
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  private tick = (): void => {
    if (!this.state.playing) return;
    const [num, den] = this.state.fps;
    // Exact integer-rational advance off the clock's TIME SOURCE (seconds): frame =
    // anchorFrame + round(elapsedSeconds × num / den). The time source is wall-clock
    // for video-only and `AudioContext.currentTime` once audio is online — same
    // formula either way, so A/V is locked without a float fps anywhere (§8.6).
    const elapsedSeconds = this.timeSource() - this.playStartTime;
    const frame = this.playStartFrame + Math.round((elapsedSeconds * num) / den);
    if (frame >= this.state.totalFrames - 1) {
      this.emit({ currentFrame: this.state.totalFrames - 1, playing: false });
      this.raf = null;
      return;
    }
    if (frame !== this.state.currentFrame) this.emit({ currentFrame: frame });
    this.raf = requestAnimationFrame(this.tick);
  };

  dispose(): void {
    this.pause();
    this.listeners.clear();
  }
}
