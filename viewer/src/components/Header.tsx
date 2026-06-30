// Header: a project picker, the timeline name/route, an fps badge, and a
// diagnostics count.
import type { ProjectEntry } from "../api";
import type { Fps } from "../types";

export interface HeaderProps {
  title: string;
  route: string;
  fps: Fps;
  width: number;
  height: number;
  diagnostics?: { errors: number; warnings: number } | null;
  /** Known projects for the switcher (from ~/.vean/projects.json). */
  projects?: ProjectEntry[];
  /** Absolute path of the currently-loaded timeline (to mark the active project). */
  currentResolvedPath?: string;
}

function fpsLabel(fps: Fps): string {
  const ratio = fps[0] / fps[1];
  // 29.97 / 23.976 read better with two decimals; integers stay clean.
  return Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(2);
}

export function Header({
  title,
  route,
  fps,
  width,
  height,
  diagnostics,
  projects = [],
  currentResolvedPath,
}: HeaderProps) {
  const switchable = projects.filter((p) => p.timelinePath);
  const active = switchable.find((p) => p.timelinePath === currentResolvedPath);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 16px",
        background: "#0b0c0f",
        borderBottom: "1px solid #1b1e26",
      }}
    >
      <div style={{ fontWeight: 700, fontSize: 14, color: "#e6e8ee" }}>vean preview</div>
      {switchable.length > 1 ? (
        <select
          value={active?.timelinePath ?? ""}
          onChange={(e) => {
            const next = e.target.value;
            if (next) window.location.href = `?route=${encodeURIComponent(next)}`;
          }}
          aria-label="Project"
          title="Switch project"
          style={{
            fontSize: 13,
            color: "#e6e8ee",
            background: "#161922",
            border: "1px solid #2a2e3a",
            borderRadius: 6,
            padding: "3px 8px",
            cursor: "pointer",
            maxWidth: 220,
          }}
        >
          {!active && <option value="">{title}</option>}
          {switchable.map((p) => (
            <option key={p.id} value={p.timelinePath ?? ""}>
              {p.title}
            </option>
          ))}
        </select>
      ) : (
        <div style={{ fontSize: 13, color: "#9aa0ae" }}>{title}</div>
      )}
      <div style={{ fontSize: 12, color: "#6b7280", fontFamily: "ui-monospace, monospace" }}>{route}</div>
      <div style={{ flex: 1 }} />
      <Badge label={`${width}×${height}`} />
      <Badge label={`${fpsLabel(fps)} fps`} />
      {diagnostics ? (
        <Badge
          label={`${diagnostics.errors} err · ${diagnostics.warnings} warn`}
          tone={diagnostics.errors > 0 ? "error" : diagnostics.warnings > 0 ? "warn" : "ok"}
        />
      ) : null}
    </div>
  );
}

function Badge({ label, tone = "neutral" }: { label: string; tone?: "neutral" | "ok" | "warn" | "error" }) {
  const colors: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: "#161922", fg: "#9aa0ae" },
    ok: { bg: "#13261a", fg: "#7fd99a" },
    warn: { bg: "#2a2310", fg: "#e2c275" },
    error: { bg: "#2a1414", fg: "#e08585" },
  };
  const c = colors[tone] ?? colors.neutral;
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: "ui-monospace, monospace",
        padding: "3px 8px",
        borderRadius: 5,
        background: c.bg,
        color: c.fg,
      }}
    >
      {label}
    </span>
  );
}
