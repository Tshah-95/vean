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
// Playback driver: a SINGLE requestAnimationFrame loop is the master clock during
// play. It computes the frame from wall-clock elapsed time, advances
// `currentFrame`, and pushes both layers. The <video>'s own timeupdate is NOT the
// master (too coarse — it would desync the Player); the proxy <video> plays only
// to carry AUDIO, and the RAF clock owns the integer frame number.
import type { Fps } from "./types";

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
  private playStartWall = 0;
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

  // ── config ──────────────────────────────────────────────────────────────
  configure(fps: Fps, totalFrames: number): void {
    this.pause();
    this.emit({
      fps,
      totalFrames: Math.max(1, totalFrames),
      currentFrame: Math.min(this.state.currentFrame, Math.max(0, totalFrames - 1)),
    });
  }

  // ── transport ─────────────────────────────────────────────────────────
  seekTo(frame: number): void {
    const clamped = Math.max(0, Math.min(Math.round(frame), this.state.totalFrames - 1));
    if (this.state.playing) {
      // Re-anchor the RAF loop so playback continues from the new frame.
      this.playStartWall = performance.now();
      this.playStartFrame = clamped;
    }
    if (clamped !== this.state.currentFrame) this.emit({ currentFrame: clamped });
  }

  play(): void {
    if (this.state.playing) return;
    if (this.state.currentFrame >= this.state.totalFrames - 1) {
      this.emit({ currentFrame: 0 });
    }
    this.playStartWall = performance.now();
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
    const elapsedMs = performance.now() - this.playStartWall;
    const frame = this.playStartFrame + Math.round((elapsedMs * num) / den / 1000);
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
