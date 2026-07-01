// The left drawer: an icon-only tab header over a body that renders the active
// section. This REPLACES the vertical icon rail — nav lives at the top of the
// drawer (horizontal space is the scarce resource in an editor, so we don't spend
// a full-height column on it). Shares vertical space with the preview; the
// full-width timeline sits below it. Fixed width for now (see layout.ts).
import { cn } from "@/lib/utils";
import { ChatPanel } from "../panels/ChatPanel";
import { ChecksPanel } from "../panels/ChecksPanel";
import { MediaPanel } from "../panels/MediaPanel";
import { RenderPanel } from "../panels/RenderPanel";
import { SessionsPanel } from "../panels/SessionsPanel";
import { SetupPanel } from "../panels/SetupPanel";
import { DRAWER_TABS, type DrawerView } from "./layout";

export function Drawer({
  view,
  onSelect,
  width,
  checksCount,
  project,
  route,
  baseTitle,
}: {
  view: DrawerView;
  onSelect: (view: DrawerView) => void;
  width: number;
  checksCount: number;
  project?: string;
  route?: string;
  baseTitle: string;
}) {
  return (
    <aside
      style={{ width }}
      className="flex flex-shrink-0 flex-col border-r border-sidebar-border bg-panel"
    >
      <div className="flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-sidebar-border px-1.5">
        {DRAWER_TABS.map((t) => {
          const active = view === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onSelect(t.id)}
              title={t.title}
              aria-label={t.title}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex size-7 items-center justify-center rounded-md transition-colors",
                active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              <t.icon size={16} strokeWidth={1.75} aria-hidden />
              {t.id === "checks" && checksCount > 0 ? (
                <span className="absolute right-0.5 top-0.5 size-[5px] rounded-full bg-amber" />
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {view === "media" ? <MediaPanel project={project} route={route} /> : null}
        {view === "checks" ? <ChecksPanel route={route} /> : null}
        {view === "branch" ? <SessionsPanel project={project} route={route} baseTitle={baseTitle} /> : null}
        {view === "jobs" ? <RenderPanel route={route} /> : null}
        {view === "chat" ? <ChatPanel /> : null}
        {view === "settings" ? <SetupPanel project={project} /> : null}
      </div>
    </aside>
  );
}
