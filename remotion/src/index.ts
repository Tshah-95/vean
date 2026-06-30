// The Remotion entry point — registers the composition root. vean drives
// `remotion render src/index.ts <CompositionId> <out.mov> ...` against THIS file
// as an arm's-length subprocess (the same pattern as driving `melt`), so this
// module never imports anything from vean's core.
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);
