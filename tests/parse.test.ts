import { describe, expect, it } from "vitest";
import {
  FADE_IN_SERVICE,
  FADE_OUT_SERVICE,
  VERTICAL,
  audioTrack,
  clip,
  colorClip,
  dissolve,
  fromMlt,
  resetIds,
  timeline,
  toMlt,
  transition,
  videoTrack,
} from "../src/index";

// `fromMlt` is the inverse of the serializer. The serializer is a parallel Move-0
// build (its byte format isn't frozen yet), so these tests pin the parser against
// a GOLDEN XML CORPUS of the canonical MLT/Shotcut shapes documented in AGENTS.md
// and proven by studio's seed serializer — the format contract the two halves
// must meet in the middle. Each fixture is a hand-written .mlt string; we assert
// the recovered IR. (A full serialize↔parse byte round-trip lands in a later
// phase, once both bodies exist.)

const PROFILE = `  <profile description="vertical-1080x1920-30" width="1080" height="1920" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="9" display_aspect_den="16" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>`;

/** Assert-non-null access — fails the test loudly (not silently undefined) when a
 *  parse drops something it shouldn't, without a forbidden `!` assertion. */
function must<T>(v: T | undefined | null, what: string): T {
  if (v == null) throw new Error(`expected ${what} to be present`);
  return v;
}

function doc(...body: string[]): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<mlt LC_NUMERIC="C" version="7.38.0" title="vean timeline">',
    PROFILE,
    ...body,
    "</mlt>",
    "",
  ].join("\n");
}

describe("profile + root", () => {
  it("recovers a rational fps tuple, dimensions, aspect (never a float fps)", () => {
    const tl = fromMlt(
      doc(
        '  <producer id="producer0" in="0" out="44"><property name="mlt_service">color</property><property name="resource">#FF000000</property><property name="length">45</property></producer>',
        '  <playlist id="playlist0"><entry producer="producer0" in="0" out="44"/></playlist>',
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
      ),
    );
    expect(tl.profile.fps).toEqual([30, 1]);
    expect(tl.profile.width).toBe(1080);
    expect(tl.profile.height).toBe(1920);
    expect(tl.profile.displayAspectNum).toBe(9);
    expect(tl.profile.displayAspectDen).toBe(16);
    expect(tl.title).toBe("vean timeline");
  });

  it("honors a 29.97 NTSC profile as [30000,1001] — exact rational, no float", () => {
    const tl = fromMlt(
      [
        '<mlt LC_NUMERIC="C" version="7.38.0">',
        '  <profile description="ntsc" width="1920" height="1080" display_aspect_num="16" display_aspect_den="9" frame_rate_num="30000" frame_rate_den="1001" colorspace="709"/>',
        '  <producer id="producer0" in="0" out="9"><property name="mlt_service">color</property><property name="resource">#FF000000</property><property name="length">10</property></producer>',
        '  <playlist id="playlist0"><entry producer="producer0" in="0" out="9"/></playlist>',
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
        "</mlt>",
      ].join("\n"),
    );
    expect(tl.profile.fps).toEqual([30000, 1001]);
  });

  it("rejects a non-numeric version (the MltXmlChecker guard)", () => {
    expect(() =>
      fromMlt('<mlt version="garbage"><profile frame_rate_num="30" frame_rate_den="1"/></mlt>'),
    ).toThrow(/version/);
  });
});

describe("single track: clips + blanks (order-preserving)", () => {
  it("recovers a clip, then a gap, then a clip — in document order", () => {
    const tl = fromMlt(
      doc(
        '  <producer id="A" in="0" out="44"><property name="mlt_service">color</property><property name="resource">#FF000000</property><property name="length">45</property></producer>',
        '  <producer id="B" in="0" out="59"><property name="mlt_service">color</property><property name="resource">#FFFFD700</property><property name="length">60</property></producer>',
        '  <playlist id="playlist0">',
        '    <entry producer="A" in="0" out="44"/>',
        '    <blank length="10"/>',
        '    <entry producer="B" in="0" out="59"/>',
        "  </playlist>",
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
      ),
    );
    const items = must(tl.tracks.video[0], "video track 0").items;
    expect(items.map((i) => i.kind)).toEqual(["clip", "blank", "clip"]);
    const a = must(items[0], "item 0");
    if (a.kind === "clip") {
      expect(a.resource).toBe("#FF000000");
      expect(a.in).toBe(0);
      expect(a.out).toBe(44); // inclusive → playtime 45
      expect(a.out - a.in + 1).toBe(45);
      expect(a.service).toBe("color");
    }
    const gap = must(items[1], "item 1");
    if (gap.kind === "blank") expect(gap.length).toBe(10);
  });

  it("preserves an INCLUSIVE windowed file clip [20,74] (playtime = 55)", () => {
    const tl = fromMlt(
      doc(
        '  <producer id="clip-0" in="20" out="74"><property name="resource">/abs/footage.mp4</property></producer>',
        '  <playlist id="playlist0"><entry producer="clip-0" in="20" out="74"/></playlist>',
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
      ),
    );
    const c = must(must(tl.tracks.video[0], "video track 0").items[0], "item 0");
    expect(c.kind).toBe("clip");
    if (c.kind === "clip") {
      expect(c.in).toBe(20);
      expect(c.out).toBe(74);
      expect(c.out - c.in + 1).toBe(55);
      expect(c.service).toBeUndefined(); // file clip — melt infers service
      expect(c.resource).toBe("/abs/footage.mp4");
    }
  });
});

