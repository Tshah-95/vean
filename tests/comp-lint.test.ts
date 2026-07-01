// P5 (live-comp-preview) — unit test for the pure comp-authoring lint core
// (`scripts/comp-lint.ts` `lintCompSource`). The rules catch mistakes that break in the
// vean live/bake seam: audio inside a video-only overlay comp, and a `delayRender()`
// without a preview-side `useBufferState().delayPlayback()` (a real preview↔export
// divergence). The file walk itself is proven by `bun run lint:comps` over the real comps.
import { describe, expect, it } from "vitest";
import { lintCompSource } from "../scripts/comp-lint";

const clean = `
import { AbsoluteFill, useCurrentFrame } from "remotion";
export const defaults = { title: "hi" };
const Comp = () => { const f = useCurrentFrame(); return <AbsoluteFill>{f}</AbsoluteFill>; };
export default Comp;`;

describe("comp-lint", () => {
  it("passes a clean overlay comp", () => {
    expect(lintCompSource("Clean", clean)).toEqual([]);
  });

  it("flags an <Audio> tag (overlay comps are video-only)", () => {
    const src = `import { Audio } from "remotion"; const C = () => <Audio src="x.mp3" />; export default C;`;
    const finds = lintCompSource("Noisy", src);
    expect(finds).toHaveLength(1);
    expect(finds[0]?.rule).toBe("overlay-audio");
  });

  it("flags a sound-bearing <Video>/<OffthreadVideo> that isn't muted", () => {
    const src = `import { OffthreadVideo } from "remotion"; const C = () => <OffthreadVideo src="x.mp4" />; export default C;`;
    expect(lintCompSource("Vid", src).map((f) => f.rule)).toContain("overlay-audio");
  });

  it("is SILENT on a muted <Video> (audio opted out)", () => {
    const src = `import { OffthreadVideo } from "remotion"; const C = () => <OffthreadVideo src="x.mp4" muted />; export default C;`;
    expect(lintCompSource("MutedVid", src)).toEqual([]);
  });

  it("flags delayRender() without a paired useBufferState()", () => {
    const src = `import { delayRender } from "remotion"; const h = delayRender(); export default () => null;`;
    const finds = lintCompSource("Delay", src);
    expect(finds).toHaveLength(1);
    expect(finds[0]?.rule).toBe("delay-render-without-buffer");
  });

  it("is SILENT on delayRender() paired with useBufferState()", () => {
    const src = `import { delayRender, useBufferState } from "remotion"; const b = useBufferState(); const h = delayRender(); export default () => null;`;
    expect(lintCompSource("Paired", src)).toEqual([]);
  });

  it("ignores signals inside comments (commented-out example code)", () => {
    const src = `// example: <Audio src="x" />\n/* const h = delayRender(); */\nexport default () => null;`;
    expect(lintCompSource("Commented", src)).toEqual([]);
  });
});
