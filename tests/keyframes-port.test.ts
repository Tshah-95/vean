import { describe, expect, it } from "vitest";
// The CORE engine (Move-1, source of truth) and the BROWSER PORT side-by-side.
import * as core from "../src/ir/keyframes";
// The viewer is a separate Vite app excluded from the root tsconfig's typecheck,
// but it is a pure ESM module with no Node/DOM deps, so vitest (running under Bun)
// imports and exercises it directly here. This is the byte-for-byte gate.
import * as port from "../viewer/src/keyframes";
import { EVAL_VECTORS, ROUND_TRIP_VECTORS } from "./keyframe-vectors";

// DESIGN-LIVE-PREVIEW.md §9 step 1: the ported resolver must match the existing
// keyframe golden tests byte-for-byte. This suite IS that gate. It proves three
// things, all over the SHARED vectors (tests/keyframe-vectors.ts):
//
//   1. byte identity — the port serializes every canonical string back to itself
//      (the same contract tests/keyframes.test.ts holds the core engine to);
//   2. parse parity — port.parseAnim deep-equals core.parseAnim for every vector;
//   3. eval parity — port.valueAtFrame / port.scalarOf deep-equal the core engine
//      at every evaluation frame (the interpolation math that gates preview
//      fidelity — a fade ramp that interpolates even slightly differently in the
//      browser would desync preview from export, §4 step 3 / §8.1).
//
// If anyone edits one engine and not the other, this fails — that is the point.

describe("keyframe port: byte identity (port round-trips its own goldens)", () => {
  for (const v of ROUND_TRIP_VECTORS) {
    it(v.name, () => {
      const model = port.parseAnim(v.s, v.opts);
      expect(port.serializeAnim(model, v.opts)).toBe(v.s);
    });
  }
});

describe("keyframe port: parse parity (port === core, structurally)", () => {
  for (const v of ROUND_TRIP_VECTORS) {
    it(v.name, () => {
      // The two engines' parsed models must be byte-for-byte structurally equal —
      // same valueType, same `static`, and every keyframe's frame/value/interp/
      // flag fields identical. `toEqual` is a deep value compare.
      const fromCore = core.parseAnim(v.s, v.opts);
      const fromPort = port.parseAnim(v.s, v.opts);
      expect(fromPort).toEqual(fromCore);
      // And the serialized forms must match each other (and the canonical string).
      expect(port.serializeAnim(fromPort, v.opts)).toBe(core.serializeAnim(fromCore, v.opts));
    });
  }
});

describe("keyframe port: eval parity (valueAtFrame + scalarOf, frame-by-frame)", () => {
  for (const v of EVAL_VECTORS) {
    it(v.name, () => {
      const coreModel = core.parseAnim(v.s, v.parseOpts);
      const portModel = port.parseAnim(v.s, v.parseOpts);
      // Models already parse-equal (covered above) but assert here too so an eval
      // failure isn't masked by a parse divergence.
      expect(portModel).toEqual(coreModel);

      for (const frame of v.frames) {
        const coreVal = core.valueAtFrame(coreModel, frame, v.evalOpts);
        const portVal = port.valueAtFrame(portModel, frame, v.evalOpts);
        // Deep-equal the resolved KeyframeValue at this frame in both engines.
        expect(portVal, `valueAtFrame @${frame} (${v.name})`).toEqual(coreVal);

        // And the scalar readout the compositor uses for RGB-multiply / opacity.
        const coreScalar = coreVal === null ? null : core.scalarOf(coreVal);
        const portScalar = portVal === null ? null : port.scalarOf(portVal);
        expect(portScalar, `scalarOf @${frame} (${v.name})`).toBe(coreScalar);
      }
    });
  }
});

// A focused mirror of the EXISTING tests/keyframes.test.ts golden assertions,
// re-run through the PORT, so the port is explicitly held to the very same byte
// goldens the core engine is — not just "equal to core" but "equal to the
// canonical strings the Move-1 suite already locked."
describe("keyframe port: the existing Move-1 goldens, byte-for-byte through the port", () => {
  const portGolden = (s: string, opts?: { fps?: [number, number] }) => {
    const model = port.parseAnim(s, opts);
    expect(port.serializeAnim(model, opts)).toBe(s);
    return model;
  };

  it("isAnimated discriminator matches", () => {
    for (const s of ["100", "50%", "#ff0000", "0=100", "0=0;11=1"]) {
      expect(port.isAnimated(s)).toBe(core.isAnimated(s));
    }
  });

  it("static vs 1-keyframe animation", () => {
    expect(port.parseAnim("100").static).toBe(true);
    expect(port.parseAnim("0=100").static).toBe(false);
    expect(port.serializeAnim(port.parseAnim("100"))).toBe("100");
    expect(port.serializeAnim(port.parseAnim("0=100"))).toBe("0=100");
  });

  it("'!' normalizes to '|' on serialize (discrete canonicalization)", () => {
    expect(port.parseAnim("5!=1").keyframes[0]?.interp).toBe("discrete");
    expect(port.serializeAnim(port.parseAnim("5!=1"))).toBe("5|=1");
  });

  it("'>' and '<' collapse to linear and drop the char", () => {
    expect(port.parseAnim("5>=1").keyframes[0]?.interp).toBe("linear");
    expect(port.serializeAnim(port.parseAnim("5>=1"))).toBe("5=1");
    expect(port.serializeAnim(port.parseAnim("5<=1"))).toBe("5=1");
  });

  it(":FF timecode round-trips its :FF spelling; .mmm keeps its own", () => {
    portGolden("00:00:01:12=100;00:00:02:00=0", { fps: [25, 1] });
    expect(port.parseAnim("00:00:01:12=100", { fps: [25, 1] }).keyframes[0]?.timecodeSubform).toBe(
      ":ff",
    );
    expect(port.parseAnim("00:00:01.520=100", { fps: [25, 1] }).keyframes[0]?.timecodeSubform).toBe(
      ".mmm",
    );
  });

  it("color hex is lowercased canonically", () => {
    expect(port.serializeAnim(port.parseAnim("0=#FF0000"))).toBe("0=#ff0000");
  });

  it("re-base is a clean inverse (parse(in) then serialize(in) is identity)", () => {
    const s = "0=0;10~=1;48=1;59=0";
    expect(port.serializeAnim(port.parseAnim(s, { in: 20 }), { in: 20 })).toBe(s);
  });

  it("semantic identity: parse(serialize(model)) === model", () => {
    const original = port.parseAnim("0=0;10~=1;30|=50%;-1=0");
    const reparsed = port.parseAnim(port.serializeAnim(original));
    expect(reparsed).toEqual(original);
    // And it equals the core engine's model for the same string.
    expect(original).toEqual(core.parseAnim("0=0;10~=1;30|=50%;-1=0"));
  });

  it("empty model evaluates to null (no fabricated 0)", () => {
    const m = port.parseAnim("");
    expect(m.keyframes).toHaveLength(0);
    expect(port.valueAtFrame(m, 0)).toBeNull();
    expect(port.valueAtFrame(m, 0)).toEqual(core.valueAtFrame(core.parseAnim(""), 0));
  });
});
