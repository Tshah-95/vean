import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_STACK, theme } from "../lib/theme";
// Title — a centered title card: a kicker line over a big title, both springing up
// on a TRANSPARENT background (alpha preserved so it composites over footage on an
// upper MLT track, exactly like LowerThird).
//
// This is the SECOND registered composition, and it exists to prove the P0 unlock:
// it was added purely by dropping this file into `compositions/` — the viewer's
// dynamic registry (a Vite glob, `viewer/src/remotion/registry.ts`) discovers it by
// filename with NO edit to the registry. Runtime metadata lives in Title.config.ts
// so this module exports only a component and remains compatible with React Fast
// Refresh when an author edits it under the live Vite viewer.
import type { TitleProps } from "./Title.config";
import { titleDefaults } from "./Title.config";

const Title: React.FC<Partial<TitleProps>> = ({
  title = titleDefaults.title,
  kicker = titleDefaults.kicker,
  accent = titleDefaults.accent,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Rise + settle: the block springs up over the first ~20 frames.
  const rise = spring({ frame, fps, config: { damping: 20, mass: 0.7 } });
  const translateY = interpolate(rise, [0, 1], [48, 0]);

  const kickerOpacity = interpolate(frame, [2, 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const titleOpacity = interpolate(frame, [8, 22], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    // NO background — transparent so the alpha plane is preserved.
    <AbsoluteFill
      style={{ fontFamily: FONT_STACK, alignItems: "center", justifyContent: "center" }}
    >
      <div style={{ transform: `translateY(${translateY}px)`, textAlign: "center" }}>
        <div
          style={{
            opacity: kickerOpacity,
            color: accent,
            fontSize: 32,
            fontWeight: 600,
            letterSpacing: 6,
            textTransform: "uppercase",
            marginBottom: 20,
          }}
        >
          {kicker}
        </div>
        <div
          style={{
            opacity: titleOpacity,
            color: theme.title,
            fontSize: 148,
            fontWeight: 800,
            letterSpacing: -3,
            lineHeight: 1,
          }}
        >
          {title}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export default Title;
