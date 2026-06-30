// The TIER-1 FOOTAGE STAGE — the live, no-save, multi-track footage COMPOSITOR
// (DESIGN-LIVE-PREVIEW.md §4, §6 Tier 1, §7, §9 step 4).
//
// This is the real `renderFrame(ir, frame)` half of the no-save edit loop. It
// replaces the Tier-0 single pooled-`<video>` with a WebGL2 `<canvas>` compositor
// (`GlCompositor`) that draws the FULL resolved z-stack at the playhead:
//   • `color` clips     → solid-fill quads (§7 exact),
//   • footage clips     → decoded frames (mediabunny → ImageBitmap) as textured
//                         quads, over-composited by track z-order (§7 exact),
//   • same-track dissolves → `gl-transitions` fade/luma between from+to (§7 exact),
//   • per-clip fades/opacity → resolved to a concrete alpha upstream (§4 step 3).
// The `@remotion/player` overlay (PreviewPane) draws ON TOP, transparent regions
// revealing this composite — two compositors, one editor track (the Remotion seam).
//
// THE LIVENESS CONTRACT ("HMR for video"): recomposite on EVERY `(currentFrame,
// revision)` change. An edit mutates the working IR + bumps `revision` → the
// resolve re-runs against the new IR → the compositor repaints, with NO save, NO
// `/api/proxy-render`, NO `melt` in the loop (§0, §4). `melt` re-enters ONLY as the
// opt-in per-frame still fallback for `approximate` services (§6.3).
//
// DECODE + LIFETIME (§5, §8.3 — the dominant failure mode): footage frames are
// decoded off-thread via the mediabunny `ParallelDecoder` POOL (Tier 2a, §9 step 5
// — N=min(cores,4) workers, least-busy + per-clip affinity, in-flight cap by COUNT,
// and a GENERATION COUNTER that cancels stale seeks so scrubbing never lags). The
// decoded frames live in a `FrameCache`: a byte-bounded LRU keyed by
// `(producerUUID, sourceFrame)` (survives ripple/trim edits that only reposition a
// clip) that `close()`s every evicted/replaced `ImageBitmap` — forgetting `close()`
// OOMs the GPU within seconds of scrubbing. The compositor never retains a bitmap
// after a draw.
//
// DECODE-AHEAD (Tier 2a, §5): after each composite, the missing frames around the
// playhead are warmed into the pool (priority = distance to the playhead), so a
// forward scrub lands on already-decoded frames. A fresh seek bumps the generation,
// canceling stale preload work.
//
// AUDIO (Tier 2b, §6 / §8.6, §9 step 6): a `Web Audio graph` (`AudioGraph`) slaved
// to the master clock mixes EVERY audio track — per-clip `AudioBufferSourceNode`s
// through per-clip gain (fades) → per-track gain (volume) → master gain (preview
// volume/mute). The clock's time base becomes this graph's `AudioContext.currentTime`
// so A/V is sample-locked (no 29.97 drift over minutes). This REPLACES the Tier-0/1
// single-hidden-`<video>` stopgap; multi-track gain/fade mixing was never
// sample-accurate through one element.
import { useCallback, useEffect, useRef, useState } from "react";
import { useClock, useClockInstance } from "../ClockProvider";
import { renderStill } from "../api";
import { AudioGraph } from "../audio/audioGraph";
import { type FootageProvider, type FrameImage, GlCompositor } from "../compositor/glCompositor";
import { sourceProxyUrl } from "../decode/decoder";
import { FrameCache } from "../decode/frameCache";
import { ParallelDecoder } from "../decode/parallelDecoder";
import { resolveAudio } from "../resolveAudio";
import { type FootageLayer, type Layer, resolveLayers } from "../resolveLayers";
import type { Fps, Timeline } from "../types";

export interface FootageStageProps {
  /** The LIVE working IR the compositor resolves at the playhead (no save). */
  timeline: Timeline;
  /** The session's monotonic edit revision — the HMR trigger (§3, §4). */
  revision: number;
  fps: Fps;
  /** Profile pixel size (the compositor's drawing-buffer + decode-box size). */
  width: number;
  height: number;
  /** The active route, scoping the `/api/media` + `/api/source-proxy` allowlist. */
  route: string | undefined;
  /** Playback volume 0–1 (applied to the hidden audio-source element). */
  volume: number;
  muted: boolean;
  /** Output device id for setSinkId ("" = system default). */
  sinkId: string;
}

