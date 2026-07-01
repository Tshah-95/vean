// The composited preview: a LIVE footage <canvas> compositor UNDER an
// @remotion/player overlay, both locked to the master clock.
//
// TIER 1 (DESIGN-LIVE-PREVIEW §4, §6, §7): the footage layer is the `FootageStage`
// WebGL2 compositor — `renderFrame(ir, frame)`. It resolves the LIVE in-memory IR
// at the playhead into a z-stack (color quads + decoded footage + same-track
// dissolves via gl-transitions) and composites it in one pass, recompositing on
// every `(currentFrame, revision)` change. An edit mutates the working IR + bumps
// `revision`, and the compositor repaints WITH NO SAVE, NO `/api/proxy-render`, NO
// `melt` in the loop — the no-save edit loop ("HMR for video"). The Remotion
// overlay draws ON TOP; its transparent regions reveal the composited footage
// (two compositors, one editor track — the Remotion seam). `melt` re-enters ONLY
// as the opt-in per-frame exact-still fallback for `approximate` services (§6.3).
import { useMemo } from "react";
import { useClock } from "../ClockProvider";
import { hasGraphicOverlay, resolveOverlayAt } from "../resolveOverlay";
import type { Fps, Timeline } from "../types";
import { FootageStage } from "./FootageStage";
import { OverlayPlayer } from "./OverlayPlayer";

export interface PreviewPaneProps {
  /** Profile pixel size (the preview aspect). */
  width: number;
  height: number;
  fps: Fps;
  /** The LIVE working IR the footage stage resolves at the playhead (no save). */
  timeline: Timeline;
  /** The session's monotonic edit revision — the HMR trigger (§3, §4). */
  revision: number;
  /** The active route, scoping the `/api/media` source-serve allowlist. */
  route: string | undefined;
  /** (The graphic overlay is resolved PER-FRAME from `timeline` — the graphic clip
   *  active at the playhead — inside this pane via `resolveOverlayAt`. No static overlay
   *  props are threaded in; multi-overlay + start-offset + span visibility fall out.) */
  /** Playback volume 0–1 (applied to the live footage <video>, the audio source). */
  volume: number;
  /** Mute the footage audio. */
  muted: boolean;
  /** Output device id for setSinkId ("" = system default). */
  sinkId: string;
}

export function PreviewPane({
  width,
  height,
  fps,
  timeline,
  revision,
  route,
  volume,
  muted,
  sinkId,
}: PreviewPaneProps) {
  // Subscribe to the clock so the pane re-renders on a frame change — needed to resolve
  // the PLAYHEAD-ACTIVE overlay (the footage stage repaints imperatively, but the overlay
  // layer is React and must track the frame).
  const clock = useClock();

  const aspect = `${width} / ${height}`;

  // Mount the overlay layer iff the timeline has ANY graphic clip (kept mounted across
  // spans so a gap doesn't remount the Player); resolve the graphic clip ACTIVE at the
  // current frame — its comp, start offset, and span visibility — per frame.
  const anyGraphic = useMemo(() => hasGraphicOverlay(timeline), [timeline]);
  const active = resolveOverlayAt(timeline, clock.currentFrame);

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        background: "#000",
        flex: 1,
        minHeight: 0,
        padding: 16,
      }}
    >
      <div
        style={{
          position: "relative",
          aspectRatio: aspect,
          maxHeight: "100%",
          maxWidth: "100%",
          height: "100%",
          background: "#050608",
          borderRadius: 8,
          overflow: "hidden",
          boxShadow: "0 4px 32px rgba(0,0,0,0.6)",
        }}
      >
        <FootageStage
          timeline={timeline}
          revision={revision}
          fps={fps}
          width={width}
          height={height}
          route={route}
          volume={volume}
          muted={muted}
          sinkId={sinkId}
        />
        {anyGraphic && (
          <OverlayPlayer
            width={width}
            height={height}
            fps={fps}
            present={active.present}
            startFrame={active.startFrame}
            durationInFrames={active.duration}
            {...(active.compositionId ? { compositionId: active.compositionId } : {})}
            {...(active.props ? { inputProps: active.props } : {})}
          />
        )}
      </div>
    </div>
  );
}
