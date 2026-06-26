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
import {
  type NumberValue,
  type RectValue,
  normalizeAnimDecimals,
  parseAnim,
  serializeAnim,
} from "../src/ir/keyframes";

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

/** Assert-non-null access — fails the test loudly (not silently undefined) when a
 *  parse drops something it shouldn't, without a forbidden `!` assertion. */
function must<T>(v: T | undefined | null, what: string): T {
  if (v == null) throw new Error(`expected ${what} to be present`);
  return v;
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
  // The keyframe engine ACCEPTS a comma OR a dot decimal separator on parse (a
  // comma-decimal arrives from a foreign-locale .mlt) and ALWAYS serializes a dot
  // (LC_NUMERIC=C). This is what closes the round-trip mis-render below.
  it("accepts a comma-decimal scalar inside an animation string and emits a dot", () => {
    const m = parseAnim("0=1,5");
    expect((m.keyframes[0]?.value as NumberValue).value).toBe(1.5);
    expect(serializeAnim(m)).toBe("0=1.5");
    // dot input is unchanged (idempotent — both forms canonicalize to the dot).
    expect(serializeAnim(parseAnim("0=1.5"))).toBe("0=1.5");
  });

  it("accepts a comma-decimal in a rect component (opacity and coords)", () => {
    const m = parseAnim("0=0 0 100 100 0,5");
    const r = m.keyframes[0]?.value as RectValue;
    expect(r.opacity).toBe(0.5);
    expect(serializeAnim(m)).toBe("0=0 0 100 100 0.5");
    // a coordinate slot accepts a comma decimal too.
    expect(serializeAnim(parseAnim("0=10,5 0 100 100 1"))).toBe("0=10.5 0 100 100 1");
  });

  it("normalizeAnimDecimals migrates only decimal commas, leaving structure intact", () => {
    // markers, ';', '=', color hex, and spacing are all preserved byte-for-byte.
    expect(normalizeAnimDecimals("0=0,2;59=0,8")).toBe("0=0.2;59=0.8");
    expect(normalizeAnimDecimals("0~=0,5;30|=1,25")).toBe("0~=0.5;30|=1.25");
    expect(normalizeAnimDecimals("0=#ff0000;30=#0000ff")).toBe("0=#ff0000;30=#0000ff");
    // an already-dot string is returned unchanged (idempotent).
    expect(normalizeAnimDecimals("0=0.2;59=0.8")).toBe("0=0.2;59=0.8");
  });
});

