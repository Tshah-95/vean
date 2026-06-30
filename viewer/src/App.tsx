// The viewer app. Loads the timeline IR (/api/timeline), configures the master
// clock to the profile fps + total frames, and derives the overlay (the Remotion
// graphic clip) so the @remotion/player shows the right composition for the right
// span. The footage layer is LIVE: the `PreviewPane`'s `FootageStage` resolves the
// working IR at the playhead and seeks per-source `<video>`s — NO `melt` proxy, no
// save (DESIGN-LIVE-PREVIEW §6 Tier 0). All preview layers are slaved to the one
// master clock (see ClockProvider + PreviewPane).
import { useEffect, useMemo, useState } from "react";
import { fetchDiagnostics, fetchProjects, fetchTimeline, type ProjectEntry } from "./api";
import { ClockProvider, useClockInstance } from "./ClockProvider";
import { installDecodeBridge } from "./decode/debugBridge";
import { Header } from "./components/Header";
import { PreviewPane } from "./components/PreviewPane";
import { Sidebar } from "./components/Sidebar";
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

  // The footage layer is LIVE — no whole-timeline `melt` proxy render kicks off on
  // load or per edit. `PreviewPane`'s `FootageStage` resolves the working IR at the
  // playhead and seeks per-source `<video>`s through `/api/media`. (The export-path
  // proxy `/api/proxy-render` survives as a fallback for non-Tier-0 cases, but it
  // is no longer the realtime footage source — DESIGN-LIVE-PREVIEW §0, §6 Tier 0.)

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
    <div style={{ display: "flex", height: "100%" }}>
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
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
        <Stage
          data={data}
          route={route}
          overlay={overlay}
          volume={volume}
          muted={muted}
          sinkId={sinkId}
          onVolumeChange={setVolume}
          onMutedChange={setMuted}
          onSinkChange={setSinkId}
        />
      </div>
      <Sidebar route={route} />
    </div>
  );
}

/** The interactive STAGE: owns the timeline EDITOR (the working IR + revision +
 *  undo/redo/save/diagnostics) and projects it to BOTH the live `PreviewPane`
 *  (footage stage resolves the working IR at the playhead) and the editing strip,
 *  so an edit is reflected in the preview with no save. Also owns the edit keyboard
 *  (Cmd+Z / Cmd+Shift+Z / Cmd+S, B to blade the selected clip at the playhead).
 *  Mounted only once a timeline has loaded, so the editor hook always has a real IR
 *  to start from — and so the footage stage always has the LIVE working IR to draw,
 *  the single source of truth the no-save loop depends on (§4: the compositor reads
 *  the in-memory working IR the edit loop pushes on every op). */
function Stage({
  data,
  route,
  overlay,
  volume,
  muted,
  sinkId,
  onVolumeChange,
  onMutedChange,
  onSinkChange,
}: {
  data: TimelineResponse;
  route: string | undefined;
  overlay: { duration: number; props: Record<string, unknown> | undefined };
  volume: number;
  muted: boolean;
  sinkId: string;
  onVolumeChange: (v: number) => void;
  onMutedChange: (m: boolean) => void;
  onSinkChange: (id: string) => void;
}) {
  const clock = useClockInstance();
  const editor = useTimelineEditor(data.timeline, data.totalFrames, route);

  // Keep the master clock's total-frame bound in step with the working IR: a
  // ripple/trim that changes the timeline length must move the playhead's clamp so
  // the live footage stage can resolve frames the edit just created/removed. Uses
  // `setTotalFrames` (not `configure`) so an edit never pauses playback or re-clamps
  // the playhead to 0 — it just widens/narrows the bound (no-op when unchanged).
  useEffect(() => {
    clock.setTotalFrames(editor.totalFrames);
  }, [clock, editor.totalFrames]);

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

  return (
    <>
      <PreviewPane
        width={data.profile.width}
        height={data.profile.height}
        fps={data.fps}
        timeline={editor.timeline}
        revision={editor.revision}
        route={route}
        overlayDuration={overlay.duration}
        volume={volume}
        muted={muted}
        sinkId={sinkId}
        {...(overlay.props ? { overlayProps: overlay.props } : {})}
      />
      <Transport
        volume={volume}
        muted={muted}
        onVolumeChange={onVolumeChange}
        onMutedChange={onMutedChange}
        sinkId={sinkId}
        onSinkChange={onSinkChange}
      />
      <TimelineStrip editor={editor} />
    </>
  );
}

export function App() {
  // Allow ?route= override in the URL (e.g. for testing a non-default timeline).
  const route = useMemo(() => new URLSearchParams(window.location.search).get("route") ?? undefined, []);
  // Attach the headless decode bridge (`window.__veanDecode`) so the §9-step-3 gate
  // can decode a real clip in-browser via `drive` + `agent-browser eval`. Side-
  // effect only — no UI; the Tier-1 compositor consumes the same `Decoder` directly.
  useEffect(() => {
    installDecodeBridge();
  }, []);
  return (
    <ClockProvider>
      <Viewer route={route} />
    </ClockProvider>
  );
}
