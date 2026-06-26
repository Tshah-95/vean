import { describe, expect, it } from "vitest";
import { roundtripXml } from "../scripts/roundtrip";
import {
  VERTICAL,
  colorClip,
  dissolve,
  fromMlt,
  resetIds,
  timeline,
  toMlt,
  videoTrack,
} from "../src/index";
import { parseAnim, serializeAnim } from "../src/ir/keyframes";

// Adversarial edge-case fixtures — deliberately constructed to BREAK the
// keyframe engine and the .mlt round-trip. Each case states what was thrown at
// it, what SHOULD happen, and what the implementation ACTUALLY does. The two
// `KNOWN DEFECT` blocks pin real failures so a future fix flips them red here
// first; everything else locks in correct behavior so a regression is caught.

// ─── helpers ────────────────────────────────────────────────────────────────
/** Parse→serialize an animation string and report byte-identity. */
function kfRound(s: string, opts?: { fps?: [number, number] }): string {
  return serializeAnim(parseAnim(s, opts), opts);
}

/** A minimal single-color-clip Shotcut doc carrying one extra producer property
 *  and/or one filter, for producer-fidelity probes. */
function shotcutDoc(body: {
  producerProps?: string;
  filter?: string;
  lcNumeric?: string;
}): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="${body.lcNumeric ?? "C"}" version="7.38.0" title="adv" producer="main_bin">
  <profile description="HD" width="1920" height="1080" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="59">
    <property name="length">60</property>
    <property name="mlt_service">color</property>
    <property name="resource">#ff2a6f97</property>
${body.producerProps ?? ""}${body.filter ?? ""}  </producer>
  <playlist id="playlist0">
    <property name="shotcut:video">1</property>
    <property name="shotcut:name">V1</property>
    <entry producer="producer0" in="0" out="59"/>
  </playlist>
  <tractor id="tractor0" title="adv" shotcut="1">
    <track producer="producer0"/>
    <track producer="playlist0"/>
  </tractor>
