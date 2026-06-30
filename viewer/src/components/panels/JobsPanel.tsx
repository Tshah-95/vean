// Jobs / activity panel — local job queue from .vean/vean.db over `jobs.list`.
import { useCallback, useEffect, useState } from "react";
import { runAction } from "../../api";
import { Btn, C, Note, PanelHead, mono, rowStyle } from "./ui";

interface Job {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  error: string | null;
}

const statusColor: Record<string, string> = {
  queued: "#9aa0ae",
  running: "#7c8cff",
  done: "#5ec98a",
  failed: "#e0857f",
};

export function JobsPanel({ project }: { project?: string }) {
  const [rows, setRows] = useState<Job[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const out = await runAction<Job[]>("jobs.list", {}, project);
      setRows(Array.isArray(out) ? out : []);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PanelHead title={`Jobs${rows.length ? ` · ${rows.length}` : ""}`}>
        <Btn onClick={() => void load()} disabled={busy}>
          Refresh
        </Btn>
      </PanelHead>
      {err && <Note kind="error">{err}</Note>}
      <div style={{ flex: 1, overflow: "auto" }}>
        {rows.length === 0 && !busy && !err && <Note kind="dim">No jobs recorded.</Note>}
        {rows.map((j, i) => (
          <div key={j.id} style={rowStyle(i)} title={j.error ?? j.id}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 8,
                background: statusColor[j.status] ?? C.dim,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                flex: 1,
                fontFamily: mono,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {j.kind}
            </span>
            <span style={{ color: C.dim, flexShrink: 0 }}>
              {j.status}
              {j.attempts > 0 ? ` · ${j.attempts}/${j.maxAttempts}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
