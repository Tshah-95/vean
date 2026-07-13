import { cn } from "@/lib/utils";
// Checks panel — the ambient diagnostic set for the active timeline, listed. This
// is the content fill for the "Checks" drawer tab (vean's "type errors for video"
// surface). Read-only for now; deterministic fixes / jump-to-clip come with the
// LSP code-action wiring.
import { useEffect, useState } from "react";
import { fetchDiagnostics } from "../../api";
import { Note, PanelHead } from "./ui";

interface Diag {
  code: string;
  severity: string;
  message: string;
  location?: { clip?: string; track?: string };
  fix?: string;
}

const sevClass: Record<string, string> = {
  error: "bg-red",
  warning: "bg-amber",
  info: "bg-fg-2",
  hint: "bg-fg-3",
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
          className="flex gap-2 border-b border-border-faint px-2.5 py-[7px]"
        >
          <span
            className={cn(
              "mt-1 size-[7px] shrink-0 rounded-full",
              sevClass[d.severity] ?? "bg-fg-3",
            )}
          />
          <div data-selectable-text className="min-w-0">
            <div className="text-[11px] leading-relaxed text-foreground">{d.message}</div>
            <div className="mt-0.5 font-mono text-[10px] text-fg-3">{d.code}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
