// Rendered by the `@remotion/player`'s `errorFallback` prop when a live composition
// throws DURING RENDER (a bad hook call, an undefined access, a bogus prop — a plausible
// agent mistake). The Player has its OWN internal error boundary that catches the throw
// before it can reach any outer React boundary, so fault isolation MUST hook the Player's
// error surface here, not wrap it.
//
// Instead of Remotion's default ⚠️ glyph composited over the footage, we render NOTHING
// (the overlay is hidden; the footage compositor keeps rendering underneath) and publish
// the failure on `window.__veanOverlayError` (which comp, why) so a gate/agent can see it.
// Switching to a different comp remounts the Player fresh (the `key` in OverlayPlayer),
// which unmounts this fallback → the cleanup clears the bridge → the layer recovers.
import { useEffect } from "react";

interface Props {
  error: Error;
  /** The comp id that failed — published on the bridge so the failure is attributable. */
  compositionId: string;
}

interface OverlayErrorBridge {
  compositionId: string;
  message: string;
}

export function OverlayErrorFallback({ error, compositionId }: Props) {
  useEffect(() => {
    console.error(`[vean] live composition "${compositionId}" threw during render:`, error);
    (window as unknown as { __veanOverlayError?: OverlayErrorBridge | null }).__veanOverlayError = {
      compositionId,
      message: error.message,
    };
    return () => {
      (window as unknown as { __veanOverlayError?: OverlayErrorBridge | null }).__veanOverlayError =
        null;
    };
  }, [error, compositionId]);
  // Hidden — the footage still shows; the failure is logged + on the bridge.
  return null;
}
