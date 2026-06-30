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
// decoded off-thread via the mediabunny `Decoder` (one worker, bounded in-flight),
// cached by `(producerUUID, sourceFrame)` so the cache survives ripple/trim edits
// that only reposition a clip. The cache is byte-bounded LRU and `close()`s every
// evicted `ImageBitmap` — forgetting `close()` OOMs the GPU within seconds of
// scrubbing. The compositor never retains a bitmap after a draw.
//
// AUDIO (Tier 0/1 scope): a hidden per-source `<video>` carries audio during
// playback (the visual is the canvas; the element is muted-of-video by being
// off-screen). The full Web Audio graph is Tier 2b (§6).
import { useCallback, useEffect, useRef, useState } from "react";
import { mediaUrl, renderStill } from "../api";
import { useClock, useClockInstance } from "../ClockProvider";
import { type FootageProvider, type FrameImage, GlCompositor } from "../compositor/glCompositor";
import { Decoder } from "../decode/decoder";
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

/** A cached decoded footage frame, keyed by `(uuid, sourceFrame)`. */
interface CachedFrame {
  key: string;
  bitmap: ImageBitmap;
  bytes: number;
  lastUsed: number;
}

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
  const decoder = useRef<Decoder | null>(null);

  // The decoded-frame cache + its byte accounting. Imperative (a ref) so a decode
  // completing repaints without a React re-render.
  const cache = useRef<Map<string, CachedFrame>>(new Map());
  const cacheBytes = useRef(0);
  const useTick = useRef(0);
  // In-flight decode keys (so we never double-request the same frame).
  const decoding = useRef<Set<string>>(new Set());

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

  // ── decode cache (byte-bounded LRU, close()-on-evict — §8.3) ───────────────
  const evictTo = useCallback((budget: number) => {
    const map = cache.current;
    if (cacheBytes.current <= budget) return;
    const entries = [...map.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of entries) {
      if (cacheBytes.current <= budget) break;
      e.bitmap.close(); // THE load-bearing release (§8.3)
      cacheBytes.current -= e.bytes;
      map.delete(e.key);
    }
  }, []);

  const putFrame = useCallback(
    (key: string, bitmap: ImageBitmap) => {
      const bytes = bitmap.width * bitmap.height * 4;
      const existing = cache.current.get(key);
      if (existing) {
        // Replace — close the old bitmap first (§8.3 close-on-replace).
        existing.bitmap.close();
        cacheBytes.current -= existing.bytes;
        cache.current.delete(key);
      }
      cache.current.set(key, { key, bitmap, bytes, lastUsed: ++useTick.current });
      cacheBytes.current += bytes;
      evictTo(CACHE_MAX_BYTES);
    },
    [evictTo],
  );

  const getFrame = useCallback((key: string): ImageBitmap | null => {
    const e = cache.current.get(key);
    if (!e) return null;
    e.lastUsed = ++useTick.current;
    return e.bitmap;
  }, []);

  // The synchronous provider the compositor pulls each footage layer through: a
  // cache hit returns the bitmap; a miss returns null (layer below shows through)
  // and kicks off an async decode that recomposites on completion.
  const provideFootage: FootageProvider = useCallback(
    (layer: FootageLayer): FrameImage => {
      const key = frameKey(layer.uuid, layer.sourceFrame);
      const hit = getFrame(key);
      if (hit) return hit;
      if (!decoding.current.has(key) && decoder.current) {
        decoding.current.add(key);
        const seconds = secondsForFrame(layer.sourceFrame);
        decoder.current
          .decodeAt(layer.uuid, layer.resource, seconds, boxW.current, boxH.current, route)
          .then((decoded) => {
            decoding.current.delete(key);
            if (!decoded) return;
            putFrame(key, decoded.bitmap);
            // A frame landed — recomposite the CURRENT playhead so it appears.
            scheduleComposite(clockInstance.getSnapshot().currentFrame, revision, true);
          })
          .catch(() => {
            decoding.current.delete(key);
          });
      }
      return null;
    },
    // scheduleComposite is stable (defined below via ref); revision captured live.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [getFrame, putFrame, secondsForFrame, route, revision, clockInstance],
  );

  // The composite core: resolve the z-stack off the LIVE IR at `frame`, draw it.
  const composite = useCallback(
    (frame: number) => {
      const comp = compositor.current;
      if (!comp) return;
      const resolved = resolveLayers(timeline, frame);
      const layers: Layer[] = resolved.layers;
      setHasContent(layers.length > 0);
      setApproximate(resolved.hasApproximate);
      comp.resize(boxW.current, boxH.current);
      comp.render(layers, provideFootage);
    },
    [timeline, provideFootage],
  );

  // Single-in-flight composite with latest-wins coalescing. `force` bypasses the
  // in-flight guard's coalescing collapse for a decode-completion repaint.
  const scheduleCompositeRef = useRef<(frame: number, rev: number, force?: boolean) => void>(() => {});
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
    decoder.current = new Decoder();
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
      for (const e of cache.current.values()) e.bitmap.close();
      cache.current.clear();
      cacheBytes.current = 0;
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

  // ── audio: a single hidden source element carrying the topmost footage clip's
  // audio during playback (Tier 0/1; the Web Audio graph is Tier 2b). The visual
  // is the canvas — this element is off-screen, played only for sound. ──────────
  const audioEl = useRef<HTMLVideoElement | null>(null);
  const audioUuid = useRef<string | null>(null);

  const topmostAudioSource = useCallback((): { resource: string; uuid: string; seconds: number } | null => {
    const resolved = resolveLayers(timeline, clock.currentFrame);
    // Walk top-down; the highest footage layer carries audio (color/solid is silent).
    for (let i = resolved.layers.length - 1; i >= 0; i--) {
      const l = resolved.layers[i];
      if (l && l.kind === "footage") {
        return { resource: l.resource, uuid: l.uuid, seconds: secondsForFrame(l.sourceFrame) };
      }
    }
    return null;
  }, [timeline, clock.currentFrame, secondsForFrame]);

  useEffect(() => {
    if (!audioEl.current) {
      const el = document.createElement("video");
      el.playsInline = true;
      el.preload = "auto";
      el.style.display = "none";
      host.current?.appendChild(el);
      audioEl.current = el;
    }
    const el = audioEl.current;
    el.volume = Math.min(1, Math.max(0, volume));
    el.muted = muted;
    const src = topmostAudioSource();
    if (!src) {
      el.pause();
      audioUuid.current = null;
      return;
    }
    if (audioUuid.current !== src.uuid) {
      el.src = mediaUrl(src.resource, route);
      audioUuid.current = src.uuid;
    }
    if (clock.playing) {
      // Keep the audio element roughly synced; the canvas owns the visual frame.
      if (Math.abs(el.currentTime - src.seconds) > 0.25) el.currentTime = src.seconds;
      void el.play().catch(() => {});
    } else {
      el.pause();
      el.currentTime = src.seconds;
    }
  }, [clock.playing, clock.currentFrame, volume, muted, route, topmostAudioSource]);

  // Route audio to the chosen output device.
  useEffect(() => {
    const el = audioEl.current as
      | (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> })
      | null;
    if (!el || typeof el.setSinkId !== "function") return;
    el.setSinkId(sinkId).catch(() => {});
  }, [sinkId]);

  // Audio-unlock on first interaction (clock-driven play() from an effect is
  // rejected for an unmuted element until a user gesture).
  useEffect(() => {
    let unlocked = false;
    const unlock = () => {
      const el = audioEl.current;
      if (!el || unlocked) return;
      unlocked = true;
      el.play()
        .then(() => {
          if (!clockInstance.getSnapshot().playing) el.pause();
        })
        .catch(() => {
          unlocked = false;
        });
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [clockInstance]);

  // Tear down the audio element on unmount.
  useEffect(
    () => () => {
      if (editTimer.current != null) window.clearTimeout(editTimer.current);
      const el = audioEl.current;
      if (el) {
        el.pause();
        el.removeAttribute("src");
        el.load();
        el.remove();
      }
      audioEl.current = null;
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
