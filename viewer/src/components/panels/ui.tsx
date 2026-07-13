import { cn } from "@/lib/utils";
// Shared PANEL vocabulary — thin, token-based compositions over the shadcn
// primitives (ui/*). No local palette: every color comes from the token layer.
// Controls come from ui/button + ui/input; this file only holds the few panel
// idioms (header row, note, dense list row, section eyebrow).
import type { ReactNode } from "react";

/** Panel header: the title + right-aligned actions on a hairline. */
export function PanelHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
      <span className="text-xs font-medium text-foreground">{title}</span>
      <div className="ml-auto flex gap-1.5">{children}</div>
    </div>
  );
}

/** Inline note: an error (mono, destructive) or a dim hint. */
export function Note({ kind, children }: { kind: "error" | "dim"; children: ReactNode }) {
  return (
    <div
      data-selectable-text={kind === "error" ? "" : undefined}
      className={cn(
        "whitespace-pre-wrap break-words px-2.5 py-2 text-[11px]",
        kind === "error" ? "font-mono text-red" : "text-fg-3",
      )}
    >
      {children}
    </div>
  );
}

/** Dense list-row classes (alternating rows, light-up hover). Compose with cn(). */
export const rowClass = (i: number) =>
  cn(
    "flex items-center gap-2 border-b border-border-faint px-2.5 py-[5px] text-[11px] text-foreground transition-[filter] hover:brightness-125",
    i % 2 ? "bg-inset/60" : "bg-transparent",
  );

/** Mono uppercase section eyebrow inside a panel body. */
export function SectionEyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-2.5 pb-0.5 pt-2 font-mono text-[10px] uppercase tracking-[0.14em] text-fg-3">
      {children}
    </div>
  );
}
