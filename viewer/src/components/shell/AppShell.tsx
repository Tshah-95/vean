// The editor shell (Palmier-shaped): a full-width top bar; a TOP BAND that splits
// left drawer · preview · right panel; and a FULL-WIDTH TIMELINE band beneath them.
// The drawer + right panel share vertical space with the preview only — the
// timeline gets the whole width (horizontal space is the scarce resource). The
// preview and timeline arrive as slots so the editor owner (Stage) can keep one
// `editor`/`clock` feeding both. See DESIGN-UI.md.
import { type ReactNode, useState } from "react";
import type { ProjectEntry } from "../../api";
import type { Fps } from "../../types";
import { Drawer } from "./Drawer";
import { DEFAULT_LAYOUT, type DrawerView } from "./layout";
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
  /** Ambient autosave state shown in the top bar (there is no Save button). */
  saveState?: "saved" | "saving";
  projects?: ProjectEntry[];
  currentResolvedPath?: string;
  /** Center of the top band: monitor + transport. */
  preview: ReactNode;
  /** Right of the top band: the selection-driven inspector (editor-fed by Stage). */
  inspector: ReactNode;
  /** Full-width bottom band: the timeline. */
  timeline: ReactNode;
}

export function AppShell(props: AppShellProps) {
  const [view, setView] = useState<DrawerView>("media");
  const layout = DEFAULT_LAYOUT;
  const checksCount = props.diagnostics ? props.diagnostics.errors + props.diagnostics.warnings : 0;

  return (
    <div className="flex h-full flex-col bg-background font-sans text-foreground">
      <TopBar
        title={props.title}
        displayRoute={props.displayRoute}
        fps={props.fps}
        width={props.width}
        height={props.height}
        saveState={props.saveState}
        projects={props.projects}
        currentResolvedPath={props.currentResolvedPath}
        onSettings={() => setView("settings")}
        onExport={() => setView("jobs")}
      />

      {/* TOP BAND: drawer · preview · right panel */}
      <div className="flex min-h-0 flex-1">
        <Drawer
          view={view}
          onSelect={setView}
          width={layout.drawer.size}
          checksCount={checksCount}
          project={props.project}
          route={props.route}
          baseTitle={props.baseTitle}
        />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-inset">{props.preview}</main>
        <aside
          style={{ width: layout.right.size }}
          className="flex flex-shrink-0 flex-col overflow-auto border-l border-sidebar-border bg-panel px-3 py-3"
        >
          {props.inspector}
        </aside>
      </div>

      {/* FULL-WIDTH TIMELINE BAND */}
      <div className="min-h-0 flex-shrink-0 border-t border-sidebar-border">{props.timeline}</div>
    </div>
  );
}
