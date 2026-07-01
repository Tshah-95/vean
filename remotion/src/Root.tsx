// The producer's composition registry. Width/height/fps MUST match the demo profile
// that vean composites onto — VERTICAL = 1080x1920 @ 30 (see src/ir/profile.ts).
// Move 5 is restricted to INTEGER-fps profiles, so fps is the literal 30 (not a
// rational); non-integer-fps Remotion is deferred to a later Move.
//
// NOTE: the viewer's LIVE registry (viewer/src/remotion/registry.ts) is now discovered
// by a glob of `compositions/`, so adding a comp there needs no viewer edit. This
// producer-side list is still explicit because each `<Composition>` needs its own
// duration/fps/dims for the BAKE path (`vean remotion render <id>`). Making this
// glob-driven too (id/dims from a per-comp `meta` export) is a small follow-up.
import { Composition } from "remotion";
import { LowerThird, lowerThirdDefaults, lowerThirdSchema } from "./compositions/LowerThird";
import Title, { defaults as titleDefaults, schema as titleSchema } from "./compositions/Title";

export const RemotionRoot: React.FC = () => (
  <>
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
    <Composition
      id="Title"
      component={Title}
      durationInFrames={90}
      fps={30}
      width={1080}
      height={1920}
      schema={titleSchema}
      defaultProps={titleDefaults}
    />
  </>
);
