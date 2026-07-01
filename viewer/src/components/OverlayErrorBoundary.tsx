// Isolates a RUNTIME error thrown by a live composition. An agent-authored comp that
// throws DURING RENDER (a bad hook call, an undefined access, a bogus prop) would
// otherwise unmount the whole React tree — a white-screen crash of the entire editor,
// not just the overlay. This boundary catches it, hides the overlay (the footage
// compositor keeps rendering underneath), logs it, and exposes it on a
// `window.__veanOverlayError` bridge so a gate/agent can see WHICH comp failed and why.
//
// Scope: this catches RENDER-TIME errors only. A BUILD/import error — a syntax error in
// a comp file — is Vite's domain (the dev error overlay in dev; a hard build fail in
// prod), because the eager glob imports every comp at module load; per-comp IMPORT
// isolation is the lazy-glob follow-up (DESIGN-LIVE-COMP-PREVIEW §P1b).
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** The comp id being rendered — reported on the error bridge and used to RECOVER:
   *  switching to a different comp clears a prior comp's caught error. */
  compositionId?: string;
}

interface State {
  error: Error | null;
}

interface OverlayErrorBridge {
  compositionId: string | undefined;
  message: string;
}

export class OverlayErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `[vean] live composition "${this.props.compositionId ?? "?"}" threw during render:`,
      error,
      info.componentStack,
    );
    (window as unknown as { __veanOverlayError?: OverlayErrorBridge | null }).__veanOverlayError = {
      compositionId: this.props.compositionId,
      message: error.message,
    };
  }

  componentDidUpdate(prev: Props): void {
    // Switching to a DIFFERENT comp gets a fresh render attempt — clear a prior comp's
    // caught error so moving the playhead away from a broken overlay recovers the layer.
    if (prev.compositionId !== this.props.compositionId && this.state.error) {
      this.setState({ error: null });
      (window as unknown as { __veanOverlayError?: OverlayErrorBridge | null }).__veanOverlayError =
        null;
    }
  }

  render(): ReactNode {
    // Hidden on error — the footage still shows; the failure is logged + on the bridge.
    if (this.state.error) return null;
    return this.props.children;
  }
}
