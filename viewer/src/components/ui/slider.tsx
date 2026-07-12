import { cn } from "@/lib/utils";
// shadcn slider (Radix), on vean's tokens — gold range on a quiet track.
import * as SliderPrimitive from "@radix-ui/react-slider";
import type * as React from "react";

function Slider({
  className,
  "aria-label": ariaLabel,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      className={cn(
        "relative flex w-full touch-none select-none items-center data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className,
      )}
      {...props}
    >
      <SliderPrimitive.Track className="relative h-[3px] w-full grow overflow-hidden rounded-full bg-hover data-[orientation=vertical]:h-full data-[orientation=vertical]:w-[3px]">
        <SliderPrimitive.Range className="absolute h-full bg-primary data-[orientation=vertical]:w-full" />
      </SliderPrimitive.Track>
      {/* The accessible name belongs on the THUMB — Radix gives it role="slider". */}
      <SliderPrimitive.Thumb
        aria-label={ariaLabel}
        className="block size-3 rounded-full bg-primary outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      />
    </SliderPrimitive.Root>
  );
}

export { Slider };
