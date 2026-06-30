// Shared golden keyframe vectors — the SINGLE source of truth consumed by BOTH
// the core engine (`src/ir/keyframes.ts`) and the browser port
// (`viewer/src/keyframes.ts`), via `tests/keyframes-port.test.ts`.
//
// DESIGN-LIVE-PREVIEW.md §9 step 1 mandates the ported resolver "shares the Move-1
// golden vectors" and "matches the existing keyframe golden tests byte-for-byte."
// This module is that shared vector set. The cross-check test runs every vector
// through both implementations and asserts deep-equal output for parseAnim,
// serializeAnim, valueAtFrame, and scalarOf — so a single edit to one engine that
// drifts the other fails the gate.
//
// The vectors deliberately span every grammar branch the existing
// `tests/keyframes.test.ts` golden covers (static/animated, all interp markers,
// negative + timecode times, percent, rect, color, quoting, re-basing) PLUS the
// evaluation surface the compositor actually uses (valueAtFrame at interior /
// clamp / discrete-hold / smooth / penner frames, and scalarOf readouts).

/** fps used for the timecode vectors. */
export type Fps = [number, number];

/** One round-trip + parse-shape vector: a canonical MLT animation string that
 *  must survive `serializeAnim(parseAnim(s, opts), opts) === s` (byte identity)
 *  in BOTH engines. `opts.in` exercises re-basing; `opts.fps` exercises timecodes. */
export interface RoundTripVector {
  /** A human label for failure messages. */
  name: string;
  /** The canonical animation string (the golden byte form). */
  s: string;
  /** parse/serialize options (in for re-base, fps for timecode math). */
  opts?: { in?: number; fps?: Fps };
}

/** One evaluation vector: parse `s`, then evaluate at each `frame` and assert both
 *  engines return deep-equal `valueAtFrame` (and equal `scalarOf` of it). This is
 *  the interpolation-math parity that gates preview fidelity (§4 step 3, §8.1). */
export interface EvalVector {
  name: string;
  s: string;
  parseOpts?: { in?: number; fps?: Fps };
  evalOpts?: { length?: number };
  /** Absolute frames to evaluate at (interior, boundary, clamp-left, clamp-right). */
  frames: number[];
}

// ─── Round-trip / parse-shape golden vectors ────────────────────────────────
// Every string here is byte-canonical: it equals its own serialize(parse(...)).
// These mirror the existing tests/keyframes.test.ts `golden(...)` calls so the
// port is held to the SAME byte contract the core engine already passes.
export const ROUND_TRIP_VECTORS: RoundTripVector[] = [
  // static values (no '=')
  { name: "static number", s: "100" },
  { name: "static percent", s: "50%" },
  { name: "static color 6", s: "#ff8800" },
  { name: "static color 6 lower", s: "#ff0000" },
  { name: "one-keyframe animation", s: "0=100" },

  // the seed brightness-fade shape (the proven studio pattern)
  { name: "fade in/out level", s: "0=0;11=1;48=1;59=0" },

  // interpolation markers (the full table)
  { name: "linear default", s: "0=0;10=1" },
  { name: "discrete |", s: "5|=1" },
  { name: "smooth ~", s: "0=0;10~=1" },
  { name: "smooth_natural $", s: "0=0;10$=1" },
  { name: "smooth_tight -", s: "0=0;10-=1" },
  { name: "penner a and D", s: "0=0;10a=1;20D=1" },
  { name: "non-marker > collapses to linear", s: "5=1" },

  // times: integer, negative/relative, timecode
  { name: "integer frames", s: "0=0;30=1;120=0" },
  { name: "negative relative", s: "-1=50" },
  { name: "linear into relative end", s: "0=0;-1=1" },
  { name: "timecode .mmm frame-aligned", s: "00:00:01.520=100", opts: { fps: [25, 1] } },
  { name: "timecode :ff", s: "00:00:02:00=1", opts: { fps: [25, 1] } },
  { name: "timecode :ff pair", s: "00:00:01:12=100;00:00:02:00=0", opts: { fps: [25, 1] } },
  { name: "timecode :ff rational fps", s: "00:00:02:00=1", opts: { fps: [30000, 1001] } },

  // percent inside animations
  { name: "percent ramp", s: "0=0%;30=100%" },
  { name: "discrete percent relative end", s: "0=100;-1|=50%" },

  // rect values (x y w h opacity)
  { name: "rect ramp", s: "0=0 0 1920 1080 1;30=100 50 1920 1080 0" },
  { name: "rect percent opacity", s: "0=0 0 100 100 50%" },

  // color values
  { name: "color ramp", s: "0=#ff0000;30=#0000ff" },
  { name: "color 8 alpha", s: "0=#80ff0000" },

  // opaque (the 5 resolved gaps)
  { name: "empty value", s: "0=" },
  { name: "text value", s: "0=normal" },
  { name: "quoted ; opaque", s: '0="a;b"' },
  { name: "quoted = opaque", s: '0="x=y"' },
  { name: "edge-anchored ramp (not a fade)", s: "0=0;59=1" },

  // re-base (serialize subtracts opts.in; parse adds it)
  { name: "re-base smooth fade in=20", s: "0=0;10~=1;48=1;59=0", opts: { in: 20 } },
  { name: "re-base negative untouched in=20", s: "0=0;-1=1", opts: { in: 20 } },
];