</mlt>`;
}

// ════════════════════════════════════════════════════════════════════════════
// KEYFRAME ENGINE — animation-string adversaries
// ════════════════════════════════════════════════════════════════════════════

describe("keyframes: negative / relative frames (-1 = length-1)", () => {
  it("a bare -1 round-trips and flags negative (not resolved early)", () => {
    const m = parseAnim("-1=50");
    expect(m.keyframes[0]?.frame).toBe(-1);
    expect(m.keyframes[0]?.negative).toBe(true);
    expect(kfRound("-1=50")).toBe("-1=50");
  });

  it("a -1 carrying a discrete marker AND a percent value round-trips", () => {
    expect(kfRound("-1|=50%")).toBe("-1|=50%");
  });

  it("the -1 vs smooth_tight '-' marker ambiguity resolves correctly", () => {
    // "-1-=5": marker peel takes the LAST non-digit ('-') as smooth_tight; what
    // remains ("-1") is the negative time. Both must survive.
    const m = parseAnim("-1-=5");
    expect(m.keyframes[0]?.frame).toBe(-1);
    expect(m.keyframes[0]?.negative).toBe(true);
    expect(m.keyframes[0]?.interp).toBe("smooth_tight");
    expect(kfRound("-1-=5")).toBe("-1-=5");
  });

  it("negative frames are NOT re-based even under a non-zero clip in-point", () => {
    expect(serializeAnim(parseAnim("0=0;-1=1", { in: 20 }), { in: 20 })).toBe("0=0;-1=1");
  });
});

describe("keyframes: percent values", () => {
  it("scalar percent reads /100 and re-emits the % sign", () => {
    const m = parseAnim("0=0%;30=100%");
    expect(m.keyframes[1]?.value).toMatchObject({ value: 1, percent: true });
    expect(kfRound("0=0%;30=100%")).toBe("0=0%;30=100%");
  });

  it("a negative percent value survives", () => {
    expect(kfRound("0=-50%")).toBe("0=-50%");
  });

  it("a rect opacity may be a percent (only the opacity slot)", () => {
    expect(kfRound("0=0 0 100 100 50%")).toBe("0=0 0 100 100 50%");
    // A percent in a non-opacity rect slot is NOT a valid MLT rect → rejected.
    expect(() => parseAnim("0=0 0 100% 100 1")).toThrow(/malformed rect component/);
  });
});

describe("keyframes: interpolation markers (the full table)", () => {
  it("hold bar '|' parses discrete and round-trips", () => {
    expect(parseAnim("10|=1").keyframes[0]?.interp).toBe("discrete");
    expect(kfRound("0=0;10|=1")).toBe("0=0;10|=1");
  });

  it("smooth tilde '~' parses smooth and round-trips", () => {
    expect(parseAnim("10~=1").keyframes[0]?.interp).toBe("smooth");
    expect(kfRound("0=0;10~=1")).toBe("0=0;10~=1");
  });

  it("a Penner easing preserves its exact char (a..D and beyond)", () => {
    const m = parseAnim("0=0;10a=1;20D=1");
    expect(m.keyframes[1]).toMatchObject({ interp: "penner", pennerChar: "a" });
    expect(m.keyframes[2]).toMatchObject({ interp: "penner", pennerChar: "D" });
    expect(kfRound("0=0;10a=1;20D=1")).toBe("0=0;10a=1;20D=1");
  });

  it("'!' canonicalizes to '|' and '>'/'<' collapse to linear (documented normalizations)", () => {
    expect(kfRound("5!=1")).toBe("5|=1");
    expect(kfRound("5>=1")).toBe("5=1");
  });
});

describe("keyframes: rect and color values", () => {
  it("a marked rect keyframe round-trips component-wise (incl. negative coords)", () => {
    const s = "0=0 0 1920 1080 1;30~=-200 -100 1520 880 0.8";
    expect(kfRound(s)).toBe(s);
  });

  it("a color keyframe round-trips per channel (6- and 8-digit)", () => {
    expect(kfRound("0=#ff0000;30=#0000ff")).toBe("0=#ff0000;30=#0000ff");
    expect(kfRound("0=#80ff0000;30=#ff0000ff")).toBe("0=#80ff0000;30=#ff0000ff");
  });
});

describe("keyframes: LC_NUMERIC comma-decimal input (foreign locale)", () => {
  // The keyframe engine is C-locale only: a comma-decimal in an animation value
  // is NOT a number it accepts. This is the root of the round-trip defect below.
  it("REJECTS a comma-decimal scalar inside an animation string", () => {
    expect(() => parseAnim("0=1,5")).toThrow(/malformed numeric value/);
    expect(() => parseAnim("0=0 0 100 100 0,5")).toThrow(/malformed numeric value/);
  });
});

describe("keyframes: degenerate strings", () => {
  it("KNOWN DEFECT: an empty property string fabricates a '0' value", () => {
    // An empty MLT property (`<property name="x"></property>`) is legal and means
    // empty. parseAnim treats it as static and serializes a fabricated "0".
    // EXPECTED: round-trip empty as empty. ACTUAL: "" → "0".
    expect(serializeAnim(parseAnim(""))).toBe("0");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// .mlt ROUND-TRIP — structural adversaries
// ════════════════════════════════════════════════════════════════════════════

describe("round-trip: same-track dissolve longer than a neighbour clip", () => {
  it("the serializer guard REJECTS a dissolve longer than its preceding clip", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(20, "black"), dissolve(30), colorClip(60, "gold"))],
    });
    expect(() => toMlt(tl)).toThrow(/longer than the preceding clip/);
  });

  it("the serializer guard REJECTS a dissolve longer than its following clip", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "black"), dissolve(40), colorClip(30, "gold"))],
    });
    expect(() => toMlt(tl)).toThrow(/longer than the following clip/);
  });

  it("a dissolve EXACTLY equal to its neighbours (clips wholly consumed) round-trips", () => {
    resetIds();
    const x = toMlt(
      timeline(VERTICAL, {
        video: [videoTrack(colorClip(30, "black"), dissolve(30), colorClip(30, "gold"))],
      }),
    );
    expect(toMlt(fromMlt(x))).toBe(x); // fixpoint
  });
});

describe("round-trip: empty / placeholder tracks", () => {
  it("a video track with NO items round-trips to a stable fixpoint", () => {
    resetIds();
    const x = toMlt(timeline(VERTICAL, { video: [videoTrack()] }));
    expect(toMlt(fromMlt(x))).toBe(x);
  });

  it("a track that is only a 1-frame blank placeholder round-trips", () => {
    resetIds();
    const x = toMlt(timeline(VERTICAL, { video: [videoTrack(colorClip(1, "black"))] }));
    expect(toMlt(fromMlt(x))).toBe(x);
  });
});

describe("round-trip: keyframe-bearing escape-hatch filters in a full Shotcut doc", () => {
  it("a marked rect, a percent geometry, and a color keyframe all pass through verbatim", () => {
    const doc = shotcutDoc({
      filter: [
        '    <filter mlt_service="affine" shotcut:filter="affineSizePosition">',
        '      <property name="transition.rect">0=0 0 1920 1080 1;30~=200 100 1520 880 0.8;59=0 0 1920 1080 1</property>',
        "    </filter>",
        '    <filter mlt_service="dynamictext" shotcut:filter="dynamicText">',
        '      <property name="argument">hello</property>',
        '      <property name="geometry">0=10 10 500 100 100%;59=10 10 500 100 50%</property>',
        "    </filter>",
        '    <filter mlt_service="qtblend">',
        '      <property name="background">0=#ff000000;59=#ffffffff</property>',
        "    </filter>",
        "",
      ].join("\n"),
    });
    const r = roundtripXml(doc);
    expect(r.pass).toBe(true); // fixpoint
    // verbatim animation strings + the non-animated `argument` all survive.
    expect(r.emitted).toContain("0=0 0 1920 1080 1;30~=200 100 1520 880 0.8;59=0 0 1920 1080 1");
    expect(r.emitted).toContain("0=10 10 500 100 100%;59=10 10 500 100 50%");
    expect(r.emitted).toContain("0=#ff000000;59=#ffffffff");
    expect(r.emitted).toContain("hello");
  });
});

describe("round-trip: full shotcut: namespace producer fidelity", () => {
  it("the xmlns:shotcut declaration and shotcut:filter on a filter are handled", () => {
    // A doc that DECLARES the namespace (real Shotcut uses the prefix undeclared).
    // vean drops the xmlns declaration but keeps the prefixed filter tag — Shotcut
    // re-reads it fine. This must still reach a fixpoint.
    const doc = `<?xml version="1.0" encoding="utf-8"?>
