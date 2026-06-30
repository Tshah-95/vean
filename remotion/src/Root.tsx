// The composition registry. Width/height/fps MUST match the demo profile that
// vean composites onto — VERTICAL = 1080x1920 @ 30 (see src/ir/profile.ts).
// Move 5 is restricted to INTEGER-fps profiles, so fps is the literal 30 (not a
// rational); non-integer-fps Remotion is deferred to a later Move with an
// explicit fps-mismatch diagnostic.
import { Composition } from "remotion";
import { LowerThird, lowerThirdDefaults, lowerThirdSchema } from "./compositions/LowerThird";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="LowerThird"
    component={LowerThird}
    durationInFrames={90}
    fps={30}
    width={1080}
    height={1920}
    schema={lowerThirdSchema}
    defaultProps={lowerThirdDefaults}
  />
);