describe("fade recovery (the seed's brightness keyframe shape)", () => {
  it("recovers fadeIn 0=0;{n-1}=1 back into the sentinel filter", () => {
    const tl = fromMlt(
      doc(
        '  <producer id="A" in="0" out="44"><property name="mlt_service">color</property><property name="resource">#FF000000</property><property name="length">45</property>',
        '    <filter mlt_service="brightness"><property name="level">0=0;11=1</property></filter>',
        "  </producer>",
        '  <playlist id="playlist0"><entry producer="A" in="0" out="44"/></playlist>',
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
      ),
    );
    const c = must(must(tl.tracks.video[0], "video track 0").items[0], "item 0");
    if (c.kind === "clip") {
      const fin = c.filters.find((f) => f.service === FADE_IN_SERVICE);
      expect(fin).toBeDefined();
      expect(fin?.properties.frames).toBe(12); // 11=1 → 12 frames of fade
    }
  });

  it("recovers fadeOut {len-n}=1;{len-1}=0 back into the sentinel filter", () => {
    // 60-frame clip, fadeOut 15: keyframes 45=1;59=0
    const tl = fromMlt(
      doc(
        '  <producer id="A" in="0" out="59"><property name="mlt_service">color</property><property name="resource">#FFFFD700</property><property name="length">60</property>',
        '    <filter mlt_service="brightness"><property name="level">45=1;59=0</property></filter>',
        "  </producer>",
        '  <playlist id="playlist0"><entry producer="A" in="0" out="59"/></playlist>',
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
      ),
    );
    const c = must(must(tl.tracks.video[0], "video track 0").items[0], "item 0");
    if (c.kind === "clip") {
      const fout = c.filters.find((f) => f.service === FADE_OUT_SERVICE);
      expect(fout?.properties.frames).toBe(15); // 60 - 45 = 15
    }
  });
});