/** Debounce window for a revision-only repaint (OpenReel `Preview.tsx:4835`). */
const EDIT_DEBOUNCE_MS = 150;

/** Decoded-frame LRU cap, in BYTES (§5, §8.3). ~4·w·h bytes/frame; ~500MB holds a
 *  generous scrub window of 1080p frames. */
const CACHE_MAX_BYTES = 500 * 1024 * 1024;

/** Max decode-box edge — caps the compositor + decode resolution for the live path
 *  (OpenCut's `isPreview` 2048px cap, `scene-builder.ts:102`). The profile is the
 *  natural target; we never upscale past it. */
const MAX_EDGE = 2048;

/** Cap on preload decodes dispatched per composite, so a burst can't flood the
 *  pool's queue (the on-demand current-frame decode always goes first). */
const MAX_PRELOAD_PER_TICK = 6;

/** The measured perf snapshot published on `window.__veanPerf` for the Tier-2a
 *  gate (§6 Tier 2): composite fps + cache/decoder stats, read headlessly via
 *  `agent-browser` to assert steady fps + bounded GPU memory across a scrub. */
interface VeanPerf {
  compositeAvgMs: number;
  compositeMedianMs: number;
  compositeFps: number;
  samples: number;
  cache: ReturnType<FrameCache["getStats"]>;
  decoder: ReturnType<ParallelDecoder["getStats"]> | null;
}
type VeanPerfWindow = Window & { __veanPerf?: VeanPerf };

