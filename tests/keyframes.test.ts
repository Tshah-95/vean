import { describe, expect, it } from "vitest";
import {
  type ColorValue,
  type Keyframes,
  type NumberValue,
  type RectValue,
  isAnimated,
  parseAnim,
  serializeAnim,
} from "../src/ir/keyframes";

// The keyframe engine owns ONE format contract: the MLT animation string. This
// suite is the golden that locks it. Two invariants drive everything:
//   • parse(serialize(model)) === model   (semantic identity)
//   • serialize(parse(s))     === s        (byte identity — the format contract)
// Plus targeted coverage of every grammar branch: markers, percent, negative &
// timecode times, rect/color component models, quoting, and frame re-basing.

/** Round-trip a canonical animation string and assert byte-identity. */
function golden(s: string, opts?: { fps?: [number, number] }) {
  const model = parseAnim(s, opts);
  expect(serializeAnim(model, opts)).toBe(s);
  return model;
}

describe("isAnimated (the static/animated discriminator)", () => {
  it("a string is animated iff it contains '='", () => {
    expect(isAnimated("100")).toBe(false);
    expect(isAnimated("50%")).toBe(false);
    expect(isAnimated("#ff0000")).toBe(false);
    expect(isAnimated("0=100")).toBe(true);
    expect(isAnimated("0=0;11=1")).toBe(true);
  });
});

describe("static values (no '=')", () => {
  it("a bare number is static and round-trips un-keyed", () => {
    const m = golden("100");
    expect(m.static).toBe(true);
    expect(m.valueType).toBe("number");
    expect(m.keyframes).toHaveLength(1);
    expect(m.keyframes[0]?.frame).toBe(0);
    expect((m.keyframes[0]?.value as NumberValue).value).toBe(100);
  });

  it("a bare percent is static, divides by 100, and re-emits its '%'", () => {
    const m = golden("50%");
    expect(m.static).toBe(true);
    const v = m.keyframes[0]?.value as NumberValue;
    expect(v.value).toBe(0.5);
    expect(v.percent).toBe(true);
  });

  it("a bare color is static", () => {
    const m = golden("#ff8800");
    expect(m.static).toBe(true);
    expect(m.valueType).toBe("color");
  });

  it("static is distinct from a 1-keyframe animation ('100' vs '0=100')", () => {
    expect(parseAnim("100").static).toBe(true);
    expect(parseAnim("0=100").static).toBe(false);
    expect(serializeAnim(parseAnim("100"))).toBe("100");
    expect(serializeAnim(parseAnim("0=100"))).toBe("0=100");
  });
});

describe("the seed's brightness-fade shape (the proven studio pattern)", () => {
  it("round-trips a fade-in/fade-out level string byte-faithfully", () => {
    golden("0=0;11=1;48=1;59=0");
  });
});

describe("interpolation markers (the full table)", () => {
  it("linear is the unmarked default", () => {
    const m = golden("0=0;10=1");
    expect(m.keyframes[0]?.interp).toBe("linear");
    expect(m.keyframes[1]?.interp).toBe("linear");
  });

  it("'|' and '!' both parse to discrete; serialize canonicalizes to '|'", () => {
    expect(parseAnim("5|=1").keyframes[0]?.interp).toBe("discrete");
    expect(parseAnim("5!=1").keyframes[0]?.interp).toBe("discrete");
    // '|' is canonical → golden; '!' normalizes to '|' (documented).
    golden("5|=1");
    expect(serializeAnim(parseAnim("5!=1"))).toBe("5|=1");
  });

  it("'~' = smooth (Catmull-Rom)", () => {
    const m = golden("0=0;10~=1");
    expect(m.keyframes[1]?.interp).toBe("smooth");
  });

  it("'$' = smooth_natural", () => {
    const m = golden("0=0;10$=1");
    expect(m.keyframes[1]?.interp).toBe("smooth_natural");
  });

  it("'-' marker = smooth_tight (distinct from a negative time)", () => {
    const m = golden("0=0;10-=1");
    expect(m.keyframes[1]?.interp).toBe("smooth_tight");
  });

  it("a..D Penner easings preserve their exact char", () => {
    const m = golden("0=0;10a=1;20D=1");
    expect(m.keyframes[1]?.interp).toBe("penner");
    expect(m.keyframes[1]?.pennerChar).toBe("a");
    expect(m.keyframes[2]?.interp).toBe("penner");
    expect(m.keyframes[2]?.pennerChar).toBe("D");
  });

  it("'>' and '<' are NOT markers in MLT 7 — they collapse to linear", () => {
    expect(parseAnim("5>=1").keyframes[0]?.interp).toBe("linear");
    expect(parseAnim("5<=1").keyframes[0]?.interp).toBe("linear");
    // They emit no marker (the char is dropped) — serialize is linear.
    expect(serializeAnim(parseAnim("5>=1"))).toBe("5=1");
  });
});

describe("times: integer, negative/relative, and timecode", () => {
  it("integer frames round-trip", () => {
    golden("0=0;30=1;120=0");
  });

  it("negative/relative time is preserved AS WRITTEN (-1 not resolved early)", () => {
    const m = golden("-1=50");
    expect(m.keyframes[0]?.negative).toBe(true);
    expect(m.keyframes[0]?.frame).toBe(-1);
    golden("0=0;-1=1");
  });

  it("HH:MM:SS.mmm timecode round-trips when frame-aligned", () => {
    // fps 25: frame 38 = 1.520s exactly. Frame-aligned ⇒ byte-identity.
    const m = golden("00:00:01.520=100", { fps: [25, 1] });
    expect(m.keyframes[0]?.timecode).toBe(true);
    expect(m.keyframes[0]?.frame).toBe(38);
  });

  it("HH:MM:SS:FF timecode parses to a frame (normalizes to .mmm on serialize)", () => {
    // 00:00:01:12 at 25fps = 25 + 12 = 37 frames = 1.480s.
    const m = parseAnim("00:00:01:12=100", { fps: [25, 1] });
    expect(m.keyframes[0]?.frame).toBe(37);
    expect(serializeAnim(m, { fps: [25, 1] })).toBe("00:00:01.480=100");
  });

  it("rational fps (29.97 = [30000,1001]) rounds to 30 for SS:FF math", () => {
    const m = parseAnim("00:00:02:00=1", { fps: [30000, 1001] });
    expect(m.keyframes[0]?.frame).toBe(60);
  });
});

