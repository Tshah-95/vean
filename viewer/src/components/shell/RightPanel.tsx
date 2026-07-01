// The right panel (top band, beside the preview): the Inspector for the selected
// clip, the timeline Format/Project facts, and the Consequences of a pending op.
// PHASE 2R shows Format live + Inspector/Consequences as skeletons; the real
// selection-driven inspector rows + live preview-op consequences land in Phase 4.
import { Eyebrow } from "@/components/ui/eyebrow";
import type { Fps } from "../../types";

function fpsLabel(fps: Fps): string {
  const ratio = fps[0] / fps[1];
  return Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(2);
}

function aspect(w: number, h: number): string {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const g = gcd(w, h) || 1;
  return `${w / g}:${h / g}`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  );
}

export function RightPanel({
  size,
  fps,
  videoWidth,
  videoHeight,
}: {
  size: number;
  fps: Fps;
  videoWidth: number;
  videoHeight: number;
}) {
  return (
    <aside
      style={{ width: size }}
      className="flex flex-shrink-0 flex-col border-l border-sidebar-border bg-panel px-3 py-3"
    >
      <Eyebrow>Inspector</Eyebrow>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Select a clip to inspect its in / out, length, and dials.
      </p>

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
    </aside>
  );
}
