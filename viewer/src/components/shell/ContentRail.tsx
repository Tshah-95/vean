// The contextual content rail: a slim, scrollable column that renders the active
// destination's panel (media list, checks, branches, jobs, settings). The active
// destination fills it; the monitor + timeline to its right never move. Collapsed
// entirely when the "edit" focus destination is active.
import type { ReactNode } from "react";

export function ContentRail({ children }: { children: ReactNode }) {
  return (
    <aside className="flex w-[216px] flex-shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-panel">
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </aside>
  );
}
