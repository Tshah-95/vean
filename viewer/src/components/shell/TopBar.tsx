// The full-width top bar: product mark, project switcher, the active timeline
// route, the resolution / fps / diagnostics badges, and the Settings + Export
// actions. Restyled onto tokens.
import { Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ProjectEntry } from "../../api";
import type { Fps } from "../../types";

function fpsLabel(fps: Fps): string {
  const ratio = fps[0] / fps[1];
  return Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(2);
}

export function TopBar({
  title,
  displayRoute,
  fps,
  width,
  height,
  saveState,
  projects = [],
  currentResolvedPath,
  onSettings,
  onExport,
}: {
  title: string;
  displayRoute?: string;
  fps: Fps;
  width: number;
  height: number;
  /** Ambient autosave state — the document is always saved; this just says so. */
  saveState?: "saved" | "saving";
  projects?: ProjectEntry[];
  currentResolvedPath?: string;
  onSettings: () => void;
  onExport: () => void;
}) {
  const switchable = projects.filter((p) => p.timelinePath);
  const active = switchable.find((p) => p.timelinePath === currentResolvedPath);
  return (
    <header className="flex h-9 flex-shrink-0 items-center gap-3 border-b border-sidebar-border bg-sidebar px-3">
      <span className="font-mono text-xs text-muted-foreground">vean</span>
      {switchable.length > 1 ? (
        <select
          value={active?.timelinePath ?? ""}
          onChange={(e) => {
            const next = e.target.value;
            if (next) window.location.href = `?route=${encodeURIComponent(next)}`;
          }}
          aria-label="Project"
          title="Switch project"
          className="max-w-[220px] cursor-pointer rounded-md border border-border bg-panel px-2 py-0.5 text-[13px] text-foreground"
        >
          {!active && <option value="">{title}</option>}
          {switchable.map((p) => (
            <option key={p.id} value={p.timelinePath ?? ""}>
              {p.title}
            </option>
          ))}
        </select>
      ) : (
        <span className="text-[13px] text-foreground">{title}</span>
      )}
      {displayRoute ? <span className="font-mono text-[11px] text-fg-3">{displayRoute}</span> : null}
      {saveState ? (
        <span
          className={`font-mono text-[11px] ${saveState === "saving" ? "text-amber" : "text-fg-3"}`}
          title="Edits autosave — the document on disk always matches what you see (⌘S forces it)"
        >
          {saveState === "saving" ? "saving…" : "saved"}
        </span>
      ) : null}
      <span className="flex-1" />
      <Badge>
        {width}×{height}
      </Badge>
      <Badge>{fpsLabel(fps)} fps</Badge>
      <Button size="icon" onClick={onSettings} title="Settings" aria-label="Settings">
        <Settings size={16} strokeWidth={1.75} aria-hidden />
      </Button>
      <Button size="sm" variant="gold" onClick={onExport}>
        Export
      </Button>
    </header>
  );
}
