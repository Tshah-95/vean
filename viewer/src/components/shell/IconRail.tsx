// The left icon rail: destinations up top, Settings + project avatar pinned at the
// bottom. Active = gold icon tile; inactive muted with a hover-brighten (the
// Carlo interaction language). Clicking a destination fills the content rail; it
// never rearranges the monitor/timeline.
import type { LucideIcon } from "lucide-react";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { DESTINATIONS, type DestId } from "./destinations";

function Tile({
  icon: Icon,
  label,
  active,
  badge,
  onClick,
  title,
}: {
  icon: LucideIcon;
  label?: string;
  active: boolean;
  badge?: number;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      aria-current={active ? "page" : undefined}
      className="group flex w-full flex-col items-center gap-1 py-1.5"
    >
      <span
        className={cn(
          "relative flex size-8 items-center justify-center rounded-md transition-colors",
          active ? "bg-primary/15 text-primary" : "text-muted-foreground group-hover:bg-accent/60",
        )}
      >
        <Icon size={18} strokeWidth={1.75} aria-hidden />
        {badge ? (
          <span className="absolute -right-1.5 -top-1 min-w-[15px] rounded-full bg-amber px-1 text-center text-[10px] font-medium leading-[15px] text-[#231b0a]">
            {badge > 99 ? "99+" : badge}
          </span>
        ) : null}
      </span>
      {label ? (
        <span className={cn("text-[11px] tracking-tight", active ? "text-foreground" : "text-muted-foreground")}>
          {label}
        </span>
      ) : null}
    </button>
  );
}

export function IconRail({
  active,
  checksCount,
  onSelect,
  projectInitial,
}: {
  active: DestId;
  checksCount: number;
  onSelect: (id: DestId) => void;
  projectInitial: string;
}) {
  return (
    <nav className="flex w-[52px] flex-shrink-0 flex-col items-center gap-0.5 border-r border-sidebar-border bg-sidebar py-2.5">
      {DESTINATIONS.map((d) => (
        <Tile
          key={d.id}
          icon={d.icon}
          label={d.label}
          active={active === d.id}
          badge={d.id === "checks" && checksCount > 0 ? checksCount : undefined}
          onClick={() => onSelect(d.id)}
        />
      ))}
      <span className="flex-1" />
      <Tile
        icon={Settings}
        active={active === "settings"}
        onClick={() => onSelect("settings")}
        title="Settings"
      />
      <div
        className="mb-1 mt-1 flex size-6 items-center justify-center rounded-full bg-primary/15 text-[11px] font-medium text-primary"
        title="Project"
      >
        {projectInitial}
      </div>
    </nav>
  );
}
