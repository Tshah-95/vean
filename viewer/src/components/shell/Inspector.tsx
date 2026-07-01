// The right rail: Inspector (selected-clip properties) + Consequences (the
// preview-op result before commit) + the agent chat pill. PHASE 2 is a skeleton —
// the real inspector rows, live consequences, and wired chat land in Phase 3
// (DESIGN-UI.md). This establishes the zone and its visual language.
import { Sparkles } from "lucide-react";
import { Eyebrow } from "@/components/ui/eyebrow";

export function Inspector() {
  return (
    <aside className="flex w-[196px] flex-shrink-0 flex-col border-l border-sidebar-border bg-panel px-3 py-3">
      <Eyebrow>Inspector</Eyebrow>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        Select a clip to inspect its in / out, length, and dials.
      </p>

      <div className="my-3 border-t border-sidebar-border" />

      <Eyebrow>Consequences</Eyebrow>
      <p className="mt-2 text-xs text-fg-3">No pending edit.</p>

      <span className="flex-1" />

      <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs text-fg-3">
        <Sparkles size={14} strokeWidth={1.75} className="text-primary" aria-hidden />
        Ask vean to edit…
      </div>
    </aside>
  );
}