describe("same-track dissolve (nested lumaMix tractor)", () => {
  it("FILE clips: stitches the contiguous source windows back across the dissolve", () => {
    // clipA source window 100..199, dissolve 20 into clipB 0..89. The serializer
    // emits: A solo trimmed to 100..179, nested tractor (A tail 180..199 | B head
    // 0..19), B solo trimmed to 20..89. File windows are CONTIGUOUS in source, so
    // the full clips are A=100..199 and B=0..89.
    const tl = fromMlt(
      doc(
        '  <producer id="A" in="100" out="179"><property name="resource">/a.mp4</property></producer>',
        '  <producer id="Atail" in="180" out="199"><property name="resource">/a.mp4</property></producer>',
        '  <producer id="Bhead" in="0" out="19"><property name="resource">/b.mp4</property></producer>',
        '  <producer id="B" in="20" out="89"><property name="resource">/b.mp4</property></producer>',
        '  <tractor id="transition0" shotcut:transition="lumaMix">',
        '    <track producer="Atail" in="180" out="199"/>',
        '    <track producer="Bhead" in="0" out="19"/>',
        '    <transition mlt_service="luma" in="0" out="19"><property name="a_track">0</property><property name="b_track">1</property></transition>',
        '    <transition mlt_service="mix" in="0" out="19"><property name="a_track">0</property><property name="b_track">1</property><property name="sum">1</property></transition>',
        "  </tractor>",
        '  <playlist id="playlist0">',
        '    <entry producer="A" in="100" out="179"/>',
        '    <entry producer="transition0" in="0" out="19"/>',
        '    <entry producer="B" in="20" out="89"/>',
        "  </playlist>",
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
      ),
    );
    const items = must(tl.tracks.video[0], "video track 0").items;
    expect(items.map((i) => i.kind)).toEqual(["clip", "dissolve", "clip"]);
    const a = must(items[0], "item 0");
    const d = must(items[1], "item 1");
    const b = must(items[2], "item 2");
    if (d.kind === "dissolve") {
      expect(d.frames).toBe(20);
      expect(d.luma).toBe("luma");
    }
    // Outgoing clip's tail (180..199) stitched back: out extends to 199.
    if (a.kind === "clip") {
      expect(a.in).toBe(100);
      expect(a.out).toBe(199); // playtime 100 restored
    }
    // Incoming clip's head (0..19) stitched back: in shrinks to 0.
    if (b.kind === "clip") {
      expect(b.in).toBe(0);
      expect(b.out).toBe(89); // playtime 90 restored
    }
  });

  it("COLOR clips: concatenates the re-based 0-based segment playtimes", () => {
    // colorClip(45) dissolve 20 colorClip(60). Color segments are re-based to 0,
    // so the serializer emits: A solo 0..24, tail 0..19 (black), head 0..19
    // (gold), B solo 0..39 — playtimes CONCATENATE: A=0..44 (45f), B=0..59 (60f).
    const tl = fromMlt(
      doc(
        '  <producer id="A" in="0" out="24"><property name="mlt_service">color</property><property name="resource">#FF000000</property><property name="length">25</property></producer>',
        '  <producer id="Atail" in="0" out="19"><property name="mlt_service">color</property><property name="resource">#FF000000</property><property name="length">20</property></producer>',
        '  <producer id="Bhead" in="0" out="19"><property name="mlt_service">color</property><property name="resource">#FFFFD700</property><property name="length">20</property></producer>',
        '  <producer id="B" in="0" out="39"><property name="mlt_service">color</property><property name="resource">#FFFFD700</property><property name="length">40</property></producer>',
        '  <tractor id="transition0" shotcut:transition="lumaMix">',
        '    <track producer="Atail" in="0" out="19"/>',
        '    <track producer="Bhead" in="0" out="19"/>',
        '    <transition mlt_service="luma" in="0" out="19"><property name="a_track">0</property><property name="b_track">1</property></transition>',
        '    <transition mlt_service="mix" in="0" out="19"><property name="a_track">0</property><property name="b_track">1</property><property name="sum">1</property></transition>',
        "  </tractor>",
        '  <playlist id="playlist0">',
        '    <entry producer="A" in="0" out="24"/>',
        '    <entry producer="transition0" in="0" out="19"/>',
        '    <entry producer="B" in="0" out="39"/>',
        "  </playlist>",
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
      ),
    );
    const items = must(tl.tracks.video[0], "video track 0").items;
    expect(items.map((i) => i.kind)).toEqual(["clip", "dissolve", "clip"]);
    const a = must(items[0], "item 0");
    const b = must(items[2], "item 2");
    // A: solo 25f + 20f tail = 45f → 0..44, length 45.
    if (a.kind === "clip") {
      expect(a.in).toBe(0);
      expect(a.out).toBe(44);
      expect(a.length).toBe(45);
    }
    // B: 20f head + 40f solo = 60f → 0..59, length 60.
    if (b.kind === "clip") {
      expect(b.in).toBe(0);
      expect(b.out).toBe(59);
      expect(b.length).toBe(60);
    }
  });
});

