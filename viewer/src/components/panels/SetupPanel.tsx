// Guided setup panel — the in-app half of the setup flow. Runs `setup.doctor`
// (probe-skipped for speed) over the action bridge and shows pass/warn/fail, with
// quick-fix actions (initialize project, add a media root). Detection + fixes both
// route through the same actions the CLI `vean doctor` / `project init` /
// `media root add` call — no duplicated logic.
import { useCallback, useEffect, useState } from "react";
import { runAction } from "../../api";
import { Btn, C, Note, PanelHead, fieldStyle, mono } from "./ui";

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}
interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

const statusColor: Record<string, string> = {
  pass: "#5ec98a",
  warn: "#e0b15e",
  fail: "#e0857f",
};

export function SetupPanel({ project }: { project?: string }) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [newRoot, setNewRoot] = useState("");

  const check = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      // probe:false skips the slow stdio LSP/MCP startup probes — fast enough for
      // an interactive panel.
      const r = await runAction<DoctorReport>(
        "setup.doctor",
        { surface: "all", probe: false },
        project,
      );
      setReport(r);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [project]);

  useEffect(() => {
    void check();
  }, [check]);

  const initProject = async () => {
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await runAction("project.init", {}, project);
      setMsg("Project initialized (.vean).");
      await check();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };

  const addRoot = async () => {
    if (!newRoot.trim()) return;
    setBusy(true);
    setMsg(null);
    setErr(null);
    try {
      await runAction("media.root.add", { path: newRoot.trim() }, project);
      setMsg(`Added media root ${newRoot.trim()}`);
      setNewRoot("");
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PanelHead title={report ? `Setup · ${report.ok ? "ready" : "needs attention"}` : "Setup"}>
        <Btn onClick={() => void check()} disabled={busy}>
          {busy ? "Checking…" : "Re-check"}
        </Btn>
      </PanelHead>
      {err && <Note kind="error">{err}</Note>}
      {msg && <Note kind="dim">{msg}</Note>}
      <div style={{ flex: 1, overflow: "auto" }}>
        {!report && !err && <Note kind="dim">Running setup checks…</Note>}
        {report?.checks.map((c) => (
          <div
            key={c.name}
            style={{
              display: "flex",
              gap: 8,
              padding: "5px 10px",
              fontSize: 11,
              borderBottom: `1px solid ${C.border}22`,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 8,
                background: statusColor[c.status] ?? C.dim,
                flexShrink: 0,
                marginTop: 3,
              }}
            />
            <div style={{ minWidth: 0 }}>
              <div style={{ color: C.text }}>{c.name}</div>
              <div
                style={{
                  color: C.dim,
                  fontFamily: mono,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={c.detail}
              >
                {c.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div
        style={{
          borderTop: `1px solid ${C.border}`,
          padding: "8px 10px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        <Btn onClick={initProject} disabled={busy}>
          Initialize project (.vean)
        </Btn>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={newRoot}
            onChange={(e) => setNewRoot(e.target.value)}
            placeholder="/path/to/media"
            style={fieldStyle}
          />
          <Btn onClick={addRoot} disabled={busy || !newRoot.trim()}>
            Add root
          </Btn>
        </div>
      </div>
    </div>
  );
}
