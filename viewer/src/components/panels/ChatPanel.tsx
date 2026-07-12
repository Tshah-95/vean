// Chat panel — the agent console, as a drawer tab. The agent and the human drive
// the SAME edit algebra (apply-op / undo / render), so this is a first-class
// destination, not a bolt-on. PHASE 2R is a placeholder shell (thread + composer);
// wiring it to the edit bridge + streaming is Phase 4.
import { Sparkles } from "lucide-react";

export function ChatPanel() {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Ask vean to edit — tighten a cut, fix a diagnostic, place a clip, render a still. The
          agent drives the same ops you do, so everything is undoable and shows its consequences
          first.
        </p>
      </div>
      <div className="flex-shrink-0 border-t border-sidebar-border p-2">
        <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-xs text-fg-3">
          <Sparkles size={14} strokeWidth={1.75} className="text-primary" aria-hidden />
          Ask, or type @ to reference media…
        </div>
      </div>
    </div>
  );
}
