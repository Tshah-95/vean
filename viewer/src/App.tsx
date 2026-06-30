// The viewer app. Loads the timeline IR (/api/timeline), configures the master
// clock to the profile fps + total frames, kicks off the footage-proxy render
// (/api/proxy-render), and derives the overlay (the Remotion graphic clip) so the
// @remotion/player shows the right composition for the right span. All preview
// layers are slaved to the one master clock (see ClockProvider + PreviewPane).
import { useEffect, useMemo, useState } from "react";
import { fetchDiagnostics, fetchProjects, fetchTimeline, type ProjectEntry, renderProxy } from "./api";
import { ClockProvider, useClockInstance } from "./ClockProvider";
import { Header } from "./components/Header";
import { PreviewPane } from "./components/PreviewPane";
import { TimelineStrip } from "./components/TimelineStrip";
import { Transport } from "./components/Transport";
import type { TimelineResponse } from "./types";
import { isGraphicClip, placeItems } from "./types";
import { useTimelineEditor } from "./useTimelineEditor";

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
  const [sinkId, setSinkId] = useState("");
  const [projects, setProjects] = useState<ProjectEntry[]>([]);

  // Known projects for the picker (independent of the loaded timeline).
  useEffect(() => {
    fetchProjects()
      .then((res) => setProjects(res.projects))
      .catch(() => setProjects([]));
  }, []);

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

  // Reflect the active timeline route into the URL so each tab is stable and
  // shareable — open multiple timelines in multiple browsers via ?route=<path|alias>.
  useEffect(() => {
    if (!data) return;
    const params = new URLSearchParams(window.location.search);
    if (!params.get("route") && data.route) {
      params.set("route", data.route);
      window.history.replaceState(null, "", `?${params.toString()}`);
    }
  }, [data]);

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
        projects={projects}
        currentResolvedPath={data.resolvedPath}
      />
      <PreviewPane
        width={data.profile.width}
        height={data.profile.height}
        fps={data.fps}
        proxyUrl={proxyUrl}
        overlayDuration={overlay.duration}
        volume={volume}
        muted={muted}
        sinkId={sinkId}
        {...(overlay.props ? { overlayProps: overlay.props } : {})}
      />
      <Transport
        volume={volume}
        muted={muted}
        onVolumeChange={setVolume}
        onMutedChange={setMuted}
        sinkId={sinkId}
        onSinkChange={setSinkId}
      />
      <EditorSurface data={data} route={route} />
    </div>
  );
}

/** The interactive editing surface: owns the timeline EDITOR (working IR + undo /
 *  redo / save / diagnostics) and the edit keyboard (Cmd+Z / Cmd+Shift+Z / Cmd+S,
 *  B to blade the selected clip at the playhead). Mounted only once a timeline has
 *  loaded, so the editor hook always has a real IR to start from. */
function EditorSurface({ data, route }: { data: TimelineResponse; route: string | undefined }) {
  const clock = useClockInstance();
  const editor = useTimelineEditor(data.timeline, data.totalFrames, route);

  // Edit keyboard. Undo/redo/save use Cmd (meta); B blades the selected clip at the
  // playhead. Coexists with the play/pause/zoom keys (different keys / handlers).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) editor.redo();
        else editor.undo();
      } else if (meta && (e.key === "y" || e.key === "Y")) {
        // Windows-style redo.
        e.preventDefault();
        editor.redo();
      } else if (meta && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        editor.save();
      } else if (!meta && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        if (editor.selectedId) {
          void editor.commit({
            op: "split",
            args: { uuid: editor.selectedId, frame: clock.getSnapshot().currentFrame },
          });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editor, clock]);

  return <TimelineStrip editor={editor} />;
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
