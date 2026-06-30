// The @remotion/player overlay — the LIVE graphic layer, slaved to the master
// clock. Mounted with controls=false, loop=false; we drive it imperatively:
// every master-clock frame change calls playerRef.seekTo(frame). Its canvas is
// transparent where the composition is transparent, so it composites OVER the
// footage <video> beneath it (PreviewPane stacks them in the same box).
//
// The composition rendered is the ACTUAL one the graphic clip names — its IR
// `composition.id`/`composition.props`, surfaced by App `deriveOverlay` — resolved
// to a component via the viewer's composition registry (the same `@remotion-comp`
// source the producer renders to ProRes). This is the LIVE half of the two
// compositing paths of ONE composition (live preview ≈ export, the accepted cost).
// A clip with no composition metadata (legacy label-/cache-path overlays) falls
// back to the default composition, preserving historical behaviour. It is NEVER
// hardcoded to LowerThird, and the overlay is ALWAYS alpha-composited over the
// footage below (the transparent background reveals the footage compositor's canvas).
import { Player, type PlayerRef } from "@remotion/player";
import { useEffect, useMemo, useRef } from "react";
import { resolveComposition } from "../remotion/registry";
import { useClock, useClockInstance } from "../ClockProvider";
import type { Fps } from "../types";

export interface OverlayPlayerProps {
  /** Composition pixel size (matches the profile). */
  width: number;
  height: number;
  fps: Fps;
  /** Overlay duration in frames (the composition's durationInFrames). */
  durationInFrames: number;
  /** The composition id the graphic clip names (IR `composition.id`). Resolved to
   *  a registered component; falls back to the default when absent/unknown. */
  compositionId?: string;
  /** Props for the resolved composition (from the timeline's graphic clip). */
  inputProps?: Record<string, unknown>;
}

export function OverlayPlayer({
  width,
  height,
  fps,
  durationInFrames,
  compositionId,
  inputProps,
}: OverlayPlayerProps) {
  const playerRef = useRef<PlayerRef>(null);
  const clock = useClock();
  const clockInstance = useClockInstance();

  // Resolve the ACTUAL composition the graphic clip names (its component + default
  // props), instead of the formerly-hardcoded LowerThird. Memoized on the id so the
  // Player's `component` identity is stable across the frame-driven re-renders (a
  // fresh component reference would remount the Player every frame).
  const resolved = useMemo(() => resolveComposition(compositionId), [compositionId]);
  // The props the Player renders with: the clip's props layered OVER the
  // composition's own defaults, so a clip that omits a field still renders.
  const playerProps = useMemo(
    () => ({ ...resolved.defaults, ...(inputProps ?? {}) }),
    [resolved, inputProps],
  );

  // Integer composition fps (the profile is integer-fps in Move 5).
  const compFps = Math.round(fps[0] / fps[1]);

  // Slave the Player to the master clock: on every frame change, seek the Player.
  // The Player frame is the composition frame == the master frame (same fps).
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const frame = Math.max(0, Math.min(clock.currentFrame, Math.max(0, durationInFrames - 1)));
    // Only seek when the Player drifts from the master (avoids redundant seeks).
    try {
      const current = player.getCurrentFrame();
      if (current !== frame) player.seekTo(frame);
    } catch {
      player.seekTo(frame);
    }
  }, [clock.currentFrame, durationInFrames]);

  // Keep the Player paused — the master RAF loop owns playback; the Player is a
  // pure render target driven by seekTo. (If it were play()ing it would advance
  // on its own clock and desync.)
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    try {
      if (player.isPlaying()) player.pause();
    } catch {
      // ignore — older player ref shapes
    }
  }, [clock.playing, clockInstance]);

  // Headless OVERLAY bridge (`window.__veanOverlay`) — the no-UI handle the
  // §9-step-4 live-overlay gate uses to prove the Remotion seam end-to-end:
  // (a) the bridge EXISTS only because this component mounted, which happens only
  // when App `deriveOverlay` returned present:true (a real GRAPHIC clip), and
  // (b) it reports the live `(playerFrame, masterFrame)` so the gate can assert the
  // `<Player>` is SLAVED to the master clock — seek the clock, the Player follows.
  // Side-effect only; mirrors the decode/edit/perf/audio/approx bridges. `present`
  // is always true here (the component is conditionally rendered on overlayPresent).
  useEffect(() => {
    (
      window as unknown as {
        __veanOverlay?: () => {
          present: boolean;
          durationInFrames: number;
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
        present: true,
        durationInFrames,
        playerFrame,
        masterFrame: clockInstance.getSnapshot().currentFrame,
        compositionId: resolved.id,
      };
    };
    return () => {
      (window as unknown as { __veanOverlay?: unknown }).__veanOverlay = undefined;
    };
  }, [durationInFrames, clockInstance, resolved.id]);

  return (
    <div data-testid="overlay-player" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <Player
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
        style={{ width: "100%", height: "100%", background: "transparent" }}
      />
    </div>
  );
}
