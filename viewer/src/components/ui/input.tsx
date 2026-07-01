// shadcn input, on vean's tokens — the one text field for the whole app.
import type * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "flex h-7 w-full min-w-0 rounded-md border border-input bg-inset px-2 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-fg-3 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
