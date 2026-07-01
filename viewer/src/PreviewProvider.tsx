// The DRAG-PREVIEW store + React binding — the shared channel between the timeline
// strip (the WRITER: it pushes a `PreviewOverride` on every drag move and clears it
// when the gesture commits/aborts) and the footage stage (the READER: it composites
// the override's frame instead of the live playhead while one is set).
//
// A tiny external store (same shape as the MasterClock) rather than lifted React
// state, so a drag moving many times per second recomposites the canvas WITHOUT
// re-rendering the whole editor subtree each move — only the footage stage, which
// already re-renders per frame. The strip writes imperatively; the stage subscribes
// via useSyncExternalStore.
import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { PreviewOverride } from "./dragPreview";

type Listener = () => void;

/** Holds the current transient compositor override (or null when no drag is live).
 *  One writer (the strip), one reader (the footage stage). */
export class PreviewStore {
  private state: PreviewOverride | null = null;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PreviewOverride | null => this.state;

  /** Set (or replace) the live override, notifying the footage stage to recomposite
   *  the previewed frame. A fresh object each drag move → a new snapshot identity. */
  set = (override: PreviewOverride | null): void => {
    this.state = override;
    for (const l of this.listeners) l();
  };

  /** Clear the override — the footage stage returns to the live playhead frame. */
  clear = (): void => this.set(null);
}

const PreviewContext = createContext<PreviewStore | null>(null);

// A module-level fallback so the hooks never throw when a component mounts outside a
// provider (e.g. an isolated test harness); a real app wraps <PreviewProvider> so
// the strip and the stage share the same instance.
const fallbackStore = new PreviewStore();

export function PreviewProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => new PreviewStore(), []);
  return <PreviewContext.Provider value={store}>{children}</PreviewContext.Provider>;
}

/** The shared store instance (stable; for the strip's imperative set/clear). */
export function usePreviewInstance(): PreviewStore {
  return useContext(PreviewContext) ?? fallbackStore;
}

/** The reactive override — re-renders the caller when a drag sets/clears it. */
export function usePreview(): PreviewOverride | null {
  const store = usePreviewInstance();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
