// The right panel content: the selection-driven Inspector (in/out/length/audio +
// the Detach action that calls the real detachAudio op), the timeline Format facts,
// and a Consequences placeholder. AppShell owns the sized <aside> wrapper; this
// returns the content.
import { Scissors } from "lucide-react";
import { Eyebrow } from "@/components/ui/eyebrow";
import type { Fps, Timeline } from "../../types";
import type { TimelineEditor } from "../../useTimelineEditor";

function fpsLabel(fps: Fps): string {
  const ratio = fps[0] / fps[1];
  return Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(2);
}

function aspect(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h) || 1;
  return `${w / g}:${h / g}`;
}

function basename(resource: string): string {
  const last = resource.replace(/\\/g, "/").split("/").pop() ?? resource;
  return last.length > 26 ? `${last.slice(0, 23)}…` : last;
}

/** The selected clip (searched across all tracks by stable id), or null. */
function selectedClip(timeline: Timeline, id: string | null) {
  if (!id) return null;
  for (const tr of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const it of tr.items) {
      if (it.kind === "clip" && it.id === id) return it;
    }
  }
  return null;
}

function Row({ label, value, tone }: { label: string; value: string; tone?: "gold" }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono ${tone === "gold" ? "text-primary" : "text-foreground"}`}>{value}</span>
    </div>
  );
}

export function RightPanel({
  editor,
  fps,
  videoWidth,
  videoHeight,
}: {
  editor: TimelineEditor;
  fps: Fps;
  videoWidth: number;
  videoHeight: number;
}) {
  const clip = selectedClip(editor.timeline, editor.selectedId);
  const audioStreams = clip?.audioStreams;
  const hasAudio = clip?.hasAudio ?? (audioStreams != null && audioStreams > 0);

  return (
    <>
      <Eyebrow>Inspector</Eyebrow>
      {clip ? (
        <div className="mt-2">
          <div className="mb-2 truncate text-xs text-foreground">{clip.label ?? basename(clip.resource)}</div>
          <Row label="in" value={String(clip.in)} />
          <Row label="out" value={String(clip.out)} />
          <Row label="length" value={String(clip.out - clip.in + 1)} />
          {audioStreams != null ? <Row label="audio" value={hasAudio ? `${audioStreams} ch` : "none"} /> : null}
          {hasAudio ? (
            <button
              type="button"
              onClick={() => {
                void editor.commit({ op: "detachAudio", args: { uuid: clip.id } });
              }}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs text-foreground transition-colors hover:bg-accent/60"
              title="Split this clip's audio onto its own track, joined by a typed A/V link"
            >
              <Scissors size={13} strokeWidth={1.75} className="text-primary" aria-hidden />
              Detach audio
            </button>
          ) : null}
        </div>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          Select a clip to inspect its in / out, length, and audio.
        </p>
      )}

      <div className="my-3 border-t border-sidebar-border" />

      <Eyebrow>Format</Eyebrow>
      <div className="mt-2">
        <Row label="resolution" value={`${videoWidth}×${videoHeight}`} />
        <Row label="frame rate" value={`${fpsLabel(fps)} fps`} />
        <Row label="aspect" value={aspect(videoWidth, videoHeight)} />
      </div>

      <div className="my-3 border-t border-sidebar-border" />

      <Eyebrow>Consequences</Eyebrow>
      <p className="mt-2 text-xs text-fg-3">No pending edit.</p>
    </>
  );
}
