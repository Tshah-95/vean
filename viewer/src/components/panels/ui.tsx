// Shared visual primitives for the product-panel sidebar. Inline-styled to match
// the viewer's existing convention; one palette + a few atoms keep the panels terse.
import type { CSSProperties, ReactNode } from "react";

export const C = {
  panel: "#17171a",
  field: "#0f0f12",
  border: "#2a2a30",
  text: "#e8e8ea",
  muted: "#9aa0ae",
  dim: "#6b7280",
  accent: "#7c8cff",
  danger: "#e0857f",
  rowAlt: "#1d1d22",
} as const;

export const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

export const fieldStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: C.field,
  color: C.text,
  border: `1px solid ${C.border}`,
  borderRadius: 6,
  padding: "4px 8px",
  fontSize: 11,
  fontFamily: mono,
};

export function PanelHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "8px 10px",
        borderBottom: `1px solid ${C.border}`,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 650, color: C.text }}>{title}</span>
      <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>{children}</div>
    </div>
  );
}

export function Btn({
  onClick,
  children,
  disabled,
  title,
}: {
  onClick?: () => void;
  children: ReactNode;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type={onClick ? "button" : "submit"}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background: "#26262c",
        color: C.text,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: "3px 9px",
        fontSize: 11,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function Note({ kind, children }: { kind: "error" | "dim"; children: ReactNode }) {
  return (
    <div
      style={{
        padding: "8px 10px",
        fontSize: 11,
        color: kind === "error" ? C.danger : C.dim,
        fontFamily: kind === "error" ? mono : undefined,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {children}
    </div>
  );
}

export const rowStyle = (i: number): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "5px 10px",
  fontSize: 11,
  color: C.text,
  background: i % 2 ? C.rowAlt : "transparent",
  borderBottom: `1px solid ${C.border}22`,
});
