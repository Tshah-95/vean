// Render / still preview panel — drives render.still (one frame at the playhead)
// and render.video (full MP4) through the action runtime and shows the artifacts
// inline. Both are produced by melt; the server caches them under .vean/cache/render
// and streams them back Range-capably so <img>/<video> just work.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { renderStill, renderVideo } from "../../api";
import { useClockInstance } from "../../ClockProvider";
import { Note, PanelHead } from "./ui";

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

  return (
    <div className="flex h-full flex-col">
      <PanelHead title="Render">
        <Button size="sm" variant="outline" onClick={doStill} disabled={busy !== null}>
          {busy === "still" ? "Rendering…" : "Still @ playhead"}
        </Button>
        <Button size="sm" variant="outline" onClick={doVideo} disabled={busy !== null}>
          {busy === "video" ? "Rendering…" : "Export MP4"}
        </Button>
      </PanelHead>
      {err && <Note kind="error">{err}</Note>}
      <div className="flex flex-1 flex-col gap-3.5 overflow-auto p-2.5">
        {!stillUrl && !videoUrl && !err && (
          <Note kind="dim">
            Render a still at the playhead, or export the full MP4. Artifacts are produced by melt
            through the action runtime and cached under .vean/cache/render.
          </Note>
        )}
        {stillUrl && (
          <div>
            <div className="mb-1.5 text-[11px] text-muted-foreground">Still</div>
            <img src={stillUrl} alt="rendered still" className="block w-full rounded-md border border-border" />
          </div>
        )}
        {videoUrl && (
          <div>
            <div className="mb-1.5 text-[11px] text-muted-foreground">MP4 export</div>
            {/* biome-ignore lint/a11y/useMediaCaption: local render preview, no caption track */}
            <video src={videoUrl} controls className="block w-full rounded-md border border-border" />
          </div>
        )}
      </div>
    </div>
  );
}
