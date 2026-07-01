// Title — a centered title card: a kicker line over a big title, both springing up
// on a TRANSPARENT background (alpha preserved so it composites over footage on an
// upper MLT track, exactly like LowerThird).
//
// This is the SECOND registered composition, and it exists to prove the P0 unlock:
// it was added purely by dropping this file into `compositions/` — the viewer's
// dynamic registry (a Vite glob, `viewer/src/remotion/registry.ts`) discovers it by
// filename with NO edit to the registry. It follows the going-forward convention:
// a `default` export (the component) + a named `defaults` export (the default props).
import { z } from "zod";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { FONT_STACK, theme } from "../lib/theme";

export const schema = z.object({
  title: z.string(),
  /** Small kicker line above the title (rendered uppercase, letter-spaced). */
  kicker: z.string(),
  /** Accent color for the kicker (hex). */
  accent: z.string(),
});

export type TitleProps = z.infer<typeof schema>;

export const defaults: TitleProps = {
  title: "vean",
  kicker: "the agent-native title card",
  accent: theme.accent,
};

const Title: React.FC<TitleProps> = ({ title, kicker, accent }) => {
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
