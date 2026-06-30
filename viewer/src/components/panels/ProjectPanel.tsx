// Project dashboard panel — resolved project + route aliases over the action
// runtime (`project.status`, `route.list`).
import { useCallback, useEffect, useState } from "react";
import { runAction } from "../../api";
import { Btn, C, Note, PanelHead, mono } from "./ui";

interface ProjectStatus {
  project: { rootPath: string; title?: string | null; id?: string; source?: string } | null;
  state?: unknown;
  configPath?: string;
}

interface RouteAlias {
  id: string;
  alias: string;
  target: string;
}

export function ProjectPanel({ project }: { project?: string }) {
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [routes, setRoutes] = useState<RouteAlias[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [s, r] = await Promise.all([
        runAction<ProjectStatus>("project.status", {}, project),
        runAction<RouteAlias[]>("route.list", {}, project),
      ]);
      setStatus(s);
      setRoutes(Array.isArray(r) ? r : []);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load]);

  const p = status?.project;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PanelHead title="Project">
        <Btn onClick={() => void load()}>Refresh</Btn>
      </PanelHead>
      {err && <Note kind="error">{err}</Note>}
      <div style={{ flex: 1, overflow: "auto", padding: "10px" }}>
        {p ? (
          <>
            <div style={{ fontSize: 13, fontWeight: 650, color: C.text, marginBottom: 2 }}>
              {p.title || "Untitled project"}
            </div>
            <div
              style={{
                fontSize: 11,
                color: C.dim,
                fontFamily: mono,
                wordBreak: "break-all",
                marginBottom: 14,
              }}
            >
              {p.rootPath}
            </div>
          </>
        ) : (
          <Note kind="dim">No project resolved.</Note>
        )}
        <div style={{ fontSize: 11, fontWeight: 650, color: C.muted, margin: "4px 0 6px" }}>
          Routes · {routes.length}
        </div>
        {routes.map((r) => (
          <div
            key={r.id}
            style={{
              display: "flex",
              gap: 8,
              fontSize: 11,
              padding: "3px 0",
              borderBottom: `1px solid ${C.border}33`,
            }}
          >
            <span style={{ color: C.accent, fontFamily: mono, flexShrink: 0 }}>{r.alias}</span>
            <span
              style={{
                color: C.dim,
                fontFamily: mono,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={r.target}
            >
              {r.target}
            </span>
          </div>
        ))}
        {routes.length === 0 && <Note kind="dim">No route aliases.</Note>}
      </div>
    </div>
  );
}