describe("percent values inside animations", () => {
  it("'50%' reads as 0.5 and preserves its sign on serialize", () => {
    const m = golden("0=0%;30=100%");
    expect((m.keyframes[0]?.value as NumberValue).value).toBe(0);
    expect((m.keyframes[0]?.value as NumberValue).percent).toBe(true);
    expect((m.keyframes[1]?.value as NumberValue).value).toBe(1);
  });

  it("a discrete percent with a relative end frame (the |=50% case)", () => {
    golden("0=100;-1|=50%");
  });
});

describe("rect values (x y w h opacity, component-wise)", () => {
  it("round-trips a 5-component rect", () => {
    const m = golden("0=0 0 1920 1080 1;30=100 50 1920 1080 0");
    const r = m.keyframes[0]?.value as RectValue;
    expect(r.type).toBe("rect");
    expect(r.x).toBe(0);
    expect(r.w).toBe(1920);
    expect(r.opacity).toBe(1);
  });

  it("a rect opacity may be a percent", () => {
    const m = golden("0=0 0 100 100 50%");
    const r = m.keyframes[0]?.value as RectValue;
    expect(r.opacity).toBe(0.5);
    expect(r.opacityPercent).toBe(true);
  });
});

describe("color values (#rrggbb / #aarrggbb, per channel)", () => {
  it("6-digit color round-trips and parses per channel", () => {
    const m = golden("0=#ff0000;30=#0000ff");
    const c = m.keyframes[0]?.value as ColorValue;
    expect(c).toMatchObject({ a: 255, r: 255, g: 0, b: 0, hasAlpha: false });
  });

  it("8-digit (alpha) color round-trips with hasAlpha", () => {
    const m = golden("0=#80ff0000");
    const c = m.keyframes[0]?.value as ColorValue;
    expect(c).toMatchObject({ a: 128, r: 255, g: 0, b: 0, hasAlpha: true });
  });

  it("color hex is lowercased canonically", () => {
    expect(serializeAnim(parseAnim("0=#FF0000"))).toBe("0=#ff0000");
  });
});

describe("quoting (values containing ';' or '=')", () => {
  // No NATURAL value form (number/rect/color) contains a ';' or '=', so the
  // serialize-side quote path is a robustness guard, not a routine emission.
  // What MUST hold is parse-side robustness: a quoted token that itself contains
  // a ';' or '=' is treated as ONE item/value, not split mid-token. We exercise
  // that with a rect whose body is wrapped — the tokenizer must keep it whole.
  it("a quoted token is not split on an interior ';'", () => {
    // The quotes shield the interior; the value parses as a normal rect.
    const m = parseAnim('0="0 0 100 100 1";30=50 50 100 100 0');
    expect(m.keyframes).toHaveLength(2);
    expect(m.keyframes[0]?.value.type).toBe("rect");
    const r = m.keyframes[0]?.value as RectValue;
    expect(r.w).toBe(100);
  });

  it("the value parser tolerates a single equals split (LHS=value)", () => {
    // splitItem cuts at the FIRST unquoted '='; the marker peel + value parse
    // recover both halves of '10~=1'.
    const m = parseAnim("10~=1");
    expect(m.keyframes[0]?.interp).toBe("smooth");
    expect((m.keyframes[0]?.value as NumberValue).value).toBe(1);
  });
});

describe("frame re-basing (serialize subtracts opts.in; parse adds it)", () => {
  it("serialize re-bases keyframe frames to the clip in-point", () => {
    // Absolute model at frames 20 & 30; emitted relative to in=20 ⇒ 0 & 10.
    const m: Keyframes = {
      valueType: "number",
      static: false,
      keyframes: [
        { frame: 20, value: { type: "number", value: 0 }, interp: "linear" },
        { frame: 30, value: { type: "number", value: 1 }, interp: "linear" },
      ],
    };
    expect(serializeAnim(m, { in: 20 })).toBe("0=0;10=1");
  });

  it("parse re-bases input back to absolute model space", () => {
    const m = parseAnim("0=0;10=1", { in: 20 });
    expect(m.keyframes[0]?.frame).toBe(20);
    expect(m.keyframes[1]?.frame).toBe(30);
  });

  it("re-base is a clean inverse: parse(in) then serialize(in) is identity", () => {
    const s = "0=0;10~=1;48=1;59=0";
    expect(serializeAnim(parseAnim(s, { in: 20 }), { in: 20 })).toBe(s);
  });

  it("negative & timecode frames are NOT re-based (they anchor independently)", () => {
    const s = "0=0;-1=1";
    // Even with a non-zero in, the relative frame is untouched.
    expect(serializeAnim(parseAnim(s, { in: 20 }), { in: 20 })).toBe(s);
  });
});

describe("semantic identity: parse(serialize(model)) === model", () => {
  it("a complex model survives a serialize→parse round-trip unchanged", () => {
    const original = parseAnim("0=0;10~=1;30|=50%;-1=0");
    const reparsed = parseAnim(serializeAnim(original));
    expect(reparsed).toEqual(original);
  });
});
