// Render / still preview panel — drives render.still (one frame at the playhead)
// and render.video (full MP4) through the action runtime and shows the artifacts
// inline. Both are produced by melt; the server caches them under .vean/cache/render
// and streams them back Range-capably so <img>/<video> just work.
import { useState } from "react";
import { useClockInstance } from "../../ClockProvider";
import { renderStill, renderVideo } from "../../api";
import { Btn, C, Note, PanelHead } from "./ui";

export function RenderPanel({ route }: { route?: string }) {
  const clock = useClockInstance();
  const [stillUrl, setStillUrl] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"still" | "video" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const doStill = async () => {
    setBusy("still");
    setErr(null);
    try {
      const frame = clock.getSnapshot().currentFrame;
      const res = await renderStill(frame, route);
      // Cache-bust: the server overwrites still-<frame>.png in place.
      setStillUrl(`${res.stillUrl}?t=${Date.now()}`);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const doVideo = async () => {
    setBusy("video");
    setErr(null);
    try {
      const res = await renderVideo(route);
      setVideoUrl(`${res.videoUrl}?t=${Date.now()}`);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  };

  const artStyle = {
    width: "100%",
    borderRadius: 6,
    border: `1px solid ${C.border}`,
    display: "block",
  } as const;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PanelHead title="Render">
        <Btn onClick={doStill} disabled={busy !== null}>
          {busy === "still" ? "Rendering…" : "Still @ playhead"}
        </Btn>
        <Btn onClick={doVideo} disabled={busy !== null}>
          {busy === "video" ? "Rendering…" : "Export MP4"}
        </Btn>
      </PanelHead>
      {err && <Note kind="error">{err}</Note>}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: 10,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {!stillUrl && !videoUrl && !err && (
          <Note kind="dim">
            Render a still at the playhead, or export the full MP4. Artifacts are produced by melt
            through the action runtime and cached under .vean/cache/render.
          </Note>
        )}
        {stillUrl && (
          <div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>Still</div>
            <img src={stillUrl} alt="rendered still" style={artStyle} />
          </div>
        )}
        {videoUrl && (
          <div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>MP4 export</div>
            {/* biome-ignore lint/a11y/useMediaCaption: local render preview, no caption track */}
            <video src={videoUrl} controls style={artStyle} />
          </div>
        )}
      </div>
    </div>
  );
}
