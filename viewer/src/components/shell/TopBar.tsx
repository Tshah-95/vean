// The full-width top bar: product mark, project switcher, the active timeline
// route, the resolution / fps / diagnostics badges, and the Settings + Export
// actions. Restyled onto tokens.
import { Settings } from "lucide-react";
import type { ProjectEntry } from "../../api";
import type { Fps } from "../../types";

function fpsLabel(fps: Fps): string {
  const ratio = fps[0] / fps[1];
  return Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(2);
}

function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "ok" | "warn" | "error";
}) {
  const toneClass =
    tone === "error"
      ? "text-red"
      : tone === "warn"
        ? "text-amber"
        : tone === "ok"
          ? "text-track-audio"
          : "text-muted-foreground";
  return (
    <span className={`rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] ${toneClass}`}>
      {children}
    </span>
  );
}

export function TopBar({
  title,
  displayRoute,
  fps,
  width,
  height,
  diagnostics,
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
  diagnostics?: { errors: number; warnings: number } | null;
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
      <span className="flex-1" />
      <Badge>
        {width}×{height}
      </Badge>
      <Badge>{fpsLabel(fps)} fps</Badge>
      {diagnostics ? (
        <Badge tone={diagnostics.errors > 0 ? "error" : diagnostics.warnings > 0 ? "warn" : "ok"}>
          {diagnostics.errors} err · {diagnostics.warnings} warn
        </Badge>
      ) : null}
      <button
        type="button"
        onClick={onSettings}
        title="Settings"
        aria-label="Settings"
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60"
      >
        <Settings size={16} strokeWidth={1.75} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onExport}
        className="rounded-md border border-[#3a3524] px-2.5 py-0.5 text-xs text-primary transition-colors hover:bg-primary/10"
      >
        Export
      </button>
    </header>
  );
}
