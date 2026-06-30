// The composited preview: a footage-proxy <video> UNDER an @remotion/player
// overlay, both locked to the profile aspect and slaved to the master clock.
//
// SYNC (the load-bearing contract):
//   • The <video> is slaved to the clock: on every master frame change we set
//     video.currentTime = frame * fps[1] / fps[0] — but ONLY when the delta
//     exceeds ~1 frame, so the element's own playback during play() doesn't fight
//     the master (feedback). The proxy <video> plays for AUDIO; the RAF master
//     clock owns the integer frame.
//   • During play(), we call video.play() once; during pause() video.pause(). If
//     the element drifts > 2 frames from the master we correct it.
import { useEffect, useRef } from "react";
import { useClock, useClockInstance } from "../ClockProvider";
import type { Fps } from "../types";
import { OverlayPlayer } from "./OverlayPlayer";

export interface PreviewPaneProps {
  /** Profile pixel size (the preview aspect). */
  width: number;
  height: number;
  fps: Fps;
  /** The footage-proxy mp4 URL (or null until /api/proxy-render completes). */
  proxyUrl: string | null;
  /** Overlay duration in frames. */
  overlayDuration: number;
  /** Props for the overlay composition. */
  overlayProps?: Record<string, unknown>;
  /** Playback volume 0–1 (applied to the footage-proxy <video>, the audio source). */
  volume: number;
  /** Mute the footage-proxy audio. */
  muted: boolean;
  /** Output device id for setSinkId ("" = system default). */
  sinkId: string;
}

export function PreviewPane({
  width,
  height,
  fps,
  proxyUrl,
  overlayDuration,
  overlayProps,
  volume,
  muted,
  sinkId,
}: PreviewPaneProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const clock = useClock();
  const clockInstance = useClockInstance();

  // Apply volume/mute to the footage <video> (the only audio source — MLT mixes
  // audio into the proxy; Remotion overlays are silent).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.min(1, Math.max(0, volume));
    video.muted = muted;
  }, [volume, muted, proxyUrl]);

  // Route audio to the chosen output device (setSinkId; "" = system default).
  useEffect(() => {
    const video = videoRef.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!video || typeof video.setSinkId !== "function") return;
    video.setSinkId(sinkId).catch(() => {
      /* device may have vanished or permission denied — fall back to default */
    });
  }, [sinkId, proxyUrl]);

  // Audio-unlock: browsers gate play() on an UNMUTED element to a user gesture,
  // and our clock-driven play() runs from an effect (detached from the click),
  // so the first play silently rejects → motion but no sound. Grant playback on
  // the first real interaction, then reconcile to the clock's play state.
  useEffect(() => {
    let unlocked = false;
    const unlock = () => {
      const video = videoRef.current;
      if (!video || unlocked) return;
      unlocked = true;
      video
        .play()
        .then(() => {
          if (!clockInstance.getSnapshot().playing) video.pause();
        })
        .catch(() => {
          unlocked = false; // let a later gesture retry
        });
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [clockInstance, proxyUrl]);

  const secondsForFrame = (frame: number) => (frame * fps[1]) / fps[0];
  const frameSeconds = fps[1] / fps[0];

  // Slave the footage <video> currentTime to the master frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !proxyUrl) return;
    const expected = secondsForFrame(clock.currentFrame);
    // Only hard-seek when off by more than ~1 frame (avoid fighting native play).
    if (Math.abs(video.currentTime - expected) > frameSeconds * 1.5) {
      video.currentTime = expected;
    }
  }, [clock.currentFrame, proxyUrl]);

  // Drive native <video> play/pause from the master playing flag (for audio).
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !proxyUrl) return;
    if (clock.playing) {
      // Correct drift before resuming.
      const expected = secondsForFrame(clock.currentFrame);
      if (Math.abs(video.currentTime - expected) > frameSeconds * 2) {
        video.currentTime = expected;
      }
      void video.play().catch(() => {
        /* autoplay may be blocked until a user gesture; transport click unblocks it */
      });
    } else {
      video.pause();
    }
  }, [clock.playing, proxyUrl]);

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
        {proxyUrl ? (
          <video
            ref={videoRef}
            src={proxyUrl}
            playsInline
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain" }}
          />
        ) : (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#6b7280",
              fontSize: 13,
            }}
          >
            rendering footage proxy…
          </div>
        )}
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
