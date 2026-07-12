// The @remotion/player overlay — the LIVE graphic layer, slaved to the master
// clock. Mounted with controls=false, loop=false; we drive it imperatively:
// every master-clock frame change calls playerRef.seekTo(frame). Its canvas is
// transparent where the composition is transparent, so it composites OVER the
// footage <video> beneath it (PreviewPane stacks them in the same box).
//
// The composition rendered is the ACTUAL one the graphic clip names — its IR
// `composition.id`/`composition.props`, surfaced by App `resolveOverlayAt` — resolved
// to a component via the viewer's composition registry (the same `@remotion-comp`
// source the producer renders to ProRes). This is the LIVE half of the two
// compositing paths of ONE composition (live preview ≈ export, the accepted cost).
// A clip with no composition metadata (legacy label-/cache-path overlays) falls
// back to the default composition, preserving historical behaviour. It is NEVER
// hardcoded to LowerThird, and the overlay is ALWAYS alpha-composited over the
// footage below (the transparent background reveals the footage compositor's canvas).
import { Player, type PlayerRef } from "@remotion/player";
import { useEffect, useMemo, useRef, useState } from "react";
import { useClock, useClockInstance } from "../ClockProvider";
import { keepPlayerPaused } from "../remotion/pausePlayer";
import { resolveComposition } from "../remotion/registry";
import type { Fps } from "../types";
import { OverlayErrorFallback } from "./OverlayErrorFallback";

export interface OverlayPlayerProps {
  /** Composition pixel size (matches the profile). */
  width: number;
  height: number;
  fps: Fps;
  /** Overlay duration in frames (the ACTIVE clip's placed length). */
  durationInFrames: number;
  /** The composition id the ACTIVE graphic clip names (IR `composition.id`). Resolved
   *  to a registered component; falls back to the default when absent/unknown. */
  compositionId?: string;
  /** Props for the resolved composition (from the active graphic clip). */
  inputProps?: Record<string, unknown>;
  /** The active clip's timeline start — the comp-frame offset, so the comp plays from
   *  its own 0 when the clip enters (comp frame = masterFrame − startFrame). Default 0. */
  startFrame?: number;
  /** Whether a graphic clip covers the CURRENT frame. When false the overlay is hidden
   *  (the Player stays MOUNTED across a gap to avoid a remount; only a comp change
   *  remounts it). Default true. */
  present?: boolean;
}

