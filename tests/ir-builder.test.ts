import { describe, expect, it } from "vitest";
import {
  FADE_IN_SERVICE,
  FADE_OUT_SERVICE,
  VERTICAL,
  audioTrack,
  blank,
  clip,
  colorClip,
  dissolve,
  filter,
  mltColor,
  resetIds,
  timeline,
  timelineSchema,
  transition,
  videoTrack,
} from "../src/index";

// The IR builder + schemas ARE implemented (only serialize/parse/keyframes/driver
// are stubs), so they're fully testable here — no melt, no XML. These guard the
// authoring surface the parallel build agents will serialize, and the
// determinism contract (same authoring → byte-identical IR) the golden
// serializer test will extend once toMlt lands.

describe("mltColor (no brand coupling)", () => {
  it("converts #RRGGBB to opaque MLT #AARRGGBB", () => {
    expect(mltColor("#0F1A16")).toBe("#FF0F1A16");
  });
  it("accepts a known CSS name", () => {
    expect(mltColor("gold")).toBe("#FFFFD700");
    expect(mltColor("black")).toBe("#FF000000");
  });
  it("passes an existing #AARRGGBB through (upper-cased)", () => {
    expect(mltColor("#80ffffff")).toBe("#80FFFFFF");
  });
  it("rejects an unknown name", () => {
    expect(() => mltColor("chartreuse")).toThrow();
  });
});

describe("clip windows", () => {
  it("resolves dur → inclusive out (playtime = out-in+1)", () => {
    resetIds();
    const c = clip("/a.mp4", { dur: 90 });
    expect(c.in).toBe(0);
    expect(c.out).toBe(89);
    expect(c.out - c.in + 1).toBe(90);
  });
  it("honors an explicit in/out window", () => {
    const c = clip("/a.mp4", { in: 20, out: 74 });
    expect(c.in).toBe(20);
    expect(c.out).toBe(74);
  });
  it("rejects out < in", () => {
    expect(() => clip("/a.mp4", { in: 10, out: 5 })).toThrow(/>= in/);
  });
  it("requires a dur or out", () => {
    expect(() => clip("/a.mp4")).toThrow(/dur/);
  });
});

describe("colorClip", () => {
  it("is a 0-based color producer with a separate length", () => {
    const c = colorClip(30, "gold");
    expect(c.service).toBe("color");
    expect(c.resource).toBe("#FFFFD700");
    expect(c.in).toBe(0);
    expect(c.out).toBe(29);
    expect(c.length).toBe(30); // length is SEPARATE from out
  });
});

describe("fades become sentinel filters the serializer resolves", () => {
  it("encodes fadeIn/fadeOut as reserved-service marker filters", () => {
    const c = clip("/a.mp4", { dur: 60, fadeIn: 12, fadeOut: 15 });
    const services = c.filters.map((f) => f.service);
    expect(services).toContain(FADE_IN_SERVICE);
    expect(services).toContain(FADE_OUT_SERVICE);
    const fin = c.filters.find((f) => f.service === FADE_IN_SERVICE);
    expect(fin?.properties.frames).toBe(12);
  });
});

describe("tracks + gain + transitions (the extended surface)", () => {
  it("builds a multi-track timeline with an audio clip + gain", () => {
    resetIds();
    const tl = timeline(
      VERTICAL,
      {
        video: [videoTrack(clip("/a.mp4", { dur: 90 }), dissolve(30), clip("/b.mp4", { dur: 90 }))],
        audio: [audioTrack(clip("/vo.wav", { dur: 170, gain: 0.8 }))],
      },
      {
        transitions: [transition("qtblend", 0, 1, 0, 29)],
      },
    );
    // Schema-valid (the gate the serializer parses against).
    const parsed = timelineSchema.parse(tl);
    expect(parsed.tracks.video).toHaveLength(1);
    expect(parsed.tracks.audio).toHaveLength(1);
    expect(parsed.tracks.audio[0]?.kind).toBe("audio");
    expect(parsed.tracks.audio[0]?.hidden).toBe(true);
    const vo = parsed.tracks.audio[0]?.items[0];
    expect(vo?.kind).toBe("clip");
    if (vo?.kind === "clip") expect(vo.gain).toBe(0.8);
    // Field transition references tracks by integer index.
    expect(parsed.transitions[0]?.aTrack).toBe(0);
    expect(parsed.transitions[0]?.bTrack).toBe(1);
  });

  it("rational fps is a [num,den] tuple, never a float", () => {
    expect(VERTICAL.fps).toEqual([30, 1]);
    expect(timelineSchema.parse(timeline(VERTICAL, {})).profile.fps).toEqual([30, 1]);
  });

  it("blanks are literal gaps with a positive length", () => {
    expect(blank(12)).toEqual({ kind: "blank", length: 12 });
    expect(() => blank(0)).toThrow();
  });

  it("an animation-string filter value is stored verbatim (= keeps it animated)", () => {
    const f = filter("brightness", { level: "0=0;14=1" });
    expect(f.properties.level).toBe("0=0;14=1");
  });
});

describe("determinism of authoring", () => {
  it("resetIds makes the same module build a byte-identical IR", () => {
    const build = () => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(colorClip(45, "black", { fadeIn: 12 }), dissolve(20), colorClip(60, "gold")),
        ],
      });
    };
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});
