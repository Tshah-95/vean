// Golden round-trip for the Remotion-overlay identity (`Clip.composition`). The
// composition id + render props are the load-bearing handle that makes a baked
// alpha .mov a first-class, recognizable overlay clip, so the IR ⇄ .mlt boundary
// must carry them losslessly and deterministically. We lock: (a) serialize emits
// the `vean:composition` / `vean:compositionProps` producer properties, (b) parse
// reads them straight back, (c) parse(serialize(ir)) preserves `composition`, and
// (d) serialize is a fixpoint (byte-identical on re-emit). A clip WITHOUT
// composition must emit NO `vean:` property and round-trip unchanged (regression).
import { describe, expect, it } from "vitest";
import {
  type Timeline,
  VERTICAL,
  clip,
  fromMlt,
  resetIds,
  timeline,
  toMlt,
  videoTrack,
} from "../src/index";

// An overlay timeline rebuilt from scratch each call (resetIds) so id assignment
// is a pure function of the IR — the determinism contract.
function overlayFixture(): Timeline {
  resetIds();
  return timeline(VERTICAL, {
    video: [
      videoTrack(
        clip("cache/remotion/chat-retire.mov", {
          id: "overlay-chat",
          dur: 90,
          composition: { id: "ChatRetire", props: { variant: "hero" } },
        }),
      ),
    ],
  });
}

// The first clip on the first video track (the overlay).
function firstClip(tl: Timeline) {
  return tl.tracks.video[0]?.items[0] as {
    kind: string;
    composition?: { id: string; props?: Record<string, unknown> };
  };
}

describe("Clip.composition round-trip (Remotion overlay identity)", () => {
  it("serialize emits the vean:composition + vean:compositionProps properties", () => {
    const xml = toMlt(overlayFixture());
    expect(xml).toContain('<property name="vean:composition">ChatRetire</property>');
    // The JSON quotes are XML-entity-escaped in text content (and the parser
    // un-escapes them before JSON.parse — proven by the parse-back tests below).
    expect(xml).toContain(
      '<property name="vean:compositionProps">{&quot;variant&quot;:&quot;hero&quot;}</property>',
    );
    // Emitted immediately after shotcut:uuid (the deterministic structural slot).
    expect(xml).toMatch(
      /<property name="shotcut:uuid">[^<]*<\/property>\s*<property name="vean:composition">ChatRetire<\/property>/,
    );
  });

  it("parse reads the composition back equal to the authored value", () => {
    const after = fromMlt(toMlt(overlayFixture()));
    expect(firstClip(after).composition).toEqual({ id: "ChatRetire", props: { variant: "hero" } });
  });

  it("parse(serialize(ir)) preserves composition; serialize is a byte-identical fixpoint", () => {
    const ir = overlayFixture();
    const xml = toMlt(ir);
    const reparsed = fromMlt(xml);
    expect(firstClip(reparsed).composition).toEqual({
      id: "ChatRetire",
      props: { variant: "hero" },
    });
    // Determinism: re-serializing the parsed IR yields byte-identical XML.
    expect(toMlt(reparsed)).toBe(xml);
  });

  it("an overlay with no props emits vean:composition but NO vean:compositionProps", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("cache/remotion/bare.mov", {
            id: "overlay-bare",
            dur: 30,
            composition: { id: "Bare" },
          }),
        ),
      ],
    });
    const xml = toMlt(tl);
    expect(xml).toContain('<property name="vean:composition">Bare</property>');
    expect(xml).not.toContain("vean:compositionProps");
    // And it round-trips with no spurious `props` key.
    const after = fromMlt(xml);
    expect(firstClip(after).composition).toEqual({ id: "Bare" });
  });

  it("a clip WITHOUT composition emits no vean: property and round-trips unchanged", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/plain.mp4", { id: "plain", dur: 60 }))],
    });
    const xml = toMlt(tl);
    expect(xml).not.toContain("vean:composition");
    const after = fromMlt(xml);
    expect(firstClip(after).composition).toBeUndefined();
    // Byte-identical fixpoint — no regression to the non-overlay producer shape.
    expect(toMlt(after)).toBe(xml);
  });
});
