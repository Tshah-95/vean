// Unit tests for the Remotion driver's PURE pieces — the exact argv it builds and
// the binary resolution rules. No real Remotion/ffprobe subprocess runs here
// (frame rendering is verified only by the real gate, per AGENTS.md); we assert
// the command string the spike proved is reproduced byte-for-byte, since the
// flags are load-bearing (especially --image-format=png, without which alpha is
// silently lost).
import { describe, expect, it } from "vitest";
import { buildRenderArgs, defaultRemotionEntry, resolveRemotionBin } from "../src/driver/remotion";

describe("remotion driver argv construction", () => {
  it("builds the exact proven alpha-render argv (all flags load-bearing)", () => {
    const args = buildRenderArgs("/repo/remotion/src/index.ts", "LowerThird", "/out/lt.mov");
    expect(args).toEqual([
      "render",
      "/repo/remotion/src/index.ts",
      "LowerThird",
      "/out/lt.mov",
      "--codec=prores",
      "--prores-profile=4444",
      // REQUIRED for alpha — never drop this.
      "--image-format=png",
      "--pixel-format=yuva444p10le",
    ]);
  });

  it("appends --props only when props are non-empty, as JSON", () => {
    const none = buildRenderArgs("/e.ts", "C", "/o.mov", { props: {} });
    expect(none.some((a) => a.startsWith("--props"))).toBe(false);

    const some = buildRenderArgs("/e.ts", "C", "/o.mov", {
      props: { title: "vean", n: 3 },
    });
    const propsArg = some.find((a) => a.startsWith("--props="));
    expect(propsArg).toBeDefined();
    expect(JSON.parse((propsArg as string).slice("--props=".length))).toEqual({
      title: "vean",
      n: 3,
    });
  });

  it("appends --frames=START-END only when a frame range is given", () => {
    expect(buildRenderArgs("/e.ts", "C", "/o.mov").some((a) => a.startsWith("--frames"))).toBe(
      false,
    );
    const ranged = buildRenderArgs("/e.ts", "C", "/o.mov", { frameRange: [0, 89] });
    expect(ranged).toContain("--frames=0-89");
  });

  it("orders the structural flags before --props/--frames", () => {
    const args = buildRenderArgs("/e.ts", "C", "/o.mov", {
      props: { a: 1 },
      frameRange: [10, 20],
    });
    expect(args.indexOf("--image-format=png")).toBeLessThan(
      args.findIndex((a) => a.startsWith("--props=")),
    );
    expect(args.findIndex((a) => a.startsWith("--props="))).toBeLessThan(
      args.indexOf("--frames=10-20"),
    );
  });

  it("resolves the entry path inside the repo's remotion workspace", () => {
    const entry = defaultRemotionEntry();
    expect(entry.endsWith("/remotion/src/index.ts")).toBe(true);
  });

  it("honors an explicit bin override and VEAN_REMOTION_BIN", () => {
    expect(resolveRemotionBin("/custom/remotion")).toBe("/custom/remotion");
    const prev = process.env.VEAN_REMOTION_BIN;
    process.env.VEAN_REMOTION_BIN = "/env/remotion";
    try {
      expect(resolveRemotionBin()).toBe("/env/remotion");
    } finally {
      if (prev === undefined) Reflect.deleteProperty(process.env, "VEAN_REMOTION_BIN");
      else process.env.VEAN_REMOTION_BIN = prev;
    }
  });
});
