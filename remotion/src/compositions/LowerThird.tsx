import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
// LowerThird — the real demo composition. A dark bar anchored in the lower third
// with an accent left border, a title and a subtitle. The bar springs in from
// the left; the text fades up.
//
// LOAD-BEARING: the root <AbsoluteFill> has NO background fill. A transparent
// background is what lets the ProRes 4444 render carry a real alpha plane, so
// the clip composites over footage on an upper MLT track. If you add a
// background color here, the overlay becomes opaque and the qtblend composite
// shows only the graphic — the footage underneath disappears.
import { z } from "zod";
import { FONT_STACK, theme } from "../lib/theme";

// Remotion bundles its own zod — import it from "zod" INSIDE this workspace
// (never vean's zod). This schema validates props at render time and powers the
// Remotion Studio controls.
export const lowerThirdSchema = z.object({
  title: z.string(),
  subtitle: z.string(),
  /** Accent stripe + glow color (hex). */
  accent: z.string(),
  /** Bar background color (hex; include alpha for translucency, e.g. #11131aee). */
  barColor: z.string(),
});

export type LowerThirdProps = z.infer<typeof lowerThirdSchema>;

export const lowerThirdDefaults: LowerThirdProps = {
  title: "vean",
  subtitle: "video editor, agent native",
  accent: theme.accent,
  barColor: theme.bar,
};

export const LowerThird: React.FC<LowerThirdProps> = ({ title, subtitle, accent, barColor }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();

  // Spring slide-in: the bar enters from the left over the first ~20 frames.
  const slide = spring({ frame, fps, config: { damping: 18, mass: 0.6 } });
  const translateX = interpolate(slide, [0, 1], [-width * 0.6, 0]);

  // Text fades up slightly after the bar lands.
  const titleOpacity = interpolate(frame, [6, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const subtitleOpacity = interpolate(frame, [12, 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    // NO background — transparent so alpha is preserved.
    <AbsoluteFill style={{ fontFamily: FONT_STACK }}>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          // Lower-third anchor: ~68% down the frame.
          top: "68%",
          transform: `translateX(${translateX}px)`,
          display: "flex",
          alignItems: "stretch",
          paddingLeft: 64,
          paddingRight: 64,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            background: barColor,
            borderRadius: 12,
            overflow: "hidden",
            boxShadow: `0 8px 40px ${accent}33`,
          }}
        >
          {/* Accent left border. */}
          <div style={{ width: 10, background: accent }} />
          <div style={{ padding: "28px 40px 32px 32px" }}>
            <div
              style={{
                opacity: titleOpacity,
                color: theme.title,
                fontSize: 76,
                fontWeight: 800,
                letterSpacing: -1,
                lineHeight: 1,
              }}
            >
              {title}
            </div>
            <div
              style={{
                opacity: subtitleOpacity,
                color: theme.subtitle,
                fontSize: 34,
                fontWeight: 500,
                marginTop: 14,
              }}
            >
              {subtitle}
            </div>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

// Default export = the composition component (the going-forward registry convention;
// the named `LowerThird` export stays for the producer `Root.tsx`). The viewer's glob
// registry resolves `default` first, so this is the live-preview entry point.
export default LowerThird;