export function OverlayPlayer({
  width,
  height,
  fps,
  durationInFrames,
  compositionId,
  inputProps,
  startFrame = 0,
  present = true,
}: OverlayPlayerProps) {
  const playerRef = useRef<PlayerRef>(null);
  const [hmrRevision, setHmrRevision] = useState(0);
  const clock = useClock();
  const clockInstance = useClockInstance();

  // Resolve the ACTUAL composition the graphic clip names (its component + default
  // props), instead of the formerly-hardcoded LowerThird. Memoized on the id so the
  // Player's `component` identity is stable across the frame-driven re-renders (a
  // fresh component reference would remount the Player every frame).
  //
  // Hold the last non-null comp id so a GAP (present=false → compositionId undefined)
  // doesn't flip `resolved` to the DEFAULT comp and remount the Player mid-timeline —
  // across a gap the overlay stays the same comp, just hidden; only a real comp CHANGE
  // remounts it. (Without this, a gap between two `Title` clips would remount twice.)
  const lastCompId = useRef(compositionId);
  if (compositionId) lastCompId.current = compositionId;
  const effectiveCompId = compositionId ?? lastCompId.current;
  // Read the registry on every render. During ordinary playback its component and
  // defaults identities are stable. During Vite HMR an eager glob can replace the
  // changed module while `effectiveCompId` stays the same; keying resolution only on
  // the id would preserve the stale pre-edit module forever.
  const resolved = resolveComposition(effectiveCompId);
  const resolvedDefaults = resolved.defaults;

  // Remotion's Player owns an internal render root, so React Fast Refresh can update
  // an imported composition without forcing an already-mounted static frame to draw.
  // Remount only that render target after Vite applies an update. The master clock is
  // outside the Player, so the user's exact playhead survives the refresh.
  useEffect(() => {
    const hot = import.meta.hot;
    if (!hot) return;
    const refreshPlayer = () => setHmrRevision((revision) => revision + 1);
    hot.on("vite:afterUpdate", refreshPlayer);
    return () => hot.off("vite:afterUpdate", refreshPlayer);
  }, []);
  // The props the Player renders with: the clip's props layered OVER the
  // composition's own defaults, so a clip that omits a field still renders.
  const playerProps = useMemo(
    () => ({ ...resolvedDefaults, ...(inputProps ?? {}) }),
    [resolvedDefaults, inputProps],
  );

  // Integer composition fps (the profile is integer-fps in Move 5).
  const compFps = Math.round(fps[0] / fps[1]);

  // Slave the Player to the master clock: on every frame change, seek the Player to
  // the composition-LOCAL frame == masterFrame − startFrame (so the comp animates from
  // its own 0 when the clip enters), clamped into [0, duration).
  useEffect(() => {
    // A Player remount starts at frame zero even though the master frame did not
    // change; consuming the HMR revision intentionally re-runs this exact seek.
    void hmrRevision;
    const player = playerRef.current;
    if (!player) return;
    const local = Math.max(
      0,
      Math.min(clock.currentFrame - startFrame, Math.max(0, durationInFrames - 1)),
    );
    // Only seek when the Player drifts from the master (avoids redundant seeks).
    try {
      const current = player.getCurrentFrame();
      if (current !== local) player.seekTo(local);
    } catch {
      player.seekTo(local);
    }
  }, [clock.currentFrame, durationInFrames, startFrame, hmrRevision]);

  // Keep the Player paused — the master RAF loop owns playback; the Player is a
  // pure render target driven by seekTo. (If it were play()ing it would advance
  // on its own clock and desync.)
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    try {
      keepPlayerPaused(player);
    } catch {
      // ignore — older player ref shapes
    }
  });

  // Headless OVERLAY bridge (`window.__veanOverlay`) — the no-UI handle the live-overlay
  // gates use to prove the Remotion seam end-to-end: it reports the ACTIVE overlay's
  // `present` (does a graphic clip cover this frame), its resolved `compositionId`, the
  // clip `startFrame`, and the live `(playerFrame, masterFrame)` so a gate can assert the
  // `<Player>` is SLAVED (seek the clock → the Player follows the LOCAL frame = master −
  // startFrame) and that the RIGHT comp shows at each span. Side-effect only.
  useEffect(() => {
    (
      window as unknown as {
        __veanOverlay?: () => {
          present: boolean;
          durationInFrames: number;
          startFrame: number;
          playerFrame: number | null;
          masterFrame: number;
          /** The composition id the live Player actually resolved + rendered — the
           *  gate asserts this is the clip's real comp (not the old hardcoded one). */
          compositionId: string;
        };
      }
    ).__veanOverlay = () => {
      const player = playerRef.current;
      let playerFrame: number | null = null;
      try {
        playerFrame = player ? player.getCurrentFrame() : null;
      } catch {
        playerFrame = null;
      }
      return {
        present,
        durationInFrames,
        startFrame,
        playerFrame,
        masterFrame: clockInstance.getSnapshot().currentFrame,
        compositionId: resolved.id,
      };
    };
    return () => {
      (window as unknown as { __veanOverlay?: unknown }).__veanOverlay = undefined;
    };
  }, [durationInFrames, startFrame, present, clockInstance, resolved.id]);

  return (
    <div
      data-testid="overlay-player"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        // Hidden (but MOUNTED) when no graphic clip covers the current frame, so
        // re-entry across a gap doesn't remount the Player.
        opacity: present ? 1 : 0,
      }}
    >
      <Player
        // Key on the comp id so a comp CHANGE remounts the Player fresh — clearing the
        // Player's internal error state, so switching AWAY from a broken comp recovers.
        key={`${resolved.id}:${hmrRevision}`}
        ref={playerRef}
        component={resolved.component as never}
        durationInFrames={Math.max(1, durationInFrames)}
        fps={compFps}
        compositionWidth={width}
        compositionHeight={height}
        inputProps={playerProps as never}
        controls={false}
        loop={false}
        clickToPlay={false}
        doubleClickToFullscreen={false}
        acknowledgeRemotionLicense
        // A comp that throws DURING RENDER is caught by the Player's OWN error boundary;
        // instead of Remotion's default ⚠️ glyph over the footage, render NOTHING (the
        // overlay is hidden, footage keeps showing) and publish the failure on
        // window.__veanOverlayError (which comp, why) for gates/agents.
        errorFallback={({ error }) => (
          <OverlayErrorFallback error={error} compositionId={resolved.id} />
        )}
        style={{ width: "100%", height: "100%", background: "transparent" }}
      />
    </div>
  );
}
