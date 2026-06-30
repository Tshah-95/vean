// The Tier-0 FOOTAGE STAGE — the live, no-save footage layer (DESIGN-LIVE-PREVIEW
// §6 Tier 0, §9 step 2). It replaces the whole-timeline `melt`-proxy `<video>`
// with PER-SOURCE pooled `<video>` elements, each seeked to the SOURCE frame the
// playhead resolves to off the LIVE in-memory IR.
//
// THE LIVENESS CONTRACT ("HMR for video"): the stage re-resolves and repaints on
// every `(currentFrame, revision)` change. `currentFrame` is the master clock;
// `revision` is the session's monotonic edit counter (bumped on every op/undo/redo,
// `src/preview/session.ts`). An edit mutates the working IR and bumps `revision` →
// the resolve re-runs against the new IR → the `<video>` lands on the new source
// frame, with NO save, NO `/api/proxy-render`, NO `melt`. That IS the liveness.
// This generalizes the old "one proxy of the whole timeline, scrubbed by
// currentTime" to "the source clip live at the playhead, seeked to its source
// frame, derived from the live IR."
//
// REACTIVITY DISCIPLINE (ported from OpenReel `Preview.tsx:4777` + omniclip
// `controller.ts` seek):
//   • a `currentFrame` change → resolve + seek IMMEDIATELY (scrub must feel live);
//   • a `revision`-only change (an edit at the same frame) → DEBOUNCE ~150ms so a
//     burst of edits repaints once;
//   • a single in-flight seek with LATEST-time coalescing, so the stage never
//     settles on a stale frame mid-scrub.
// Seek precision = set `video.currentTime`, await the `seeked` event once (omniclip
// `#onSeeked`). During playback the element plays natively for audio + motion; the
// RAF master clock still owns the integer frame.
//
// POOLING: one `<video>` per source UUID, created on demand and kept mounted (an
// LRU cap bounds how many live at once). Resolving to the same clip across frames
// reuses its element (only `currentTime` moves) — the analog of the decode cache
// being keyed by stable producer uuid, so the pool survives ripple/trim edits that
// only reposition a clip (DESIGN §4 step 2).
//
// TIER-0 SCOPE: the TOPMOST covering footage clip wins (resolveVisible.ts). The
// real multi-track crossfade compositor (mediabunny decode → WebGL `renderFrame`)
// is Tier 1; this is the cheapest path to "edits are live" and needs neither
// WebCodecs nor a GPU compositor. Graphics are drawn by the `@remotion/player`
// overlay ON TOP, unchanged.
import { useCallback, useEffect, useRef, useState } from "react";
import { mediaUrl } from "../api";
import { useClock, useClockInstance } from "../ClockProvider";
import { resolveVisibleSet, type VisibleClip } from "../resolveVisible";
import type { Fps, Timeline } from "../types";

export interface FootageStageProps {
  /** The LIVE working IR (the working copy once edited, else the server load). The
   *  resolve walk reads THIS, so an edit is reflected the instant `revision` bumps. */
  timeline: Timeline;
  /** The session's monotonic edit revision — the HMR trigger (§3). A change here
   *  with the same `currentFrame` still re-resolves + repaints (debounced). */
  revision: number;
  fps: Fps;
  /** The active route, scoping the `/api/media` allowlist check server-side. */
  route: string | undefined;
  /** Playback volume 0–1 (applied to the live footage element, the audio source). */
  volume: number;
  /** Mute the footage audio. */
  muted: boolean;
  /** Output device id for setSinkId ("" = system default). */
  sinkId: string;
}

/** Debounce window for a revision-only repaint (OpenReel `Preview.tsx:4835`). */
const EDIT_DEBOUNCE_MS = 150;
/** Max pooled `<video>` elements kept mounted (LRU). Tier-0 single-clip preview
 *  only ever shows one at a time; the pool just avoids re-creating + re-buffering a
 *  source on every cut back to it. Kept small — Tier 2 owns real decode budgeting. */
const POOL_MAX = 6;

/** A pooled source element + its bookkeeping. */
interface PoolEntry {
  uuid: string;
  resource: string;
  el: HTMLVideoElement;
  /** Last access tick (for LRU eviction). */
  lastUsed: number;
}