export function FootageStage({
  timeline,
  revision,
  fps,
  width,
  height,
  route,
  volume,
  muted,
  sinkId,
}: FootageStageProps) {
  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clock = useClock();
  const clockInstance = useClockInstance();

  // The decode box — the profile size clamped to MAX_EDGE (keeps aspect).
  const boxW = useRef(0);
  const boxH = useRef(0);
  {
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    boxW.current = Math.max(1, Math.round(width * scale));
    boxH.current = Math.max(1, Math.round(height * scale));
  }

  const compositor = useRef<GlCompositor | null>(null);
  // The Tier-2a decode POOL (N workers, generation-counter cancel) + the byte-
  // bounded LRU it feeds (close()-on-evict). Both imperative (refs) so a decode
  // completing repaints without a React re-render.
  const decoder = useRef<ParallelDecoder | null>(null);
  const cache = useRef<FrameCache>(new FrameCache({ maxSizeBytes: CACHE_MAX_BYTES }));
  // In-flight decode keys (so we never double-request the same frame in a tick).
  const decoding = useRef<Set<string>>(new Set());

  // ── perf instrumentation (the Tier-2a gate reads `window.__veanPerf`) ────────
  // A rolling window of composite wall-times → fps, plus the cache + pool stats
  // (resident bytes, hitRate, evictions, stale-dropped). This is the measured
  // before/after surface §6 Tier 2's gate asserts (steady fps under one frame
  // budget; bounded GPU memory across a scrub — every evicted bitmap close()d).
  const compositeTimes = useRef<number[]>([]);
  const recordComposite = useCallback((ms: number) => {
    const arr = compositeTimes.current;
    arr.push(ms);
    if (arr.length > 120) arr.shift(); // ~last 120 composites
    const w = window as VeanPerfWindow;
    const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sorted = [...arr].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    w.__veanPerf = {
      compositeAvgMs: avg,
      compositeMedianMs: median,
      compositeFps: avg > 0 ? 1000 / avg : 0,
      samples: arr.length,
      cache: cache.current.getStats(),
      decoder: decoder.current?.getStats() ?? null,
    };
  }, []);

  // Single in-flight composite + latest-(frame,revision) coalescing.
  const composing = useRef(false);
  const pending = useRef<{ frame: number; revision: number } | null>(null);
  const editTimer = useRef<number | null>(null);

  // Whether the playhead sits over any footage/solid layer (else the box is empty).
  const [hasContent, setHasContent] = useState(true);
  // Whether the current frame has an `approximate` service (the melt-still
  // affordance; §6.3). Surfaced so the pane can offer "show exact frame".
  const [approximate, setApproximate] = useState(false);
  // The on-demand `melt`-still fallback (§6.3): the ONLY place `melt` re-enters
  // preview — opt-in, per-frame, never in the scrub loop. When the user requests
  // an exact frame for an `approximate` composite, fetch ONE still from
  // `/api/still` and overlay it; it is for THAT exact frame, so it clears the
  // instant the playhead moves. `stillUrl` is the overlay; `stillFrame` pins it to
  // its frame; `stillBusy` guards a single in-flight request.
  const [stillUrl, setStillUrl] = useState<string | null>(null);
  const stillFrame = useRef<number | null>(null);
  const [stillBusy, setStillBusy] = useState(false);

  // Request the exact `melt` still for the CURRENT frame (the §6.3 fallback). One
  // request at a time; the result is the overlay image. Cached server-side by frame
  // (the still endpoint writes `still-<frame>.png`), so re-requesting is cheap.
  const requestExactStill = useCallback(async () => {
    if (stillBusy) return;
    const frame = clockInstance.getSnapshot().currentFrame;
    setStillBusy(true);
    try {
      const res = await renderStill(frame, route);
      stillFrame.current = frame;
      // Cache-bust so a re-render of the same frame (after an edit) re-fetches.
      setStillUrl(`${res.stillUrl}?f=${frame}&r=${Date.now()}`);
    } catch (err) {
      console.error("vean: exact-still fallback failed", err);
    } finally {
      setStillBusy(false);
    }
  }, [stillBusy, route, clockInstance]);

  const secondsForFrame = useCallback((frame: number) => (frame * fps[1]) / fps[0], [fps]);

  const frameKey = (uuid: string, sourceFrame: number) => `${uuid}@${sourceFrame}`;

  // Kick an off-thread decode for one `(uuid, sourceFrame)` through the POOL, into
  // the FrameCache, and recomposite the current playhead when it lands. Deduped by
  // `decoding` so a frame is never double-requested. Used by BOTH the on-demand
  // provider (current frame, miss) and the decode-ahead warmer (§5).
  const requestDecode = useCallback(
    (uuid: string, resource: string, sourceFrame: number) => {
      const key = frameKey(uuid, sourceFrame);
      if (decoding.current.has(key) || cache.current.has(uuid, sourceFrame)) return;
      const dec = decoder.current;
      if (!dec) return;
      decoding.current.add(key);
      const seconds = secondsForFrame(sourceFrame);
      dec
        .decodeAt(uuid, sourceProxyUrl(resource, route), seconds, boxW.current, boxH.current)
        .then((decoded) => {
          decoding.current.delete(key);
          if (!decoded) return; // null = no frame / failed / canceled by a newer seek
          // The cache TAKES OWNERSHIP and close()s on evict/replace (§8.3).
          cache.current.set(uuid, sourceFrame, decoded.bitmap);
          // A frame landed — recomposite the CURRENT playhead so it appears.
          scheduleComposite(clockInstance.getSnapshot().currentFrame, revision, true);
        })
        .catch(() => {
          decoding.current.delete(key);
        });
    },
    // scheduleComposite is stable (defined below via ref); revision captured live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [secondsForFrame, route, revision, clockInstance],
  );

  // The synchronous provider the compositor pulls each footage layer through: a
  // cache hit returns the bitmap; a miss returns null (layer below shows through)
  // and kicks off an async pooled decode that recomposites on completion.
  const provideFootage: FootageProvider = useCallback(
    (layer: FootageLayer): FrameImage => {
      const hit = cache.current.get(layer.uuid, layer.sourceFrame);
      if (hit) return hit;
      requestDecode(layer.uuid, layer.resource, layer.sourceFrame);
      return null;
    },
    [requestDecode],
  );

  // Decode-ahead (§5): warm the source frames around the playhead for each footage
  // layer live at `frame`, so a forward scrub lands on already-decoded frames. The
  // FrameCache computes the missing set in integer source frames (nearest-first);
  // we dispatch a bounded slice per tick so preload never starves the on-demand
  // current-frame decode or floods the pool queue. The generation counter (bumped
  // on seek) cancels stale preload work in flight.
  const warmAhead = useCallback(
    (frame: number) => {
      const dec = decoder.current;
      if (!dec) return;
      const resolved = resolveLayers(timeline, frame);
      let dispatched = 0;
      const footage: FootageLayer[] = [];
      for (const l of resolved.layers) {
        if (l.kind === "footage") footage.push(l);
        else if (l.kind === "dissolve") {
          if (l.from.kind === "footage") footage.push(l.from);
          if (l.to.kind === "footage") footage.push(l.to);
        }
      }
      for (const l of footage) {
        if (dispatched >= MAX_PRELOAD_PER_TICK) break;
        const missing = cache.current.missingPreloadFrames(l.uuid, l.sourceFrame, l.in, l.out);
        for (const sf of missing) {
          if (dispatched >= MAX_PRELOAD_PER_TICK) break;
          if (decoding.current.has(frameKey(l.uuid, sf))) continue;
          requestDecode(l.uuid, l.resource, sf);
          dispatched++;
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [timeline, requestDecode],
  );

  // The composite core: resolve the z-stack off the LIVE IR at `frame`, draw it,
  // record perf, then warm the decode-ahead window.
  const composite = useCallback(
    (frame: number) => {
      const comp = compositor.current;
      if (!comp) return;
      const t0 = performance.now();
      const resolved = resolveLayers(timeline, frame);
      const layers: Layer[] = resolved.layers;
      setHasContent(layers.length > 0);
      setApproximate(resolved.hasApproximate);
      comp.resize(boxW.current, boxH.current);
      comp.render(layers, provideFootage);
      recordComposite(performance.now() - t0);
      warmAhead(frame);
    },
    // recordComposite is stable (ref-backed); warmAhead/provideFootage tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, provideFootage, warmAhead],
  );

  // Single-in-flight composite with latest-wins coalescing. `force` bypasses the
  // in-flight guard's coalescing collapse for a decode-completion repaint.
  const scheduleCompositeRef = useRef<(frame: number, rev: number, force?: boolean) => void>(
    () => {},
  );
  const scheduleComposite = useCallback(
    (frame: number, rev: number, force = false) => scheduleCompositeRef.current(frame, rev, force),
    [],
  );
  useEffect(() => {
    scheduleCompositeRef.current = (frame: number, rev: number, _force = false) => {
      if (composing.current) {
        pending.current = { frame, revision: rev };
        return;
      }
      composing.current = true;
      try {
        composite(frame);
      } finally {
        composing.current = false;
        const next = pending.current;
        pending.current = null;
        if (next) scheduleCompositeRef.current(next.frame, next.revision);
      }
    };
  }, [composite]);

  // Last (frame, revision) the HMR effect acted on — declared before the init
  // effect so both can seed them (the init effect sets the baseline; the HMR
  // effect diffs against it).
  const lastFrame = useRef(clock.currentFrame);
  const lastRevision = useRef(revision);
  // The last frame the HMR effect actually composited — used to detect a discrete
  // SCRUB (a jump) vs smooth playback for the generation-counter cancel below.
  const prevAppliedFrame = useRef(clock.currentFrame);

  // ── init the compositor + decoder, and paint the first frame ───────────────
  // The first paint is owned HERE (not by a `firstPaint` ref in the HMR effect):
  // under React StrictMode the component double-mounts (setup → cleanup → setup),
  // and a `firstPaint` ref set false on the first setup would never re-arm for the
  // SECOND (live) compositor — leaving the canvas black (the bug this fixes). By
  // compositing right after construction, every (re)mount paints its own current
  // frame immediately. `lastFrame`/`lastRevision` are seeded here too so the HMR
  // effect only fires on a REAL change after this baseline.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      compositor.current = new GlCompositor(canvas);
    } catch (err) {
      // WebGL2 unavailable — leave the canvas blank; the overlay still draws. The
      // pane surfaces the gap via `hasContent`.
      console.error("vean compositor: WebGL2 init failed", err);
    }
    decoder.current = new ParallelDecoder();
    // Paint the current frame off the live IR immediately (the baseline frame).
    const snap = clockInstance.getSnapshot();
    lastFrame.current = snap.currentFrame;
    lastRevision.current = revision;
    scheduleComposite(snap.currentFrame, revision);
    return () => {
      compositor.current?.dispose();
      compositor.current = null;
      decoder.current?.dispose();
      decoder.current = null;
      cache.current.clear(); // close()s every resident bitmap (§8.3)
      decoding.current.clear();
    };
    // Re-init only on a compositor-identity change (canvas remount). The HMR effect
    // owns frame/revision reactivity; this owns lifecycle + the baseline paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clockInstance, scheduleComposite]);

  // ── The HMR effect: recomposite on (currentFrame, revision) ────────────────
  useEffect(() => {
    const frameChanged = clock.currentFrame !== lastFrame.current;
    const revisionChanged = revision !== lastRevision.current;
    lastFrame.current = clock.currentFrame;
    lastRevision.current = revision;

    // The exact-still overlay is pinned to ONE frame — clear it the moment the
    // playhead leaves that frame (or an edit changes the composite), so the live
    // compositor is always what's shown except where the user explicitly froze it.
    if ((frameChanged || revisionChanged) && stillFrame.current !== clock.currentFrame) {
      if (stillUrl) setStillUrl(null);
      stillFrame.current = null;
    }

    if (!frameChanged && !revisionChanged) return; // baseline handled by init effect

    // Stale-seek cancel (OpenCut's generation counter): a discrete SCRUB (a jump of
    // more than a few frames while NOT playing) bumps every clip's generation, so
    // in-flight/queued decodes for the position the user just left resolve to null
    // and free the pool for the new position — the scrub-lag killer (§5, §8). Smooth
    // playback (±1 frame/tick) and the steady forward decode-ahead it primes are NOT
    // a seek, so they must NOT bump (that would cancel the very preload work just
    // dispatched). A bump that lands a frame already cached still hits the cache.
    const jumped = Math.abs(clock.currentFrame - prevAppliedFrame.current) > 2;
    if (frameChanged && jumped && !clock.playing) decoder.current?.bumpGeneration();
    prevAppliedFrame.current = clock.currentFrame;

    if (frameChanged || clock.playing) {
      if (editTimer.current != null) {
        window.clearTimeout(editTimer.current);
        editTimer.current = null;
      }
      scheduleComposite(clock.currentFrame, revision);
    } else if (revisionChanged) {
      if (editTimer.current != null) window.clearTimeout(editTimer.current);
      editTimer.current = window.setTimeout(() => {
        editTimer.current = null;
        scheduleComposite(clock.currentFrame, revision);
      }, EDIT_DEBOUNCE_MS);
    }
  }, [clock.currentFrame, clock.playing, revision, scheduleComposite]);

  // ── audio: the Tier-2b WEB AUDIO GRAPH slaved to the master clock (§6, §8.6) ──
  // One `AudioGraph` mixes every audio track — per-clip `AudioBufferSourceNode`s
  // through per-clip gain (fades) → per-track gain → master gain. Its
  // `AudioContext.currentTime` becomes the clock's time base on resume, so A/V is
  // sample-locked. The graph is rebuilt only when fps/route change (a new document);
  // its schedule is re-derived on edits + seeks. Exposed on `window.__veanAudio` so
  // the headless §9-step-6 gate can assert the graph is live + A/V-locked.
  const audioGraph = useRef<AudioGraph | null>(null);
  // The last frame the audio path acted on — to detect a discrete SEEK (a jump) vs
  // smooth playback, so we re-schedule audio only on a real seek, never per tick.
  const prevAudioFrame = useRef(clock.currentFrame);

  // Build the graph once per (fps, route). Re-resolves the schedule + preloads
  // buffers immediately so the first play is instant.
  useEffect(() => {
    const graph = new AudioGraph(clockInstance, fps, route);
    audioGraph.current = graph;
    graph.setVolume(volume);
    graph.setMuted(muted);
    void graph.setSinkId(sinkId);
    graph.schedule(resolveAudio(timeline));
    (window as unknown as { __veanAudio?: () => ReturnType<AudioGraph["getStats"]> }).__veanAudio =
      () => graph.getStats();
    return () => {
      graph.dispose();
      audioGraph.current = null;
      (window as unknown as { __veanAudio?: unknown }).__veanAudio = undefined;
    };
    // Re-create only on a document-identity change (fps/route). volume/muted/sinkId
    // and the schedule are pushed by the effects below; timeline is read live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clockInstance, fps, route]);

  // Push mixer controls into the graph as they change (no re-create).
  useEffect(() => {
    audioGraph.current?.setVolume(volume);
  }, [volume]);
  useEffect(() => {
    audioGraph.current?.setMuted(muted);
  }, [muted]);
  useEffect(() => {
    void audioGraph.current?.setSinkId(sinkId);
  }, [sinkId]);

  // Re-derive the audio schedule whenever the working IR changes (an edit bumps
  // `revision`). When paused this only preloads/records; when playing it re-schedules
  // from the current playhead — so an edit is reflected in audio with NO save, the
  // audio twin of the footage HMR loop.
  useEffect(() => {
    audioGraph.current?.schedule(resolveAudio(timeline));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision]);

  // Play/pause TRANSITION → start/stop the graph. Keyed on `clock.playing` ONLY (not
  // `currentFrame`), so it fires once per transition — NOT every frame. `play()`
  // resumes the context, slaves the clock to it, and schedules from the playhead;
  // `pause()` silences. (Re-running this per tick would stop+reschedule every frame,
  // glitching audio and re-anchoring the clock — the playback-speed bug this avoids.)
  useEffect(() => {
    const graph = audioGraph.current;
    if (!graph) return;
    if (clock.playing) {
      void graph.play(resolveAudio(timeline));
    } else {
      graph.pause();
    }
    prevAudioFrame.current = clock.currentFrame;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock.playing]);

  // Seek-while-playing → re-align audio to the new position. A DISCRETE jump (a
  // scrub/seek of more than a couple frames while playing) re-schedules the graph
  // from the new playhead; smooth playback (±1 frame/tick) does NOT (that would
  // stop+restart sources every frame). The clock owns the frame; this only re-aligns
  // the speakers after a jump.
  useEffect(() => {
    const graph = audioGraph.current;
    if (!graph || !clock.playing) {
      prevAudioFrame.current = clock.currentFrame;
      return;
    }
    const jumped = Math.abs(clock.currentFrame - prevAudioFrame.current) > 2;
    prevAudioFrame.current = clock.currentFrame;
    if (jumped) graph.reseek();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clock.currentFrame, clock.playing]);

  // Audio-unlock on first interaction: resume the AudioContext (autoplay policy) and
  // slave the clock to it, so the audio clock is ready the instant the user plays.
  useEffect(() => {
    let unlocked = false;
    const unlock = () => {
      if (unlocked) return;
      unlocked = true;
      void audioGraph.current?.resume();
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  // Headless APPROXIMATE bridge (`window.__veanApprox`) — the no-UI handle the
  // §9-step-6 gate uses to (a) read whether the current composite uses an
  // `approximate` service (a non-default blend / frei0r / blur the browser can't
  // match — §7), and (b) trigger the ONE on-demand `melt` exact still for the frame
  // (§6.3) and observe the overlay landing. The gate counts `/api/still` requests in
  // the browser to assert EXACTLY ONE `melt` call fires per request, never in the
  // scrub loop. Side-effect only; mirrors the decode/edit bridges. Re-published on
  // each `(approximate, stillUrl)` change so the gate always reads current state.
  useEffect(() => {
    (
      window as unknown as {
        __veanApprox?: {
          approximate: boolean;
          hasStill: boolean;
          stillFrame: number | null;
          requestExactStill: () => Promise<void>;
        };
      }
    ).__veanApprox = {
      approximate,
      hasStill: stillUrl != null,
      stillFrame: stillFrame.current,
      requestExactStill,
    };
    return () => {
      (window as unknown as { __veanApprox?: unknown }).__veanApprox = undefined;
    };
  }, [approximate, stillUrl, requestExactStill]);

  // Clear the composite debounce timer on unmount (the graph tears itself down in
  // its own effect's cleanup).
  useEffect(
    () => () => {
      if (editTimer.current != null) window.clearTimeout(editTimer.current);
    },
    [],
  );

  return (
    <div ref={host} style={{ position: "absolute", inset: 0 }} data-testid="footage-stage">
      <canvas
        ref={canvasRef}
        data-testid="footage-canvas"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block",
        }}
      />
      {!hasContent && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#3a4150",
            fontSize: 12,
          }}
        >
          no footage at this frame
        </div>
      )}
      {stillUrl && (
        // The on-demand `melt` exact still (§6.3), overlaid for its one frame. It
        // sits ABOVE the live canvas but BELOW the Remotion overlay (PreviewPane
        // stacks the overlay last), so the exact footage shows under a live overlay.
        <img
          data-testid="exact-still"
          src={stillUrl}
          alt="exact melt still"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
          }}
        />
      )}
      {approximate && (
        <button
          type="button"
          data-testid="approximate-badge"
          onClick={() => void requestExactStill()}
          disabled={stillBusy}
          title="This frame uses a service the browser previews approximately. Click for a melt-rendered exact still of this frame."
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            padding: "2px 6px",
            borderRadius: 4,
            border: "none",
            cursor: stillBusy ? "wait" : "pointer",
            background: stillUrl ? "rgba(40,120,60,0.9)" : "rgba(180,120,20,0.85)",
            color: "#fff",
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {stillBusy ? "rendering…" : stillUrl ? "exact ✓" : "approx · exact?"}
        </button>
      )}
    </div>
  );
}
