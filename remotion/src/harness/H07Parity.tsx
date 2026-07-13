import { AbsoluteFill, Sequence } from "remotion";
import { LowerThird, type LowerThirdProps } from "../compositions/LowerThird";

/**
 * Full-frame H07 reference composition. This is deliberately rendered by
 * Remotion itself: the export oracle compares it with Vean's independent path
 * (LowerThird alpha ProRes -> upper MLT track -> final melt frame). It must not
 * be used as the MLT input or the two engines would no longer be independent.
 */
export const H07Parity: React.FC<LowerThirdProps> = (props) => (
  <AbsoluteFill style={{ backgroundColor: "#241a52" }}>
    <Sequence from={30} durationInFrames={90}>
      <LowerThird {...props} />
    </Sequence>
  </AbsoluteFill>
);

export default H07Parity;
