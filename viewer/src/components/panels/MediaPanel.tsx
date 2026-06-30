// Media browser panel — the project's media catalog over the action runtime.
// list / find / scan / add-root all route through `runAction` (the same actions
// the CLI `vean media …` commands call), so this panel owns no domain logic.
import { useCallback, useEffect, useState } from "react";
import { runAction } from "../../api";
import { Btn, C, Note, PanelHead, fieldStyle, mono, rowStyle } from "./ui";

interface MediaAsset {
  id: string;
  path: string;
  relativePath: string;
  kind: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
}

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

const kindColor: Record<string, string> = {
  video: "#7c8cff",
  audio: "#5ec98a",
  image: "#e0b15e",
  unknown: "#6b7280",
};

export function MediaPanel({ project }: { project?: string }) {
  const [rows, setRows] = useState<MediaAsset[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newRoot, setNewRoot] = useState("");

  const load = useCallback(
    async (q: string) => {
      setBusy(true);
      setErr(null);
      try {
        const out = q.trim()
          ? await runAction<MediaAsset[]>("media.find", { query: q.trim() }, project)
          : await runAction<MediaAsset[]>("media.list", {}, project);
        setRows(Array.isArray(out) ? out : []);
      } catch (e) {
        setErr(String((e as Error)?.message ?? e));
      } finally {
        setBusy(false);
      }
    },
    [project],
  );

  useEffect(() => {
    void load("");
  }, [load]);

  const scan = async () => {
    setBusy(true);
    setErr(null);
    try {
      await runAction("media.scan", {}, project);
      await load(query);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };

  const addRoot = async () => {
    if (!newRoot.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await runAction("media.root.add", { path: newRoot.trim() }, project);
      setNewRoot("");
      await load("");
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PanelHead title={`Media${rows.length ? ` · ${rows.length}` : ""}`}>
        <Btn onClick={scan} disabled={busy} title="Rescan media roots">
          Scan
        </Btn>
      </PanelHead>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void load(query);
        }}
        style={{ padding: "8px 10px", display: "flex", gap: 6, borderBottom: `1px solid ${C.border}` }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find media…"
          style={fieldStyle}
        />
        <Btn disabled={busy}>Find</Btn>
      </form>
      {err && <Note kind="error">{err}</Note>}
      <div style={{ flex: 1, overflow: "auto" }}>
        {rows.length === 0 && !busy && !err && (
          <Note kind="dim">No media. Add a root below, then Scan.</Note>
        )}
        {rows.map((m, i) => (
          <div key={m.id} style={rowStyle(i)} title={m.path}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: kindColor[m.kind] ?? kindColor.unknown,
                flexShrink: 0,
              }}
            />
            <span
              style={{
                flex: 1,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: mono,
              }}
            >
              {m.relativePath || m.path}
            </span>
            <span style={{ color: C.dim, flexShrink: 0 }}>{fmtBytes(m.sizeBytes)}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: "8px 10px", display: "flex", gap: 6, borderTop: `1px solid ${C.border}` }}>
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
  );
}