export function FootageStage({
  timeline,
  revision,
  fps,
  route,
  volume,
  muted,
  sinkId,
}: FootageStageProps) {
  const host = useRef<HTMLDivElement>(null);
  const clock = useClock();
  const clockInstance = useClockInstance();

  // The pool of `<video>` elements, keyed by source uuid. Imperative DOM (a ref,
  // not state) so seeking never triggers a React re-render — the stage repaints by
  // moving the visible element's `currentTime`, exactly like a canvas compositor
  // repaints by drawing, not by re-rendering the tree.
  const pool = useRef<Map<string, PoolEntry>>(new Map());
  const useTick = useRef(0);
  // Which uuid is currently shown (so we only flip visibility on a real change).
  const shownUuid = useRef<string | null>(null);
  // Whether the playhead currently sits over footage at all (else the box is empty
  // — the background/overlay shows through). Surfaced as state for the placeholder.
  const [hasFootage, setHasFootage] = useState(true);

  // Single-in-flight seek + latest-time coalescing (OpenReel doRender). We key the
  // in-flight token on a monotonic request id so a newer resolve supersedes an older
  // awaited `seeked`.
  const inFlight = useRef(false);
  const pendingReq = useRef<{ frame: number; revision: number } | null>(null);
  const editTimer = useRef<number | null>(null);

  const secondsForFrame = useCallback((frame: number) => (frame * fps[1]) / fps[0], [fps]);

  // Acquire (or create) the pooled element for a source, applying audio settings
  // and the source URL. Evicts LRU past POOL_MAX, pausing + detaching the source so
  // the element releases its decode/buffer resources.
  const acquire = useCallback(
    (clip: VisibleClip): PoolEntry => {
      const map = pool.current;
      let entry = map.get(clip.uuid);
      if (!entry) {
        const el = document.createElement("video");
        el.playsInline = true;
        el.preload = "auto";
        // Filled into the host box; only the SHOWN element is visible (others are
        // kept mounted but hidden so a cut back to them is instant).
        el.style.position = "absolute";
        el.style.inset = "0";
        el.style.width = "100%";
        el.style.height = "100%";
        el.style.objectFit = "contain";
        el.style.display = "none";
        el.src = mediaUrl(clip.resource, route);
        host.current?.appendChild(el);
        entry = { uuid: clip.uuid, resource: clip.resource, el, lastUsed: useTick.current };
        map.set(clip.uuid, entry);
        // Evict LRU.
        if (map.size > POOL_MAX) {
          let oldest: PoolEntry | null = null;
          for (const e of map.values()) {
            if (e.uuid === clip.uuid) continue;
            if (!oldest || e.lastUsed < oldest.lastUsed) oldest = e;
          }
          if (oldest) {
            oldest.el.pause();
            oldest.el.removeAttribute("src");
            oldest.el.load();
            oldest.el.remove();
            map.delete(oldest.uuid);
          }
        }
      } else if (entry.resource !== clip.resource) {
        // A re-link edit changed the source under a stable uuid — repoint it.
        entry.resource = clip.resource;
        entry.el.src = mediaUrl(clip.resource, route);
      }
      entry.lastUsed = ++useTick.current;
      return entry;
    },
    [route],
  );

  // Seek the visible element to a source frame, awaiting `seeked` once (omniclip
  // precision). Returns when the element has actually landed (or immediately if it
  // is already within ~half a frame, to avoid a redundant decode).
  const seekTo = useCallback(
    (el: HTMLVideoElement, sourceFrame: number) =>
      new Promise<void>((resolveSeek) => {
        const target = secondsForFrame(sourceFrame);
        const halfFrame = fps[1] / fps[0] / 2;
        if (Math.abs(el.currentTime - target) <= halfFrame) {
          resolveSeek();
          return;
        }
        const onSeeked = () => {
          el.removeEventListener("seeked", onSeeked);
          resolveSeek();
        };
        el.addEventListener("seeked", onSeeked, { once: true });
        el.currentTime = target;
      }),
    [secondsForFrame, fps],
  );

  // Make `entry` the shown element (hide the previously shown one). Visibility flips
  // are cheap; only the shown element decodes the seeked frame.
  const show = useCallback((entry: PoolEntry) => {
    if (shownUuid.current === entry.uuid) return;
    const prev = shownUuid.current ? pool.current.get(shownUuid.current) : undefined;
    if (prev && prev.uuid !== entry.uuid) {
      prev.el.style.display = "none";
      // Pause the element we're leaving so it doesn't keep decoding off-screen.
      if (!prev.el.paused) prev.el.pause();
    }
    entry.el.style.display = "block";
    shownUuid.current = entry.uuid;
  }, []);

  // The render core: resolve the visible footage clip off the LIVE IR at `frame`,
  // acquire/seek its pooled element, show it. Single-in-flight with latest-wins
  // coalescing so a scrub burst never settles on a stale frame.
  const render = useCallback(
    async (frame: number, rev: number): Promise<void> => {
      if (inFlight.current) {
        pendingReq.current = { frame, revision: rev };
        return;
      }
      inFlight.current = true;
      try {
        const clip = resolveVisibleSet(timeline, frame);
        if (!clip) {
          // No footage at this frame — hide whatever was shown; background/overlay
          // fills the box.
          if (shownUuid.current) {
            const prev = pool.current.get(shownUuid.current);
            if (prev) prev.el.style.display = "none";
            shownUuid.current = null;
          }
          setHasFootage(false);
          return;
        }
        setHasFootage(true);
        const entry = acquire(clip);
        show(entry);
        // Audio settings on the shown (audio-source) element.
        entry.el.volume = Math.min(1, Math.max(0, volume));
        entry.el.muted = muted;
        await seekTo(entry.el, clip.sourceFrame);
      } finally {
        inFlight.current = false;
        const next = pendingReq.current;
        pendingReq.current = null;
        if (next && (next.frame !== frame || next.revision !== rev)) {
          void render(next.frame, next.revision);
        }
      }
    },
    [timeline, acquire, show, seekTo, volume, muted],
  );

  // ── The HMR effect: react to (currentFrame, revision) ─────────────────────
  // A frame change renders immediately (scrub is live). A revision-only change
  // (an edit at the same frame) debounces so a burst paints once. Playback is the
  // same path on the clock (each tick changes currentFrame).
  const lastFrame = useRef(clock.currentFrame);
  const lastRevision = useRef(revision);
  const firstPaint = useRef(true);
  useEffect(() => {
    const frameChanged = clock.currentFrame !== lastFrame.current;
    const revisionChanged = revision !== lastRevision.current;
    lastFrame.current = clock.currentFrame;
    lastRevision.current = revision;

    // The INITIAL paint: on mount neither frame nor revision has "changed" yet
    // (both refs were seeded to the starting values), so render the current frame
    // unconditionally once — otherwise the stage stays blank until the first scrub
    // or edit. (The classic first-frame guard bug.)
    if (firstPaint.current) {
      firstPaint.current = false;
      void render(clock.currentFrame, revision);
      return;
    }

    if (frameChanged || clock.playing) {
      // Immediate: scrubbing + playback must feel instant.
      if (editTimer.current != null) {
        window.clearTimeout(editTimer.current);
        editTimer.current = null;
      }
      void render(clock.currentFrame, revision);
    } else if (revisionChanged) {
      // Edit at the same frame → debounce a single repaint.
      if (editTimer.current != null) window.clearTimeout(editTimer.current);
      editTimer.current = window.setTimeout(() => {
        editTimer.current = null;
        void render(clock.currentFrame, revision);
      }, EDIT_DEBOUNCE_MS);
    }
  }, [clock.currentFrame, clock.playing, revision, render]);

  // Drive native play/pause of the SHOWN element from the master playing flag (so
  // footage carries audio + motion during play; the RAF clock owns the frame).
  useEffect(() => {
    const entry = shownUuid.current ? pool.current.get(shownUuid.current) : undefined;
    const el = entry?.el;
    if (!el) return;
    if (clock.playing) {
      void el.play().catch(() => {
        /* autoplay may be blocked until a user gesture; transport click unblocks */
      });
    } else {
      el.pause();
    }
  }, [clock.playing]);

  // Audio-unlock: clock-driven play() runs from an effect (detached from the click),
  // which browsers reject for an unmuted element. Grant playback on the first real
  // interaction, then reconcile to the clock (same discipline the old proxy pane
  // used).
  useEffect(() => {
    let unlocked = false;
    const unlock = () => {
      const entry = shownUuid.current ? pool.current.get(shownUuid.current) : undefined;
      const el = entry?.el;
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

  // Route audio to the chosen output device on the shown element.
  useEffect(() => {
    const entry = shownUuid.current ? pool.current.get(shownUuid.current) : undefined;
    const el = entry?.el as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | undefined;
    if (!el || typeof el.setSinkId !== "function") return;
    el.setSinkId(sinkId).catch(() => {
      /* device may have vanished or permission denied — fall back to default */
    });
  }, [sinkId]);

  // Tear down the whole pool on unmount: pause, detach sources, remove elements so
  // the browser releases every decode/buffer resource (the `<video>` analog of the
  // decode cache's `close()`-on-evict).
  // biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only cleanup.
  useEffect(
    () => () => {
      if (editTimer.current != null) window.clearTimeout(editTimer.current);
      for (const entry of pool.current.values()) {
        entry.el.pause();
        entry.el.removeAttribute("src");
        entry.el.load();
        entry.el.remove();
      }
      pool.current.clear();
      shownUuid.current = null;
    },
    [],
  );

  return (
    <div ref={host} style={{ position: "absolute", inset: 0 }} data-testid="footage-stage">
      {!hasFootage && (
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
    </div>
  );
}
