import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The surface-naming register (ported from Carlo). A muted mono uppercase label
 * that names a panel/section so the content below carries only its verdict.
 * font-mono · 12px · uppercase · 0.22em tracking · muted.
 */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "font-mono text-xs uppercase tracking-[0.22em] text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}