// ─── Evaluation vectors (valueAtFrame + scalarOf parity) ────────────────────
// Each is evaluated at every listed absolute frame in BOTH engines; the resolved
// KeyframeValue and its scalarOf must be deep-equal. These hit every interp path
// (linear segment, discrete hold, Catmull-Rom smooth, penner≈linear), the clamp
// edges, rect/color component-wise interpolation, and negative-frame anchoring.
export const EVAL_VECTORS: EvalVector[] = [
  {
    name: "linear ramp interior + clamps",
    s: "0=0;10=1",
    frames: [-5, 0, 1, 3, 5, 7, 10, 15],
  },
  {
    name: "fade in/out level (interior of each segment)",
    s: "0=0;11=1;48=1;59=0",
    frames: [0, 5, 11, 30, 48, 54, 59, 70],
  },
  {
    name: "discrete hold (left value across the segment)",
    s: "0=0;5|=1;10=2",
    frames: [0, 2, 5, 7, 9, 10, 12],
  },
  {
    name: "smooth Catmull-Rom (needs neighbours for tangents)",
    s: "0=0;10~=10;20~=0;30~=10",
    frames: [0, 5, 10, 13, 15, 17, 20, 25, 30, 35],
  },
  {
    name: "penner approximates as linear",
    s: "0=0;10a=100",
    frames: [0, 2, 5, 8, 10, 12],
  },
  {
    name: "percent ramp evaluated",
    s: "0=0%;30=100%",
    frames: [0, 10, 15, 20, 30, 40],
  },
  {
    name: "rect component-wise interpolation",
    s: "0=0 0 1920 1080 1;30=300 150 1920 1080 0",
    frames: [0, 10, 15, 20, 30, 35],
  },
  {
    name: "color per-channel interpolation",
    s: "0=#ff0000;30=#0000ff",
    frames: [0, 10, 15, 20, 30, 35],
  },
  {
    name: "color 8 alpha per-channel",
    s: "0=#80ff0000;30=#ff00ff00",
    frames: [0, 15, 30],
  },
  {
    name: "negative frame anchored against length",
    s: "0=0;-1=100",
    evalOpts: { length: 50 },
    frames: [0, 24, 25, 49, 60],
  },
  {
    name: "opaque held across its segment (text → text)",
    s: "0=normal;30=add",
    frames: [0, 10, 15, 29, 30, 40],
  },
  {
    name: "mixed opaque + numeric is total (no throw)",
    s: "0=normal;30=1.5",
    frames: [0, 15, 30],
  },
  {
    name: "static value at any frame",
    s: "100",
    frames: [-10, 0, 5, 9999],
  },
  {
    name: "re-based fade evaluated in absolute model space (in=20)",
    s: "0=0;10~=1;48=1;59=0",
    parseOpts: { in: 20 },
    frames: [20, 25, 30, 68, 79, 90],
  },
];
