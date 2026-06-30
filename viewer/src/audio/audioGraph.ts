// The TIER-2b WEB AUDIO GRAPH — multi-track, gain/fade-mixed audio playback slaved
// to the master clock (DESIGN-LIVE-PREVIEW.md §6 Tier 2b, §7, §8.6, §9 step 6).
//
// This replaces the Tier-0/1 "single hidden <video> carries the topmost clip's
// audio" stopgap (FootageStage) with a real mixer: each audio clip is an
// `AudioBufferSourceNode` scheduled sample-accurately on the shared `AudioContext`
// clock, routed through a per-clip gain (fades/automation) → a per-track gain bus
// (track volume) → a master gain (preview volume / mute). Multi-track gain + fade
// mixing is NOT sample-accurate through one `<video>`; this is the honest version
// the doc names (§6 "audio ownership — the honest version is the latter").
//
// ── SLAVED TO THE CLOCK (§3, §8.6) ───────────────────────────────────────────
// The graph's `AudioContext.currentTime` IS the master clock's time base (the clock
// calls `attachTimeSource(() => ctx.currentTime)`), so the audio it schedules and
// the playhead the compositor draws advance off the SAME monotonic clock — A/V is
// sample-locked, and 29.97 footage does not drift over minutes. Scheduling math
// mirrors OpenReel's `RealtimeAudioGraph.scheduleClip`:
//   contextWhen = ctx.currentTime + clipStartSec − timelineNowSec
// where `timelineNowSec` is the playhead in seconds. A clip already underway at the
// playhead is started immediately at the right media offset; a future clip is
// scheduled at its exact `when`.
//
// ── FRAME-EXACT (vean's invariant) ───────────────────────────────────────────
// Placement arrives as INTEGER timeline frames from `resolveAudio`. The ONLY
// frames→seconds conversion is here, at the schedule boundary, via the exact
// rational `frame * fps[1] / fps[0]` (never a float fps).
//
// ── LIFETIME ─────────────────────────────────────────────────────────────────
// Decoded `AudioBuffer`s are cached by clip `resource` (survives edits that only
// move a clip). Scheduled sources are stopped + disconnected on seek / re-schedule /
// stop (mirrors the compositor's `close()`-on-evict discipline for the audio side):
// a stale source left running would double-play after a seek.
import type { MasterClock } from "../clock";
import type { AudioClip, ResolvedAudio } from "../resolveAudio";
import type { Fps } from "../types";

/** A scheduled source plus its bookkeeping, so a re-schedule/seek can stop it. */
interface ScheduledSource {
  clipUuid: string;
  trackId: string;
  source: AudioBufferSourceNode;
  clipGain: GainNode;
}

/** Per-track mixer bus: the track gain (volume) feeding the master gain. */
interface TrackBus {
  trackId: string;
  gain: GainNode;
}

/** A small stats surface for the headless Tier-2b gate (`window.__veanAudio`): how
 *  many clips are scheduled, the context state, and the clock alignment, so the
 *  drive gate can assert the graph is live and A/V-locked without listening. */
export interface AudioGraphStats {
  contextState: AudioContextState;
  sampleRate: number;
  contextTime: number;
  scheduledClips: number;
  trackCount: number;
  bufferedResources: number;
  playing: boolean;
}

export class AudioGraph {
  private ctx: AudioContext;
  private masterGain: GainNode;
  private clock: MasterClock;
  private fps: Fps;

  /** Decoded source buffers, keyed by the clip `resource` (the fetch URL key). */
  private buffers = new Map<string, AudioBuffer>();
  /** In-flight buffer loads, so concurrent schedules for one resource await ONE
   *  fetch+decode. */
  private loading = new Map<string, Promise<AudioBuffer | null>>();
  /** Per-track gain buses. */
  private tracks = new Map<string, TrackBus>();
  /** Currently scheduled sources (stopped on seek / re-schedule). */
  private scheduled: ScheduledSource[] = [];

  /** The route scoping the `/api/media` allowlist for source fetches. */
  private route: string | undefined;
  /** The last resolved schedule (re-applied after buffers finish loading). */
  private lastResolved: ResolvedAudio | null = null;

  private masterVolume = 1;
  private muted = false;
  private playing = false;
  /** Output device id for `setSinkId` ("" = system default). */
  private sinkId = "";
  /** The STABLE time-source closure handed to the clock (`() => ctx.currentTime`).
   *  Created ONCE so `clock.attachTimeSource` is genuinely idempotent — a fresh
   *  closure each `resume()` would have a new identity, defeating the idempotence
   *  guard and re-anchoring the clock on every call (which sped the playhead up). */
  private readonly audioTimeSource: () => number;

