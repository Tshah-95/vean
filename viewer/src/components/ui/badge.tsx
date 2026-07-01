// shadcn badge, vean-shaped: quiet mono chips for the top-bar facts + statuses.
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border border-border px-1.5 py-0.5 font-mono text-[11px] leading-none",
  {
    variants: {
      tone: {
        neutral: "text-muted-foreground",
        ok: "text-track-audio",
        warn: "text-amber",
        error: "text-red",
        gold: "text-primary",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

function Badge({
  className,
  tone,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone, className }))} {...props} />;
}

export { Badge, badgeVariants };
