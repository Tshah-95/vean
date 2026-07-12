// React binding for the MasterClock: a context holding the singleton clock plus
// a `useClock()` hook that subscribes via useSyncExternalStore so any component
// re-renders on a frame change. The clock instance itself is stable across
// renders (one master playhead per mounted viewer).
import { createContext, useContext, useMemo, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { type ClockState, MasterClock } from "./clock";

const ClockContext = createContext<MasterClock | null>(null);

export function ClockProvider({ children }: { children: ReactNode }) {
  const clock = useMemo(() => new MasterClock(), []);
  return <ClockContext.Provider value={clock}>{children}</ClockContext.Provider>;
}

/** The singleton clock instance (stable; for imperative calls like seekTo). */
export function useClockInstance(): MasterClock {
  const clock = useContext(ClockContext);
  if (!clock) throw new Error("useClockInstance must be used within a ClockProvider");
  return clock;
}

/** The reactive clock state — re-renders the caller on every frame change. */
export function useClock(): ClockState {
  const clock = useClockInstance();
  return useSyncExternalStore(clock.subscribe, clock.getSnapshot, clock.getSnapshot);
}
