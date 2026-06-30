// The composited preview: a LIVE footage <canvas/video> stage UNDER an
// @remotion/player overlay, both locked to the master clock.
//
// TIER 0 (DESIGN-LIVE-PREVIEW §6): the footage layer is no longer a whole-timeline
// `melt`-proxy `<video>` scrubbed by currentTime — it is the `FootageStage`, which
// resolves the LIVE in-memory IR at the playhead and seeks a per-source pooled
// `<video>` to the source frame. An edit mutates the working IR + bumps `revision`,
// and the stage re-resolves + re-seeks WITH NO SAVE and NO `/api/proxy-render`.
// That is the no-save edit loop ("HMR for video"). The Remotion overlay draws ON
// TOP exactly as before; its transparent regions reveal the composited footage.
import { useClock } from "../ClockProvider";
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
  /** Overlay duration in frames. */
  overlayDuration: number;
  /** Props for the overlay composition. */
  overlayProps?: Record<string, unknown>;
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
  overlayDuration,
  overlayProps,
  volume,
  muted,
  sinkId,
}: PreviewPaneProps) {
  // Subscribe so the pane re-renders on a frame change (the stage itself repaints
  // imperatively, but the box must stay mounted for the whole session).
  useClock();

  const aspect = `${width} / ${height}`;

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
          route={route}
          volume={volume}
          muted={muted}
          sinkId={sinkId}
        />
        <OverlayPlayer
          width={width}
          height={height}
          fps={fps}
          durationInFrames={overlayDuration}
          {...(overlayProps ? { inputProps: overlayProps } : {})}
        />
      </div>
    </div>
  );
}
