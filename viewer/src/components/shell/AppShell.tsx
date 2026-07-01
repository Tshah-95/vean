// The editor shell: full-width top bar over a four-zone row —
//   icon rail · contextual content rail · stage (children) · inspector.
// Owns the active-destination + collapse state. Destinations FILL the content
// rail; the stage (monitor + timeline, passed as children) never moves. "edit"
// is the focus destination that collapses the content rail. See DESIGN-UI.md.
import { type ReactNode, useState } from "react";
import type { ProjectEntry } from "../../api";
import type { Fps } from "../../types";
import { ChecksPanel } from "../panels/ChecksPanel";
import { MediaPanel } from "../panels/MediaPanel";
import { RenderPanel } from "../panels/RenderPanel";
import { SessionsPanel } from "../panels/SessionsPanel";
import { SetupPanel } from "../panels/SetupPanel";
import { ContentRail } from "./ContentRail";
import type { DestId } from "./destinations";
import { IconRail } from "./IconRail";
import { Inspector } from "./Inspector";
import { TopBar } from "./TopBar";

export interface AppShellProps {
  title: string;
  /** URL-param route used to scope panel/diagnostics fetches (may be undefined → server default). */
  route?: string;
  /** Resolved display route shown in the top bar. */
  displayRoute?: string;
  project?: string;
  baseTitle: string;
  fps: Fps;
  width: number;
  height: number;
  diagnostics?: { errors: number; warnings: number } | null;
  projects?: ProjectEntry[];
  currentResolvedPath?: string;
  /** The stage: monitor + transport + timeline. */
  children: ReactNode;
}

export function AppShell(props: AppShellProps) {
  const [active, setActive] = useState<DestId>("media");
  const [collapsed, setCollapsed] = useState(false);

  const railOpen = !collapsed && active !== "edit";
  const railActive: DestId = railOpen ? active : "edit";
  const checksCount = props.diagnostics ? props.diagnostics.errors + props.diagnostics.warnings : 0;

  const onSelect = (id: DestId) => {
    // "edit" is focus mode; re-clicking the open destination also collapses.
    if (id === "edit" || (id === active && railOpen)) {
      setCollapsed(true);
      if (id !== "edit") setActive(id);
      return;
    }
    setActive(id);
    setCollapsed(false);
  };

  return (
    <div className="flex h-full flex-col bg-background font-sans text-foreground">
      <TopBar
        title={props.title}
        displayRoute={props.displayRoute}
        fps={props.fps}
        width={props.width}
        height={props.height}
        diagnostics={props.diagnostics}
        projects={props.projects}
        currentResolvedPath={props.currentResolvedPath}
      />
      <div className="flex min-h-0 flex-1">
        <IconRail
          active={railActive}
          checksCount={checksCount}
          onSelect={onSelect}
          projectInitial={(props.baseTitle[0] ?? "•").toUpperCase()}
        />
        {railOpen ? (
          <ContentRail>
            {active === "media" ? <MediaPanel project={props.project} /> : null}
            {active === "checks" ? <ChecksPanel route={props.route} /> : null}
            {active === "branch" ? (
              <SessionsPanel project={props.project} route={props.route} baseTitle={props.baseTitle} />
            ) : null}
            {active === "jobs" ? <RenderPanel route={props.route} /> : null}
            {active === "settings" ? <SetupPanel project={props.project} /> : null}
          </ContentRail>
        ) : null}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-inset">{props.children}</main>
        <Inspector />
      </div>
    </div>
  );
}
