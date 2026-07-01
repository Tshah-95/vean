// A fault-isolation TEST composition: its render THROWS when the `boom` prop is set, so
// `verify:live-error` can prove a runtime-throwing comp degrades gracefully (the overlay
// is HIDDEN and `window.__veanOverlayError` is populated) instead of Remotion's ⚠️ glyph
// over the footage — or a white-screen crash of the whole editor. Harmless by default
// (boom:false → renders nothing). Discovered by the viewer glob; intentionally NOT
// registered in `remotion/src/Root.tsx` (it is a viewer-side test comp, never baked).
import { AbsoluteFill } from "remotion";

export const defaults = { boom: false };

const BoomProbe: React.FC<{ boom?: boolean }> = ({ boom }) => {
  if (boom) throw new Error("BoomProbe: deliberate render failure (fault-isolation test)");
  return <AbsoluteFill />;
};

export default BoomProbe;
