// The viewer app. Loads the timeline IR (/api/timeline), configures the master
// clock to the profile fps + total frames, and derives the overlay (the Remotion
// graphic clip) so the @remotion/player shows the right composition for the right
// span. The footage layer is LIVE: the `PreviewPane`'s `FootageStage` resolves the
// working IR at the playhead and seeks per-source `<video>`s — NO `melt` proxy, no
// save (DESIGN-LIVE-PREVIEW §6 Tier 0). All preview layers are slaved to the one
// master clock (see ClockProvider + PreviewPane).
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchDiagnostics, fetchProjects, fetchTimeline, type ProjectEntry } from "./api";
import { ClockProvider, useClockInstance } from "./ClockProvider";
import { installDecodeBridge } from "./decode/debugBridge";
import { PreviewPane } from "./components/PreviewPane";
import { AppShell } from "./components/shell/AppShell";
import { RightPanel } from "./components/shell/RightPanel";
import { SourcePreview } from "./components/SourcePreview";
import { TimelineStrip } from "./components/TimelineStrip";
import { Transport } from "./components/Transport";
import { PreviewProvider } from "./PreviewProvider";
import { SourceProvider, useSource } from "./SourceProvider";
import type { TimelineResponse } from "./types";
import { placeItems } from "./types";
import { useTimelineEditor } from "./useTimelineEditor";