describe("multi-track + audio + gain + field transition", () => {
  const xml = doc(
    // video track 1
    '  <producer id="v0" in="0" out="59"><property name="resource">/abs/a.mp4</property></producer>',
    // video track 2 (overlay)
    '  <producer id="v1" in="0" out="59"><property name="resource">/abs/overlay.mp4</property></producer>',
    // audio clip with gain
    '  <producer id="a0" in="0" out="124"><property name="resource">/abs/vo.wav</property>',
    '    <filter mlt_service="volume"><property name="level">0.8</property></filter>',
    "  </producer>",
    '  <playlist id="background"><entry producer="bg" in="0" out="124"/></playlist>',
    '  <producer id="bg" in="0" out="124"><property name="mlt_service">color</property><property name="resource">#FF000000</property><property name="length">125</property></producer>',
    '  <playlist id="pV1"><property name="shotcut:video">1</property><property name="shotcut:name">V1</property><entry producer="v0" in="0" out="59"/></playlist>',
    '  <playlist id="pV2"><property name="shotcut:video">1</property><property name="shotcut:name">V2</property><entry producer="v1" in="0" out="59"/></playlist>',
    '  <playlist id="pA1"><property name="shotcut:audio">1</property><property name="shotcut:name">A1</property><entry producer="a0" in="0" out="124"/></playlist>',
    '  <tractor id="tractor0" shotcut="1">',
    '    <track producer="bg"/>',
    '    <track producer="pV1"/>',
    '    <track producer="pV2"/>',
    '    <track producer="pA1" hide="video"/>',
    '    <transition mlt_service="qtblend" in="0" out="59"><property name="a_track">1</property><property name="b_track">2</property></transition>',
    "  </tractor>",
  );

  it("splits video vs audio tracks and drops the background producer track", () => {
    const tl = fromMlt(xml);
    expect(tl.tracks.video).toHaveLength(2);
    expect(tl.tracks.audio).toHaveLength(1);
    expect(must(tl.tracks.video[0], "video track 0").name).toBe("V1");
    expect(must(tl.tracks.audio[0], "audio track 0").name).toBe("A1");
    expect(must(tl.tracks.audio[0], "audio track 0").hidden).toBe(true);
  });

  it("recovers a static volume filter as the IR gain", () => {
    const tl = fromMlt(xml);
    const vo = must(must(tl.tracks.audio[0], "audio track 0").items[0], "item 0");
    if (vo.kind === "clip") {
      expect(vo.gain).toBe(0.8);
      // the volume filter was consumed into gain, not left as a literal filter
      expect(vo.filters.find((f) => f.service === "volume")).toBeUndefined();
    }
  });

  it("recovers a cross-track field transition with integer a_track/b_track", () => {
    const tl = fromMlt(xml);
    expect(tl.transitions).toHaveLength(1);
    const t = must(tl.transitions[0], "transition 0");
    expect(t.service).toBe("qtblend");
    expect(t.aTrack).toBe(1);
    expect(t.bTrack).toBe(2);
    expect(t.in).toBe(0);
    expect(t.out).toBe(59);
  });
});

describe("Shotcut quirks", () => {
  it("normalizes a comma-decimal locale value to a dot (gain 0,8 → 0.8)", () => {
    const tl = fromMlt(
      doc(
        '  <producer id="a0" in="0" out="9"><property name="resource">/abs/vo.wav</property>',
        '    <filter mlt_service="volume"><property name="level">0,8</property></filter>',
        "  </producer>",
        '  <playlist id="pA1"><property name="shotcut:audio">1</property><entry producer="a0" in="0" out="9"/></playlist>',
        '  <tractor id="tractor0"><track producer="pA1" hide="video"/></tractor>',
      ),
    );
    const vo = must(must(tl.tracks.audio[0], "audio track 0").items[0], "item 0");
    if (vo.kind === "clip") expect(vo.gain).toBe(0.8);
  });

  it("resolves a clock timecode out-point against fps (00:00:02.000 @30 → frame 60)", () => {
    const tl = fromMlt(
      doc(
        '  <producer id="clip-0" in="0" out="00:00:02.000"><property name="resource">/abs/footage.mp4</property></producer>',
        '  <playlist id="playlist0"><entry producer="clip-0" in="0" out="00:00:02.000"/></playlist>',
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
      ),
    );
    const c = must(must(tl.tracks.video[0], "video track 0").items[0], "item 0");
    if (c.kind === "clip") expect(c.out).toBe(60);
  });

  it("resolves a frame-clock timecode (00:00:01:15 @30 → frame 45)", () => {
    const tl = fromMlt(
      doc(
        '  <producer id="clip-0" in="0" out="00:00:01:15"><property name="resource">/abs/footage.mp4</property></producer>',
        '  <playlist id="playlist0"><entry producer="clip-0" in="0" out="00:00:01:15"/></playlist>',
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
      ),
    );
    const c = must(must(tl.tracks.video[0], "video track 0").items[0], "item 0");
    if (c.kind === "clip") expect(c.out).toBe(45);
  });

  it("preserves an animation-string filter value VERBATIM (keyframe model owns it)", () => {
    const tl = fromMlt(
      doc(
        '  <producer id="clip-0" in="0" out="59"><property name="resource">/abs/footage.mp4</property>',
        '    <filter mlt_service="affineSizePosition"><property name="transition.rect">0=0 0 1080 1920 1;-1~=50 50 540 960 0%</property><property name="shotcut:filter">sizePosition</property></filter>',
        "  </producer>",
        '  <playlist id="playlist0"><entry producer="clip-0" in="0" out="59"/></playlist>',
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
      ),
    );
    const c = must(must(tl.tracks.video[0], "video track 0").items[0], "item 0");
    if (c.kind === "clip") {
      const f = c.filters.find((x) => x.service === "affineSizePosition");
      expect(f).toBeDefined();
      // verbatim — NOT locale-touched, NOT re-based
      expect(f?.properties["transition.rect"]).toBe("0=0 0 1080 1920 1;-1~=50 50 540 960 0%");
      expect(f?.shotcutName).toBe("sizePosition");
    }
  });

  it("keeps an audio track via hide=video and a video track without it", () => {
    const tl = fromMlt(
      doc(
        '  <producer id="v0" in="0" out="9"><property name="resource">/abs/a.mp4</property></producer>',
        '  <producer id="a0" in="0" out="9"><property name="resource">/abs/vo.wav</property></producer>',
        '  <playlist id="pV1"><entry producer="v0" in="0" out="9"/></playlist>',
        '  <playlist id="pA1"><entry producer="a0" in="0" out="9"/></playlist>',
        '  <tractor id="tractor0">',
        '    <track producer="pV1"/>',
        '    <track producer="pA1" hide="video"/>',
        "  </tractor>",
      ),
    );
    expect(tl.tracks.video).toHaveLength(1);
    expect(tl.tracks.audio).toHaveLength(1);
  });
});

