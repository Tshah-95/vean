// The product-panel sidebar: tabbed Media / Jobs / Project surfaces alongside the
// timeline editor. Every panel is backed by the generic action bridge, so this is
// the Move-4 app shell's right rail without any duplicated domain logic. Collapsible
// so it never crowds the editor.
import { useState } from "react";
import { JobsPanel } from "./panels/JobsPanel";
import { MediaPanel } from "./panels/MediaPanel";
import { ProjectPanel } from "./panels/ProjectPanel";
import { RenderPanel } from "./panels/RenderPanel";
import { SessionsPanel } from "./panels/SessionsPanel";
import { SetupPanel } from "./panels/SetupPanel";
import { C } from "./panels/ui";

type Tab = "media" | "render" | "jobs" | "project" | "sessions" | "setup";

const TABS: { id: Tab; label: string }[] = [
  { id: "media", label: "Media" },
  { id: "render", label: "Render" },
  { id: "jobs", label: "Jobs" },
  { id: "project", label: "Project" },
  { id: "sessions", label: "Sessions" },
  { id: "setup", label: "Setup" },
];

export function Sidebar({
  project,
  route,
  baseTitle,
}: {
  project?: string;
  route?: string;
  /** Title of the timeline loaded in the viewer (the diff/still compare baseline). */
  baseTitle: string;
}) {
  const [tab, setTab] = useState<Tab>("media");
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Show panels"
        style={{
          width: 22,
          border: "none",
          borderLeft: `1px solid ${C.border}`,
          background: C.panel,
          color: C.muted,
          cursor: "pointer",
          fontSize: 12,
        }}
      >
        ‹
      </button>
    );
  }

  return (
    <aside
      style={{
        width: 340,
        flexShrink: 0,
        borderLeft: `1px solid ${C.border}`,
        background: C.panel,
        display: "flex",
        flexDirection: "column",
        height: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "stretch", borderBottom: `1px solid ${C.border}` }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{
              flex: 1,
              padding: "8px 0",
              border: "none",
              borderBottom: tab === t.id ? `2px solid ${C.accent}` : "2px solid transparent",
              background: "transparent",
              color: tab === t.id ? C.text : C.muted,
              cursor: "pointer",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {t.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOpen(false)}
          title="Hide panels"
          style={{ width: 28, border: "none", background: "transparent", color: C.muted, cursor: "pointer" }}
        >
          ›
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {tab === "media" && <MediaPanel project={project} />}
        {tab === "render" && <RenderPanel route={route} />}
        {tab === "jobs" && <JobsPanel project={project} />}
        {tab === "project" && <ProjectPanel project={project} />}
        {tab === "sessions" && <SessionsPanel project={project} route={route} baseTitle={baseTitle} />}
        {tab === "setup" && <SetupPanel project={project} />}
      </div>
    </aside>
  );
}
