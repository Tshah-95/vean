// The viewer app. Loads the timeline IR (/api/timeline), configures the master
// clock to the profile fps + total frames, kicks off the footage-proxy render
// (/api/proxy-render), and derives the overlay (the Remotion graphic clip) so the
// @remotion/player shows the right composition for the right span. All preview
// layers are slaved to the one master clock (see ClockProvider + PreviewPane).
import { useEffect, useMemo, useState } from "react";
import { fetchDiagnostics, fetchTimeline, renderProxy } from "./api";
import { ClockProvider, useClockInstance } from "./ClockProvider";
import { Header } from "./components/Header";
import { PreviewPane } from "./components/PreviewPane";
import { TimelineStrip } from "./components/TimelineStrip";
import { Transport } from "./components/Transport";
import type { TimelineResponse } from "./types";
import { isGraphicClip, placeItems } from "./types";

/** Find the first graphic overlay clip in the timeline and read its placement +
 *  props, so the Player renders the right composition over the right span. */
function deriveOverlay(data: TimelineResponse): {
  duration: number;
  props: Record<string, unknown> | undefined;
} {
  for (const track of data.timeline.tracks.video) {
    for (const placed of placeItems(track)) {
      if (placed.item.kind === "clip" && isGraphicClip(placed.item)) {
        return { duration: placed.length, props: undefined };
      }
    }
  }
  // No overlay in the timeline → a 1-frame transparent overlay (no-op).
  return { duration: data.totalFrames, props: undefined };
}

function Viewer({ route }: { route: string | undefined }) {
  const clock = useClockInstance();
  const [data, setData] = useState<TimelineResponse | null>(null);
  const [proxyUrl, setProxyUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diag, setDiag] = useState<{ errors: number; warnings: number } | null>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);

  // Load the timeline IR + configure the clock.
  useEffect(() => {
    let cancelled = false;
    fetchTimeline(route)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        clock.configure(res.fps, res.totalFrames);
      })
      .catch((e) => !cancelled && setError(String(e?.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [route, clock]);

  // Kick off the footage proxy render once we have a timeline.
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    renderProxy(route)
      .then((res) => !cancelled && setProxyUrl(res.proxyUrl))
      .catch((e) => !cancelled && setError((prev) => prev ?? `proxy: ${String(e?.message ?? e)}`));
    return () => {
      cancelled = true;
    };
  }, [data, route]);

  // Best-effort diagnostics badge.
  useEffect(() => {
    if (!data) return;
    fetchDiagnostics(route)
      .then((res) => {
        const h = res.health as { errors?: number; warnings?: number };
        setDiag({ errors: h.errors ?? 0, warnings: h.warnings ?? 0 });
      })
      .catch(() => setDiag(null));
  }, [data, route]);

  // Keyboard: space toggles play/pause; arrows step a frame.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") {
        e.preventDefault();
        clock.toggle();
      } else if (e.code === "ArrowRight") {
        clock.seekTo(clock.getSnapshot().currentFrame + 1);
      } else if (e.code === "ArrowLeft") {
        clock.seekTo(clock.getSnapshot().currentFrame - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clock]);

  const overlay = useMemo(() => (data ? deriveOverlay(data) : null), [data]);

  if (error) {
    return (
      <div style={{ padding: 24, color: "#e08585", fontFamily: "ui-monospace, monospace" }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Failed to load timeline</div>
        <div style={{ color: "#9aa0ae" }}>{error}</div>
        <div style={{ color: "#6b7280", marginTop: 12, fontSize: 12 }}>
          Set an active timeline with <code>vean timeline use &lt;path.mlt&gt;</code>, then reload.
        </div>
      </div>
    );
  }

  if (!data || !overlay) {
    return <div style={{ padding: 24, color: "#6b7280" }}>Loading timeline…</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Header
        title={data.timeline.title}
        route={data.route}
        fps={data.fps}
        width={data.profile.width}
        height={data.profile.height}
        diagnostics={diag}
      />
      <PreviewPane
        width={data.profile.width}
        height={data.profile.height}
        fps={data.fps}
        proxyUrl={proxyUrl}
        overlayDuration={overlay.duration}
        volume={volume}
        muted={muted}
        {...(overlay.props ? { overlayProps: overlay.props } : {})}
      />
      <Transport
        volume={volume}
        muted={muted}
        onVolumeChange={setVolume}
        onMutedChange={setMuted}
      />
      <TimelineStrip timeline={data.timeline} totalFrames={data.totalFrames} />
    </div>
  );
}

export function App() {
  // Allow ?route= override in the URL (e.g. for testing a non-default timeline).
  const route = useMemo(() => new URLSearchParams(window.location.search).get("route") ?? undefined, []);
  return (
    <ClockProvider>
      <Viewer route={route} />
    </ClockProvider>
  );
}