// The strongest contract: `fromMlt` is the exact inverse of `toMlt`. Serialize an
// IR, parse it back, re-serialize — the two XML strings must be BYTE-IDENTICAL.
// Determinism + semantic-equality in one assertion, guarded as a golden. (This
// exercises the LIVE serializer, so it co-locks the two halves of the round-trip.)
describe("round-trip with serialize (byte-identical)", () => {
  function roundtrips(build: () => ReturnType<typeof timeline>): void {
    resetIds();
    const xml1 = toMlt(build());
    const back = fromMlt(xml1);
    const xml2 = toMlt(back);
    expect(xml2).toBe(xml1);
  }

  it("color dissolve + overlay track + audio gain + cross-track qtblend", () => {
    roundtrips(() =>
      timeline(
        VERTICAL,
        {
          video: [
            videoTrack(colorClip(45, "black", { fadeIn: 12 }), dissolve(20), colorClip(60, "gold")),
            videoTrack(clip("/abs/overlay.mp4", { dur: 60 })),
          ],
          audio: [audioTrack(clip("/abs/vo.wav", { dur: 125, gain: 0.8 }))],
        },
        { transitions: [transition("qtblend", 1, 2, 0, 59)] },
      ),
    );
  });

  it("file-clip dissolve preserves contiguous source windows", () => {
    roundtrips(() =>
      timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/a.mp4", { in: 100, out: 199 }),
            dissolve(30),
            clip("/b.mp4", { dur: 90 }),
          ),
        ],
      }),
    );
  });

  // MIXED dissolves — a length-bearing clip (color, source `length` = playtime)
  // dissolving with a non-length-bearing one (file, melt probes `length`). These
  // exercise the dissolve recovery's length-preservation directly: the recovered
  // producer must carry the OUTGOING clip's original source length, not the cut-
  // window length, or the re-emitted tail/head producer's `<property name=
  // "length">` diverges (the byte-identical contract breaks).
  it("color→file dissolve preserves the color clip's source length across the tail cut", () => {
    roundtrips(() =>
      timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(45, "black", { fadeIn: 12 }),
            dissolve(20),
            clip("/a.mp4", { dur: 60 }),
          ),
        ],
      }),
    );
  });

  it("file→color dissolve preserves the color clip's source length across the head cut", () => {
    roundtrips(() =>
      timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/a.mp4", { in: 100, out: 199 }),
            dissolve(20),
            colorClip(60, "gold", { fadeOut: 15 }),
          ),
        ],
      }),
    );
  });

  it("blanks, a fadeOut, and a plain windowed clip", () => {
    roundtrips(() =>
      timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(40, "black"),
            clip("/x.mp4", { dur: 50, fadeOut: 15 }),
            clip("/solo.mp4", { in: 20, out: 74 }),
          ),
        ],
      }),
    );
  });
});

describe("validation", () => {
  it("throws on a document with no <mlt> root", () => {
    expect(() => fromMlt("<not-mlt/>")).toThrow(/<mlt>/);
  });
  it("produces a schema-valid Timeline (timelineSchema.parse succeeds inside)", () => {
    // If parse returned an invalid IR, fromMlt would have thrown in zod.
    const tl = fromMlt(
      doc(
        '  <producer id="A" in="0" out="9"><property name="mlt_service">color</property><property name="resource">#FF000000</property><property name="length">10</property></producer>',
        '  <playlist id="playlist0"><entry producer="A" in="0" out="9"/></playlist>',
        '  <tractor id="tractor0"><track producer="playlist0"/></tractor>',
      ),
    );
    expect(must(must(tl.tracks.video[0], "video track 0").items[0], "item 0").kind).toBe("clip");
  });
});