// The graphic overlay is resolved PER-FRAME from the working IR (the graphic clip
// active at the playhead) inside `PreviewPane` — see `resolveOverlayAt`. Multi-overlay,
// the comp-frame start offset, and per-span visibility all fall out of that, so there is
// no static, whole-timeline overlay derivation here anymore.

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

  if (!data) {
    return <div style={{ padding: 24, color: "#6b7280" }}>Loading timeline…</div>;
  }

  return (
    <Stage
      data={data}
      route={route}
      volume={volume}
      muted={muted}
      sinkId={sinkId}
      onVolumeChange={setVolume}
      onMutedChange={setMuted}
      onSinkChange={setSinkId}
      projects={projects}
      diagnostics={diag}
    />
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
  volume,
  muted,
  sinkId,
  onVolumeChange,
  onMutedChange,
  onSinkChange,
  projects,
  diagnostics,
}: {
  data: TimelineResponse;
  route: string | undefined;
  volume: number;
  muted: boolean;
  sinkId: string;
  onVolumeChange: (v: number) => void;
  onMutedChange: (m: boolean) => void;
  onSinkChange: (id: string) => void;
  projects: ProjectEntry[];
  diagnostics: { errors: number; warnings: number } | null;
}) {
  const clock = useClockInstance();
  const editor = useTimelineEditor(data.timeline, data.totalFrames, route);
  const { source, monitor, setMonitor } = useSource();
  const showSource = monitor === "source" && source != null;

  // MONITOR-side track mute/hide (view state, not the document): the eye/speaker
  // toggles in the track headers. Muted tracks are handed to the compositor/mixer
  // as EMPTY, so the monitor skips them while the timeline + document keep them.
  const [previewMuted, setPreviewMuted] = useState<Set<string>>(new Set());
  // The compositor repaints on `(currentFrame, revision)` — a mute toggle changes
  // WHAT to draw without an edit, so it must bump the revision the monitor sees.
  const [viewRev, setViewRev] = useState(0);
  const onTogglePreviewMute = useCallback((trackId: string) => {
    setPreviewMuted((prev) => {
      const next = new Set(prev);
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      return next;
    });
    setViewRev((r) => r + 1);
  }, []);
  // Clip boundaries across all tracks — the transport's skip-back/forward targets.
  const editPoints = useMemo(() => {
    const pts = new Set<number>([0]);
    for (const tr of [...editor.timeline.tracks.video, ...editor.timeline.tracks.audio]) {
      for (const p of placeItems(tr)) {
        if (p.item.kind !== "clip") continue;
        pts.add(p.start);
        pts.add(p.start + p.length);
      }
    }
    return [...pts].sort((a, b) => a - b);
  }, [editor.timeline]);

  const viewTimeline = useMemo(() => {
    if (previewMuted.size === 0) return editor.timeline;
    const blank = (t: (typeof editor.timeline.tracks.video)[number]) =>
      previewMuted.has(t.id) ? { ...t, items: [] } : t;
    return {
      ...editor.timeline,
      tracks: {
        video: editor.timeline.tracks.video.map(blank),
        audio: editor.timeline.tracks.audio.map(blank),
      },
    };
  }, [editor.timeline, previewMuted]);

  // Keep the master clock's total-frame bound in step with the working IR: a
  // ripple/trim that changes the timeline length must move the playhead's clamp so
  // the live footage stage can resolve frames the edit just created/removed. Uses
  // `setTotalFrames` (not `configure`) so an edit never pauses playback or re-clamps
  // the playhead to 0 — it just widens/narrows the bound (no-op when unchanged).
  useEffect(() => {
    clock.setTotalFrames(editor.totalFrames);
  }, [clock, editor.totalFrames]);

  // Headless EDIT BRIDGE (`window.__veanEdit`) — the no-UI handle the `drive` gate
  // uses to apply ONE op through the REAL editor path (the same `editor.commit` every
  // mutating gesture funnels through), so the working-IR React state + `revision`
  // update and the footage stage recomposites with NO save. This is the product
  // liveness path; a raw `/api/apply-op` fetch mutates only the server session and
  // would NOT update the React working IR the compositor reads. Side-effect only,
  // mirrors the decode bridge (`installDecodeBridge`); attaches nothing to the UI.
  useEffect(() => {
    (
      window as unknown as {
        __veanEdit?: (op: string, args: Record<string, unknown>) => Promise<unknown>;
      }
    ).__veanEdit = (op, args) => editor.commit({ op, args } as never);
    return () => {
      (window as unknown as { __veanEdit?: unknown }).__veanEdit = undefined;
    };
  }, [editor]);

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

  // AUTOSAVE — there is no Save button: a beat after any committed edit, the
  // working IR serializes to disk, so the document is ALWAYS saved (the top bar
  // shows the ambient "saving…/saved" state). ⌘S still forces an immediate save.
  useEffect(() => {
    if (!editor.dirty) return;
    const t = setTimeout(() => void editor.save(), 1000);
    return () => clearTimeout(t);
  }, [editor.dirty, editor.save]);

  return (
    <AppShell
      title={data.timeline.title}
      route={route}
      displayRoute={data.route}
      baseTitle={data.timeline.title}
      fps={data.fps}
      width={data.profile.width}
      height={data.profile.height}
      diagnostics={diagnostics}
      saveState={editor.dirty ? "saving" : "saved"}
      projects={projects}
      currentResolvedPath={data.resolvedPath}
      preview={
        <>
          {/* Monitor tabs — Program (the timeline) | Source (the selected media). */}
          {source ? (
            <div style={{ display: "flex", gap: 2, padding: "6px 12px 0", fontSize: 11 }}>
              {(["program", "source"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMonitor(m)}
                  aria-current={monitor === m ? "true" : undefined}
                  style={{
                    border: "none",
                    background: "transparent",
                    color: monitor === m ? "#E6E3DA" : "#6B716A",
                    borderBottom: monitor === m ? "2px solid #c7ae7a" : "2px solid transparent",
                    padding: "2px 8px 4px",
                    cursor: "pointer",
                    fontSize: 11,
                  }}
                >
                  {m === "program" ? "Program" : source.name}
                </button>
              ))}
            </div>
          ) : null}
          {/* The program monitor stays MOUNTED while Source shows (decode caches
              stay warm) — it's just not displayed. */}
          <div
            style={{
              display: showSource ? "none" : "flex",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
            }}
          >
            <PreviewPane
              width={data.profile.width}
              height={data.profile.height}
              fps={data.fps}
              timeline={viewTimeline}
              // Edit revision ⊕ view revision: either an edit OR a monitor mute/hide
              // toggle repaints. Edits are sparse ints, so a large stride keeps the
              // combined value monotonic-unique for both.
              revision={editor.revision + viewRev * 1_000_000}
              route={route}
              volume={volume}
              muted={muted}
              sinkId={sinkId}
            />
            <Transport
              editPoints={editPoints}
              volume={volume}
              muted={muted}
              onVolumeChange={onVolumeChange}
              onMutedChange={onMutedChange}
              sinkId={sinkId}
              onSinkChange={onSinkChange}
            />
          </div>
          {showSource ? <SourcePreview route={route} /> : null}
        </>
      }
      inspector={
        <RightPanel
          editor={editor}
          fps={data.fps}
          videoWidth={data.profile.width}
          videoHeight={data.profile.height}
        />
      }
      timeline={
        <TimelineStrip
          editor={editor}
          previewMuted={previewMuted}
          onTogglePreviewMute={onTogglePreviewMute}
        />
      }
    />
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
      <PreviewProvider>
        <SourceProvider>
          <Viewer route={route} />
        </SourceProvider>
      </PreviewProvider>
    </ClockProvider>
  );
}