  constructor(clock: MasterClock, fps: Fps, route: string | undefined) {
    this.clock = clock;
    this.fps = fps;
    this.route = route;
    // The AudioContext whose `currentTime` becomes the clock's time base. Created
    // suspended until a user gesture resumes it (autoplay policy); the clock keeps
    // wall-clock time until then, and attaches the audio time base on resume.
    const Ctor: typeof AudioContext =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor();
    this.audioTimeSource = () => this.ctx.currentTime;
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 1;
    this.masterGain.connect(this.ctx.destination);
    this.applyMasterGain();
  }

  /** Frames → seconds (exact rational; never a float fps). */
  private secondsForFrame(frame: number): number {
    return (frame * this.fps[1]) / this.fps[0];
  }

  /** The playhead position in timeline seconds (from the clock's integer frame). */
  private timelineNowSeconds(): number {
    return this.secondsForFrame(this.clock.getSnapshot().currentFrame);
  }

  // ── master / mixer controls ───────────────────────────────────────────────
  setVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    this.applyMasterGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyMasterGain();
  }

  private applyMasterGain(): void {
    const v = this.muted ? 0 : this.masterVolume;
    this.masterGain.gain.setValueAtTime(v, this.ctx.currentTime);
  }

  /** Route preview audio to a chosen output device (best-effort; ignored where
   *  `setSinkId` on an AudioContext is unsupported). */
  async setSinkId(sinkId: string): Promise<void> {
    this.sinkId = sinkId;
    const ctx = this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
    if (typeof ctx.setSinkId === "function") {
      try {
        await ctx.setSinkId(sinkId);
      } catch {
        /* unsupported sink — keep default output */
      }
    }
  }

  getSinkId(): string {
    return this.sinkId;
  }

  /** Resume the context (on a user gesture) and make the clock read this context's
   *  time as its time base, so the audio clock drives the playhead (A/V lock, §8.6).
   *  Called from the first pointer/key gesture's unlock and on play. */
  async resume(): Promise<void> {
    if (this.ctx.state === "suspended") {
      try {
        await this.ctx.resume();
      } catch {
        return;
      }
    }
    // Now that the context is running, slave the clock to it via the STABLE
    // time-source closure — same identity every call, so `attachTimeSource` is a
    // true no-op once attached (no per-call re-anchor). Re-anchoring is internal to
    // the clock (continuous `currentFrame` across the one real swap).
    this.clock.attachTimeSource(this.audioTimeSource);
  }

  getContext(): AudioContext {
    return this.ctx;
  }

  // ── track buses ────────────────────────────────────────────────────────────
  private ensureTrack(trackId: string): TrackBus {
    const existing = this.tracks.get(trackId);
    if (existing) return existing;
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    gain.connect(this.masterGain);
    const bus: TrackBus = { trackId, gain };
    this.tracks.set(trackId, bus);
    return bus;
  }

  // ── buffer loading (decodeAudioData of the source media) ───────────────────
  /** Fetch + decode a clip's source audio into an `AudioBuffer`, cached by resource.
   *  Streams the same `/api/media` source the footage path uses (Range-served, in
   *  the route allowlist). Returns null on a fetch/decode failure (a missing audio
   *  track, an unsupported container) — that clip is silently skipped. */
  private async loadBuffer(resource: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(resource);
    if (cached) return cached;
    const inflight = this.loading.get(resource);
    if (inflight) return inflight;
    const promise = (async () => {
      try {
        const url = mediaUrlFor(resource, this.route);
        const res = await fetch(url);
        if (!res.ok) return null;
        const bytes = await res.arrayBuffer();
        // decodeAudioData extracts + decodes the file's audio track to PCM.
        const buffer = await this.ctx.decodeAudioData(bytes);
        this.buffers.set(resource, buffer);
        return buffer;
      } catch {
        return null;
      } finally {
        this.loading.delete(resource);
      }
    })();
    this.loading.set(resource, promise);
    return promise;
  }

  // ── scheduling ─────────────────────────────────────────────────────────────
  /** Stop + disconnect every scheduled source (on seek / re-schedule / stop). A
   *  stale source left running would double-play after a seek. */
  private stopAll(): void {
    for (const s of this.scheduled) {
      try {
        s.source.onended = null;
        s.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        s.source.disconnect();
        s.clipGain.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.scheduled = [];
  }

  /** Replace the schedule from a freshly resolved audio set. Called on play, on a
   *  seek while playing, and after an edit changes the working IR (revision bump).
   *  Idempotent + latest-wins: it stops the old sources and schedules the new set
   *  from the CURRENT playhead. When paused, it only records the schedule (audio is
   *  silent until play); buffers still preload so play starts instantly. */
  schedule(resolved: ResolvedAudio): void {
    this.lastResolved = resolved;
    // Build the track buses for this schedule (idempotent).
    for (const trackId of resolved.trackIds) this.ensureTrack(trackId);

    if (!this.playing) {
      // Paused — preload the buffers so a subsequent play is instant, but schedule
      // nothing (no audible output while the playhead is parked).
      for (const clip of resolved.clips) void this.loadBuffer(clip.resource);
      return;
    }

    this.stopAll();
    const nowSec = this.timelineNowSeconds();
    for (const clip of resolved.clips) {
      // Skip clips wholly before the playhead (already over).
      const clipEndSec = this.secondsForFrame(clip.timelineEnd + 1);
      if (clipEndSec <= nowSec) continue;
      void this.scheduleClip(clip, nowSec);
    }
  }

  /** Schedule one audio clip on the graph, aligned to the audio-context clock.
   *  Mirrors OpenReel's `scheduleClip`: a clip starting in the future is scheduled
   *  at its exact `when`; a clip already underway is started immediately at the
   *  right media offset for the remainder. Gain (static × fade automation) is
   *  scheduled on the clip gain node so a fade ramps in audio-context time. */
  private async scheduleClip(clip: AudioClip, nowSec: number): Promise<void> {
    const buffer = await this.loadBuffer(clip.resource);
    // If a newer schedule replaced this one while we awaited the decode (a re-resolve
    // makes new clip objects, so identity-membership is the staleness check), or
    // playback stopped, drop this source so it can't double-play.
    if (!buffer || !this.playing || !this.lastResolved?.clips.includes(clip)) return;

    const bus = this.ensureTrack(clip.trackId);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;

    const clipGain = this.ctx.createGain();
    source.connect(clipGain);
    clipGain.connect(bus.gain);

    const clipStartSec = this.secondsForFrame(clip.timelineStart);
    const clipEndSec = this.secondsForFrame(clip.timelineEnd + 1);
    const mediaOffsetSec = this.secondsForFrame(clip.mediaOffset);
    const segLenSec = clipEndSec - clipStartSec;

    // `when` on the audio-context clock = ctx.now + (clipStart − timelineNow). The
    // clock's time base IS ctx.currentTime, so this aligns the source to the same
    // clock the playhead reads.
    const ctxNow = this.ctx.currentTime;
    const whenRaw = ctxNow + (clipStartSec - nowSec);

    let when: number;
    let sourceOffset: number;
    let playDuration: number;
    let gainStartTime: number;
    let gainOffsetSec: number; // seconds into the clip's segment the ramp starts

    if (whenRaw > ctxNow) {
      // Future clip — start at its exact `when`, full segment, from media offset.
      when = whenRaw;
      sourceOffset = mediaOffsetSec;
      playDuration = segLenSec;
      gainStartTime = when;
      gainOffsetSec = 0;
    } else {
      // Already underway — start now, mid-clip, for the remainder.
      const intoSec = nowSec - clipStartSec; // seconds already elapsed in the segment
      when = ctxNow;
      sourceOffset = mediaOffsetSec + intoSec;
      playDuration = segLenSec - intoSec;
      gainStartTime = ctxNow;
      gainOffsetSec = intoSec;
      if (playDuration <= 0 || sourceOffset >= buffer.duration) {
        source.disconnect();
        clipGain.disconnect();
        return;
      }
    }

    this.scheduleClipGain(clipGain, clip, gainStartTime, gainOffsetSec, playDuration);

    try {
      source.start(when, sourceOffset, playDuration);
    } catch {
      source.disconnect();
      clipGain.disconnect();
      return;
    }

    const scheduled: ScheduledSource = {
      clipUuid: clip.uuid,
      trackId: clip.trackId,
      source,
      clipGain,
    };
    this.scheduled.push(scheduled);
    source.onended = () => {
      const i = this.scheduled.indexOf(scheduled);
      if (i > -1) this.scheduled.splice(i, 1);
      try {
        source.disconnect();
        clipGain.disconnect();
      } catch {
        /* already disconnected */
      }
    };
  }

  /** Schedule the clip's gain ramp on its gain node. `baseGain` is the static
   *  multiplier; `gainAutomation` is the fade curve in SEGMENT FRAMES. We multiply
   *  the automation by `baseGain` and schedule a `setValueAtTime` + linear ramps in
   *  audio-context time, skipping points before `gainOffsetSec` (the part already
   *  elapsed when starting mid-clip). */
  private scheduleClipGain(
    gainNode: GainNode,
    clip: AudioClip,
    startTime: number,
    gainOffsetSec: number,
    playDuration: number,
  ): void {
    const base = clip.baseGain;
    gainNode.gain.cancelScheduledValues(startTime);
    if (clip.gainAutomation.length === 0) {
      gainNode.gain.setValueAtTime(base, startTime);
      return;
    }
    // Convert each automation frame to seconds-from-segment-start, then to a delta
    // from the (possibly mid-clip) start. Clamp to the play window.
    const points = clip.gainAutomation
      .map((p) => ({ sec: this.secondsForFrame(p.frame), value: p.value * base }))
      .sort((a, b) => a.sec - b.sec);

    // Initial value at the start offset (interpolated), so a mid-clip start lands on
    // the right level.
    const startValue = interpolateGain(points, gainOffsetSec);
    gainNode.gain.setValueAtTime(startValue, startTime);

    for (const p of points) {
      const delta = p.sec - gainOffsetSec;
      if (delta <= 0) continue; // already passed (handled by startValue)
      if (delta > playDuration) break; // beyond the play window
      gainNode.gain.linearRampToValueAtTime(p.value, startTime + delta);
    }
  }

  // ── transport ──────────────────────────────────────────────────────────────
  /** Begin audio playback from the current playhead. Resumes the context, slaves the
   *  clock to it, and schedules the last-resolved set. The CLOCK owns the frame
   *  advance; this only feeds the speakers in lock-step with it. */
  async play(resolved: ResolvedAudio): Promise<void> {
    this.playing = true;
    await this.resume();
    this.schedule(resolved);
  }

  /** Stop audio (on pause / unmount). Silences every source; the clock keeps its
   *  position. Does NOT detach the time base — a paused audio context still reports a
   *  stable `currentTime`, and re-play re-anchors. */
  pause(): void {
    this.playing = false;
    this.stopAll();
  }

  /** Re-align audio to the playhead after a SEEK while playing — stop + reschedule
   *  from the new position. A no-op while paused (nothing is sounding). */
  reseek(): void {
    if (!this.playing || !this.lastResolved) return;
    this.schedule(this.lastResolved);
  }

  getStats(): AudioGraphStats {
    return {
      contextState: this.ctx.state,
      sampleRate: this.ctx.sampleRate,
      contextTime: this.ctx.currentTime,
      scheduledClips: this.scheduled.length,
      trackCount: this.tracks.size,
      bufferedResources: this.buffers.size,
      playing: this.playing,
    };
  }

  /** Tear down the graph (on unmount). Stops sources, disconnects the buses + master,
   *  reverts the clock to wall-clock, and closes the context. */
  dispose(): void {
    this.playing = false;
    this.stopAll();
    for (const bus of this.tracks.values()) {
      try {
        bus.gain.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.tracks.clear();
    this.buffers.clear();
    this.loading.clear();
    try {
      this.masterGain.disconnect();
    } catch {
      /* already disconnected */
    }
    // Hand the clock back to wall-clock so the playhead keeps advancing without us.
    this.clock.detachTimeSource();
    void this.ctx.close().catch(() => {});
  }
}

/** Interpolate a gain value at `sec` from sorted `{sec,value}` points. Holds the
 *  endpoints outside the range. */
function interpolateGain(points: Array<{ sec: number; value: number }>, sec: number): number {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return 1;
  if (sec <= first.sec) return first.value;
  if (sec >= last.sec) return last.value;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (!a || !b) continue;
    if (sec >= a.sec && sec <= b.sec) {
      const span = b.sec - a.sec;
      if (span <= 0) return b.value;
      return a.value + (b.value - a.value) * ((sec - a.sec) / span);
    }
  }
  return last.value;
}

/** Build the `/api/media` URL for a source resource (mirror of `api.ts mediaUrl`,
 *  kept local so the audio module has no cross-import beyond types). */
function mediaUrlFor(resource: string, route: string | undefined): string {
  const qs = new URLSearchParams({ path: resource });
  if (route) qs.set("route", route);
  return `/api/media?${qs.toString()}`;
}