<mlt xmlns:shotcut="http://www.meltytech.com/schemas/shotcut/1.0" LC_NUMERIC="C" version="7.38.0" title="ns" producer="main_bin">
  <profile description="HD" width="1920" height="1080" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="59">
    <property name="length">60</property>
    <property name="mlt_service">color</property>
    <property name="resource">#ff2a6f97</property>
    <filter mlt_service="brightness" shotcut:filter="fadeInBrightness">
      <property name="level">0=0;14=1</property>
    </filter>
  </producer>
  <playlist id="playlist0"><property name="shotcut:video">1</property><property name="shotcut:name">V1</property><entry producer="producer0" in="0" out="59"/></playlist>
  <tractor id="tractor0" title="ns" shotcut="1"><track producer="producer0"/><track producer="playlist0"/></tractor>
</mlt>`;
    expect(roundtripXml(doc).pass).toBe(true);
  });

  it("KNOWN DEFECT: producer-level shotcut:caption / eof / aspect_ratio are DROPPED", () => {
    // The parser's resolveProducer reads only mlt_service, resource, length —
    // every other producer property is discarded. A real Shotcut file loses its
    // captions, eof=pause, aspect_ratio, proxy hints, etc. The serializer banner
    // ("round-trips losslessly") is FALSE for any producer carrying these.
    // EXPECTED: these survive. ACTUAL: dropped.
    const doc = shotcutDoc({
      producerProps: [
        '    <property name="shotcut:caption">my caption</property>',
        '    <property name="eof">pause</property>',
        '    <property name="aspect_ratio">1</property>',
        "",
      ].join("\n"),
    });
    const emitted = roundtripXml(doc).emitted;
    expect(emitted).not.toContain("my caption"); // DROPPED (the defect)
    expect(emitted).not.toContain("pause"); // DROPPED
    expect(emitted).not.toContain("aspect_ratio"); // DROPPED
  });
});

describe("round-trip: LC_NUMERIC comma-decimal input (the locale adversary)", () => {
  it("a comma-decimal on a PLAIN scalar (gain) is normalized to a dot — SAFE", () => {
    const doc = shotcutDoc({
      filter: '    <filter mlt_service="volume"><property name="level">0,8</property></filter>\n',
    });
    const emitted = roundtripXml(doc).emitted;
    expect(emitted).toContain("0.8"); // comma → dot via dotDecimal on the gain path
    expect(emitted).not.toContain("0,8");
  });

  it("KNOWN DEFECT: a comma-decimal INSIDE an animation string survives uncorrected", () => {
    // The doc declares a comma-decimal locale; the keyframe value 0,2 means 0.2.
    // The parser's dotDecimal explicitly SKIPS any string containing '=' (so it
    // never touches an animation string), and the keyframe engine can't parse a
    // comma-decimal — so vean passes "0=0,2;59=0,8" through VERBATIM while
    // re-declaring LC_NUMERIC="C". Under the C locale, melt's atof("0,2") == 0,
    // SILENTLY mis-animating brightness 0→0→1 instead of 0.2→0.8→1.
    // The doc claims "round-trips losslessly" — it does for BYTES, but the
    // re-emitted file no longer renders what the source intended.
    // EXPECTED: comma-decimals in animation strings are normalized to dots (or the
    // round-trip refuses). ACTUAL: passed through verbatim under a C-locale header.
    const doc = `<?xml version="1.0"?>
<mlt LC_NUMERIC="fr_FR" version="7.38.0">
  <profile description="HD" width="1920" height="1080" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="59"><property name="length">60</property><property name="mlt_service">color</property><property name="resource">#ff0000ff</property>
    <filter mlt_service="brightness"><property name="level">0=0,2;59=0,8</property></filter></producer>
  <playlist id="playlist0"><property name="shotcut:video">1</property><property name="shotcut:name">V1</property><entry producer="producer0" in="0" out="59"/></playlist>
  <tractor id="tractor0" shotcut="1"><track producer="producer0"/><track producer="playlist0"/></tractor>
</mlt>`;
    const emitted = roundtripXml(doc).emitted;
    expect(emitted).toContain('LC_NUMERIC="C"'); // header says C-locale (dot-decimal)
    expect(emitted).toContain("0=0,2;59=0,8"); // …but the comma-decimal survives → mis-animation
  });
});