describe("keyframes: degenerate strings", () => {
  it("an empty property string round-trips to empty (no fabricated value)", () => {
    // An empty MLT property (`<property name="x"></property>`) is legal and means
    // empty. It must round-trip as empty — parsing "" yields a static model with
    // NO keyframes (no value invented), and serialize re-emits "".
    expect(serializeAnim(parseAnim(""))).toBe("");
    // whitespace-only is likewise an empty value, not a fabricated "0".
    expect(serializeAnim(parseAnim("   "))).toBe("");
    // the parsed model carries no keyframe (nothing was authored).
    expect(parseAnim("").keyframes).toHaveLength(0);
    expect(parseAnim("").static).toBe(true);
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

  it("producer-level shotcut:caption / eof / aspect_ratio are PRESERVED on round-trip", () => {
    // resolveProducer now captures every non-structural producer property
    // (caption, eof, aspect_ratio, proxy hints, …) into the IR clip's extraProps,
    // and the serializer re-emits them — so a real Shotcut file keeps its metadata.
    // The serializer banner's "round-trips losslessly" is now true for these.
    const doc = shotcutDoc({
      producerProps: [
        '    <property name="shotcut:caption">my caption</property>',
        '    <property name="eof">pause</property>',
        '    <property name="aspect_ratio">1</property>',
        "",
      ].join("\n"),
    });
    const r = roundtripXml(doc);
    expect(r.pass).toBe(true); // still a fixpoint, now genuinely lossless
    expect(r.emitted).toContain('<property name="shotcut:caption">my caption</property>');
    expect(r.emitted).toContain('<property name="eof">pause</property>');
    expect(r.emitted).toContain('<property name="aspect_ratio">1</property>');
  });

  it("structural producer props are NOT duplicated as extras (no double-emit)", () => {
    // A producer carrying ONLY the structural properties (mlt_service, resource,
    // length, shotcut:uuid) must re-emit each exactly once WITHIN its own producer
    // block — the extras capture skips them so they don't fight their dedicated
    // field. (Scope to the clip producer; the background producer is a separate
    // block with its own structural props.)
    const doc = shotcutDoc({});
    const emitted = roundtripXml(doc).emitted;
    const block = /<producer[^>]*>(?:(?!<\/producer>)[\s\S])*?#ff2a6f97[\s\S]*?<\/producer>/.exec(
      emitted,
    );
    expect(block).not.toBeNull();
    const clipProducer = block?.[0] ?? "";
    const count = (needle: string) => clipProducer.split(needle).length - 1;
    expect(count('<property name="mlt_service">')).toBe(1);
    expect(count('<property name="resource">')).toBe(1);
    expect(count('<property name="length">')).toBe(1);
    expect(count('<property name="shotcut:uuid">')).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// .mlt ROUND-TRIP — non-structural property preservation at EVERY element level
// (generalizing defect #2's producer-level fix to playlists + the main tractor)
// ════════════════════════════════════════════════════════════════════════════

describe("round-trip: playlist-level non-structural properties are PRESERVED", () => {
  // A real Shotcut playlist carries shotcut:video/shotcut:audio/shotcut:name
  // (modeled structurally) but may ALSO carry shotcut:lock or custom namespaces.
  // These used to be silently dropped (walkPlaylist read only shotcut:name); the
  // parser now captures them into Track.extraProps and the serializer re-emits
  // them after the structural hints — so the round-trip is genuinely lossless.
  const doc = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.38.0" root="" title="t">
  <profile description="HD" width="1920" height="1080" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="99"><property name="length">100</property><property name="mlt_service">color</property><property name="resource">#ff0000</property></producer>
  <playlist id="playlist0">
    <property name="shotcut:video">1</property>
    <property name="shotcut:audio">0</property>
    <property name="shotcut:name">MyVideoTrack</property>
    <property name="shotcut:lock">true</property>
    <property name="custom:foo">bar</property>
    <entry producer="producer0" in="0" out="99"/>
  </playlist>
  <tractor id="tractor0" shotcut="1" title="t"><track producer="playlist0"/></tractor>
</mlt>`;

  it("captures shotcut:lock and custom:foo into the IR track's extraProps", () => {
    const tl = fromMlt(doc);
    const track = must(tl.tracks.video[0], "video track 0");
    expect(track.name).toBe("MyVideoTrack"); // structural name still modeled
    expect(track.extraProps).toMatchObject({ "shotcut:lock": "true", "custom:foo": "bar" });
    // the structural hints are NOT duplicated into extraProps.
    expect(track.extraProps).not.toHaveProperty("shotcut:video");
    expect(track.extraProps).not.toHaveProperty("shotcut:audio");
    expect(track.extraProps).not.toHaveProperty("shotcut:name");
  });

  it("re-emits both extra playlist properties and reaches a fixpoint", () => {
    const r = roundtripXml(doc);
    expect(r.pass).toBe(true); // still a fixpoint, now genuinely lossless
    expect(r.emitted).toContain('<property name="shotcut:lock">true</property>');
    expect(r.emitted).toContain('<property name="custom:foo">bar</property>');
  });

  it("a playlist with ONLY structural hints emits no extras (byte-stable, no fabrication)", () => {
    // shotcutDoc() carries the bare shotcut:video/shotcut:name → no extraProps on
    // the track, so the playlist block carries exactly the three structural hints.
    const tl = fromMlt(shotcutDoc({}));
    expect(must(tl.tracks.video[0], "video track 0").extraProps).toBeUndefined();
  });
});

describe("round-trip: main-tractor-level non-structural properties are PRESERVED", () => {
  // Shotcut writes project metadata as <property> children on the main tractor
  // (shotcut:projectAudioChannels, shotcut:scaleFactor, …). These used to be
  // dropped (the parser read only <track>/<transition> children); they are now
  // captured into Timeline.tractorProps and re-emitted on the main tractor.
  const doc = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.38.0" root="" title="t">
  <profile description="HD" width="1920" height="1080" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="99"><property name="length">100</property><property name="mlt_service">color</property><property name="resource">#ff0000</property></producer>
  <playlist id="playlist0"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property><property name="shotcut:name">V1</property><entry producer="producer0" in="0" out="99"/></playlist>
  <tractor id="tractor0" shotcut="1" title="t">
    <property name="shotcut:projectAudioChannels">2</property>
    <property name="shotcut:scaleFactor">0.5</property>
    <track producer="playlist0"/>
  </tractor>
</mlt>`;

  it("captures the main tractor's project metadata into Timeline.tractorProps", () => {
    const tl = fromMlt(doc);
    // 2 coerces to a number; 0.5 stays a number — both via propValue.
    expect(tl.tractorProps).toMatchObject({
      "shotcut:projectAudioChannels": 2,
      "shotcut:scaleFactor": 0.5,
    });
  });

  it("re-emits both tractor properties and reaches a fixpoint", () => {
    const r = roundtripXml(doc);
    expect(r.pass).toBe(true);
    expect(r.emitted).toContain('<property name="shotcut:projectAudioChannels">2</property>');
    expect(r.emitted).toContain('<property name="shotcut:scaleFactor">0.5</property>');
  });

  it("a timeline with no main-tractor properties leaves tractorProps absent (byte-stable)", () => {
    const tl = fromMlt(shotcutDoc({}));
    expect(tl.tractorProps).toBeUndefined();
  });
});

describe("round-trip: field transition with in/out as <property> (no duplicated state)", () => {
  // Shotcut may write a field transition's window as <property name="in">/<out>
  // children instead of in=/out= attributes. The window is the structural
  // Transition.in/out — it must be modeled ONCE and re-emitted ONCE (as the
  // attributes vean canonicalizes to), never ALSO copied into the properties map
  // (which would emit divergent attr + property state melt sees both of).
  const doc = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.38.0" root="" title="t">
  <profile description="HD" width="1920" height="1080" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="99"><property name="length">100</property><property name="mlt_service">color</property><property name="resource">#ff0000</property></producer>
  <producer id="producer1" in="0" out="99"><property name="length">100</property><property name="mlt_service">color</property><property name="resource">#00ff00</property></producer>
  <playlist id="playlist0"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property><property name="shotcut:name">V1</property><entry producer="producer0" in="0" out="99"/></playlist>
  <playlist id="playlist1"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property><property name="shotcut:name">V2</property><entry producer="producer1" in="0" out="99"/></playlist>
  <tractor id="tractor0" shotcut="1" title="t">
    <track producer="producer2"/>
    <track producer="playlist0"/>
    <track producer="playlist1"/>
    <transition id="transition0" mlt_service="qtblend">
      <property name="a_track">1</property>
      <property name="b_track">2</property>
      <property name="in">0</property>
      <property name="out">99</property>
    </transition>
  </tractor>
</mlt>`;

  it("models in/out ONLY as the structural window, never in the properties map", () => {
    const tl = fromMlt(doc);
    const t = must(tl.transitions[0], "transition 0");
    expect(t.in).toBe(0);
    expect(t.out).toBe(99);
    // the window must NOT leak into the property map (the defect was {in,out} here).
    expect(t.properties).not.toHaveProperty("in");
    expect(t.properties).not.toHaveProperty("out");
  });

  it('re-emits in/out ONCE as attributes — no <property name="in"/"out"> children', () => {
    const r = roundtripXml(doc);
    expect(r.pass).toBe(true);
    const tline = r.emitted.split("\n").find((l) => l.includes("<transition")) ?? "";
    expect(tline).toContain('in="0"');
    expect(tline).toContain('out="99"');
    // the divergent duplicate property form is gone.
    expect(r.emitted).not.toContain('<property name="in">');
    expect(r.emitted).not.toContain('<property name="out">');
  });

  it("the attribute-form transition (already canonical) stays clean too", () => {
    const attrDoc = doc.replace(
      '<transition id="transition0" mlt_service="qtblend">\n      <property name="a_track">1</property>\n      <property name="b_track">2</property>\n      <property name="in">0</property>\n      <property name="out">99</property>\n    </transition>',
      '<transition id="transition0" mlt_service="qtblend" in="0" out="99">\n      <property name="a_track">1</property>\n      <property name="b_track">2</property>\n    </transition>',
    );
    const tl = fromMlt(attrDoc);
    const t = must(tl.transitions[0], "transition 0");
    expect(t.in).toBe(0);
    expect(t.out).toBe(99);
    expect(t.properties).toStrictEqual({});
    expect(roundtripXml(attrDoc).pass).toBe(true);
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

  it("a comma-decimal INSIDE an animation string is normalized to dot-decimal", () => {
    // The doc declares a comma-decimal locale; the keyframe value 0,2 means 0.2.
    // The parser now migrates comma-decimals inside an animation string to dots
    // (normalizeAnimDecimals), so under the C-locale header vean re-emits, melt's
    // atof reads 0.2 / 0.8 and animates brightness 0.2→0.8 as authored — closing
    // the silent mis-render where atof("0,2") == 0 gave 0→0→1.
    const doc = `<?xml version="1.0"?>
<mlt LC_NUMERIC="fr_FR" version="7.38.0">
  <profile description="HD" width="1920" height="1080" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="59"><property name="length">60</property><property name="mlt_service">color</property><property name="resource">#ff0000ff</property>
    <filter mlt_service="brightness"><property name="level">0=0,2;59=0,8</property></filter></producer>
  <playlist id="playlist0"><property name="shotcut:video">1</property><property name="shotcut:name">V1</property><entry producer="producer0" in="0" out="59"/></playlist>
  <tractor id="tractor0" shotcut="1"><track producer="producer0"/><track producer="playlist0"/></tractor>
</mlt>`;
    const r = roundtripXml(doc);
    expect(r.pass).toBe(true); // and it's a fixpoint (idempotent)
    expect(r.emitted).toContain('LC_NUMERIC="C"'); // header says C-locale (dot-decimal)
    expect(r.emitted).toContain("0=0.2;59=0.8"); // comma → dot: renders as authored
    expect(r.emitted).not.toContain("0=0,2;59=0,8"); // the buggy verbatim form is gone
  });
});
