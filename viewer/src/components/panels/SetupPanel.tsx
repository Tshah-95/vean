import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
// Guided setup panel — the in-app half of the setup flow. Runs `setup.doctor`
// (probe-skipped for speed) over the action bridge and shows pass/warn/fail, with
// quick-fix actions (initialize project, add a media root). Detection + fixes both
// route through the same actions the CLI `vean doctor` / `project init` /
// `media root add` call — no duplicated logic.
import { useCallback, useEffect, useState } from "react";
import { runAction } from "../../api";
import { Note, PanelHead } from "./ui";

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}
interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

const statusClass: Record<string, string> = {
  pass: "bg-track-audio",
  warn: "bg-amber",
  fail: "bg-red",
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
    <div className="flex h-full flex-col">
      <PanelHead title={report ? `Setup · ${report.ok ? "ready" : "needs attention"}` : "Setup"}>
        <Button size="sm" variant="outline" onClick={() => void check()} disabled={busy}>
          {busy ? "Checking…" : "Re-check"}
        </Button>
      </PanelHead>
      {err && <Note kind="error">{err}</Note>}
      {msg && <Note kind="dim">{msg}</Note>}
      <div className="flex-1 overflow-auto">
        {!report && !err && <Note kind="dim">Running setup checks…</Note>}
        {report?.checks.map((c) => (
          <div
            key={c.name}
            className="flex gap-2 border-b border-border-faint px-2.5 py-[5px] text-[11px]"
          >
            <span
              className={cn(
                "mt-[3px] size-2 shrink-0 rounded-full",
                statusClass[c.status] ?? "bg-fg-3",
              )}
            />
            <div data-selectable-text className="min-w-0">
              <div className="text-foreground">{c.name}</div>
              <div className="truncate font-mono text-fg-3" title={c.detail}>
                {c.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2 border-t border-border px-2.5 py-2">
        <Button size="sm" variant="outline" onClick={initProject} disabled={busy}>
          Initialize project (.vean)
        </Button>
        <div className="flex gap-1.5">
          <Input
            aria-label="Setup media root path"
            value={newRoot}
            onChange={(e) => setNewRoot(e.target.value)}
            placeholder="/path/to/media"
          />
          <Button size="sm" variant="outline" onClick={addRoot} disabled={busy || !newRoot.trim()}>
            Add root
          </Button>
        </div>
      </div>
    </div>
  );
}
