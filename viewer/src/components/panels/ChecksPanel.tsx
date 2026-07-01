// Checks panel — the ambient diagnostic set for the active timeline, listed. This
// is the content-rail fill for the "Checks" destination (vean's "type errors for
// video" surface). Read-only for now; deterministic fixes / jump-to-clip come with
// the LSP code-action wiring. Inline-styled to match sibling panels (Phase 4
// tokenizes them together).
import { useEffect, useState } from "react";
import { fetchDiagnostics } from "../../api";
import { C, mono, Note, PanelHead } from "./ui";

interface Diag {
  code: string;
  severity: string;
  message: string;
  location?: { clip?: string; track?: string };
  fix?: string;
}

const sevColor: Record<string, string> = {
  error: C.danger,
  warning: "#e2c275",
  info: C.muted,
  hint: C.dim,
};

export function ChecksPanel({ route }: { route?: string }) {
  const [items, setItems] = useState<Diag[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    fetchDiagnostics(route)
      .then((res) => {
        if (cancelled) return;
        setItems((res.diagnostics as Diag[]) ?? []);
        setLoaded(true);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [route]);

  return (
    <div>
      <PanelHead title="Checks" />
      {err ? <Note kind="error">{err}</Note> : null}
      {!err && loaded && items.length === 0 ? (
        <Note kind="dim">No diagnostics — the timeline is clean.</Note>
      ) : null}
      {items.map((d, i) => (
        <div
          key={`${d.code}-${i}`}
          style={{
            display: "flex",
            gap: 8,
            padding: "7px 10px",
            borderBottom: `1px solid ${C.border}22`,
          }}
        >
          <span
            style={{
              marginTop: 4,
              flexShrink: 0,
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: sevColor[d.severity] ?? C.dim,
            }}
          />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: C.text, lineHeight: 1.45 }}>{d.message}</div>
            <div style={{ fontSize: 10, color: C.dim, fontFamily: mono, marginTop: 2 }}>{d.code}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
