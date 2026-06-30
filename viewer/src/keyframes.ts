// The keyframe resolver — a browser PORT of vean's core `src/ir/keyframes.ts`.
//
// WHY a port and not an import: the viewer is a standalone web app with NO import
// into the core (see `viewer/src/types.ts` header, and the root `tsconfig.json`
// `exclude: ["viewer"]`). The live-preview compositor (DESIGN-LIVE-PREVIEW.md §4
// step 3) must resolve animated MLT properties — `"0=100;50~=0"` — to a concrete
// value at a frame, and that interpolation MUST be byte-faithful to the Move-1
// engine: "a fade ramp that interpolates even slightly differently in the browser
// desyncs the preview from the export" (§4 step 3, §8.1). So this file mirrors the
// core engine exactly, and `tests/keyframes-port.test.ts` runs the SAME golden
// vectors through BOTH implementations and asserts deep-equal output — the
// byte-for-byte gate that keeps this port from drifting (DESIGN §9 step 1).
//
// This is a pure module: no Node, no DOM, no network — only `ImageBitmap`-free
// math, so it bundles cleanly into a Vite worker for the decode/composite path.
//
// PORT DISCIPLINE: keep this a line-faithful mirror of `src/ir/keyframes.ts`. When
// the core engine changes, change this in lockstep and let the cross-check test
// catch any divergence. Do NOT "improve" only one side.
//
// ── MLT animation-string grammar (the spec the implementation must honor) ──
//
//  • A property is ANIMATED iff its string contains `=`. `"100"` is static;
//    `"0=100"` is a 1-keyframe animation. (`isAnimated` encodes this exactly.)
//  • Items are separated by `;`. Each item is `<time><marker?>=<value>`.
//  • time = an integer frame, OR a timecode (`HH:MM:SS.mmm` or `HH:MM:SS:FF`),
//    OR a negative int (`-1` = length-1).
//  • marker = the single NON-DIGIT char immediately before `=`. A digit before
//    `=` means NO marker ⇒ linear (the default). Markers:
//        `|` and `!`  → discrete / hold
//        `~`          → smooth (Catmull-Rom)
//        `$`          → smooth_natural
//        `-`          → smooth_tight
//        `a`..`D`     → Penner easings
//        unknown char → linear
//    `>` and `<` are NOT markers in MLT 7.
//  • value forms: a number; a percent value `"50%"` reads as 0.5 (trailing `%`
//    divides by 100 but is PRESERVED in the serialized string); a rect
//    `"x y w h opacity"` (interpolated component-wise); a color `"#rrggbb"` or
//    `"#aarrggbb"` (interpolated per channel).
//  • On SERIALIZE: frames are RE-BASED to the clip in-point; any value containing
//    `;` or `=` is quoted; canonical marker chars are emitted; decimals are
//    dot-decimal (LC_NUMERIC=C).

// ─── Interpolation kinds ───────────────────────────────────────────────────
/** The interpolation applied as the animation LEAVES a keyframe toward the next.
 *  `linear` is the unmarked default. The Penner family collapses to `penner`
 *  here with the original marker char preserved on the keyframe (`pennerChar`)
 *  so an exotic easing round-trips byte-faithfully without enumerating all 30+. */
export type Interp =
  | "linear"
  | "discrete" // `|` or `!`
  | "smooth" // `~` Catmull-Rom
  | "smooth_natural" // `$`
  | "smooth_tight" // `-`
  | "penner"; // a..D — exact char carried on the keyframe

/** The canonical marker char emitted for each interp on serialize. `linear`
 *  emits nothing; `discrete` canonicalizes to `|` (not `!`); `penner` re-emits
 *  the keyframe's preserved `pennerChar`. */
export const CANONICAL_MARKER: Record<Exclude<Interp, "linear" | "penner">, string> = {
  discrete: "|",
  smooth: "~",
  smooth_natural: "$",
  smooth_tight: "-",
};

// ─── Value model ─────────────────────────────────────────────────────────
/** A scalar value, optionally percent-flagged. `percent` preserves the trailing
 *  `%` on serialize even though `value` is already the divided-by-100 number. */
export type NumberValue = { type: "number"; value: number; percent?: boolean };
/** `x y w h opacity` — interpolated component-wise. `opacity` may be percent. */
export type RectValue = {
  type: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  opacity: number;
  opacityPercent?: boolean;
};
/** `#rrggbb` or `#aarrggbb` — interpolated per channel. `hasAlpha` controls the
 *  serialized form (6 vs 8 hex digits). Channels are 0..255 ints. */
export type ColorValue = {
  type: "color";
  a: number;
  r: number;
  g: number;
  b: number;
  hasAlpha: boolean;
};
/** A value that is neither a number, rect, nor color: an empty body (`0=`), a
 *  text token (`0=normal`), or any string a strict parse can't reduce — carried
 *  VERBATIM so it round-trips byte-faithfully. This is the total-ing member of the
 *  union: with it, `parseValue` can never throw on a legal-but-exotic property, so
 *  no compositor resolve can crash on a clip carrying a text-valued animated
 *  filter. `serializeAnim` re-quotes an opaque whose `raw` contains a `;` or `=`
 *  so the tokenizer recovers it intact. */
export type OpaqueValue = { type: "opaque"; raw: string };
export type KeyframeValue = NumberValue | RectValue | ColorValue | OpaqueValue;

// ─── Keyframe + model ──────────────────────────────────────────────────────
/** One keyframe: a frame time, a value, and the interp LEAVING it. `frame` is in
 *  ABSOLUTE (un-rebased) space within the model; serialize re-bases to `in`.
 *  `negative` marks a frame authored as a negative/relative time (e.g. `-1`),
 *  preserved so it round-trips as written rather than being resolved early. */
export type Keyframe = {
  frame: number;
  value: KeyframeValue;
  interp: Interp;
  /** The original `a`..`D` char when `interp === "penner"`. */
  pennerChar?: string;
  /** True if the time was authored as a negative/relative frame. */
  negative?: boolean;
  /** True if the time was authored as a timecode (HH:MM:SS.mmm | :FF). */
  timecode?: boolean;
  /** The timecode SUB-FORM, when `timecode` is set: `":ff"` for the frame-exact
   *  `HH:MM:SS:FF` spelling, `".mmm"` for the millisecond `HH:MM:SS.mmm` spelling.
   *  Recorded on parse so serialize reproduces the EXACT authored form rather than
   *  always emitting `.mmm`. `:ff` is frame-exact — it carries no sub-millisecond
   *  rounding drift, so a frame-aligned timecode authored as `:ff` round-trips
   *  losslessly. Absent ⇒ `.mmm` (back-compat). */
  timecodeSubform?: ":ff" | ".mmm";
};

/** The parsed animation: the kind of value it carries + its ordered keyframes.
 *  A non-animated property is represented by `parseAnim` returning a single
 *  keyframe at frame 0 with `static: true` so a refactor can distinguish
 *  `"100"` from `"0=100"` and serialize back to the right (un-keyed) form. */
export type Keyframes = {
  /** Discriminates the value family for whole-model interpolation. */
  valueType: KeyframeValue["type"];
  /** True if the source string had NO `=` (a bare static value). */
  static: boolean;
  keyframes: Keyframe[];
};

// ─── Options ───────────────────────────────────────────────────────────────
export type ParseOpts = {
  /** The clip in-point parse should treat as origin when interpreting any
   *  rebased input. Default 0 (absolute frames). */
  in?: number;
  /** fps `[num,den]`, needed to resolve `HH:MM:SS:FF` timecodes to frames. */
  fps?: [number, number];
  /** Source length, needed to resolve negative/relative frames (`-1` → len-1). */
  length?: number;
};

export type SerializeOpts = {
  /** Re-base every keyframe frame by subtracting `in` (the proven anchoring:
   *  keyframes are emitted relative to the played window's start). Default 0. */
  in?: number;
  /** fps `[num,den]` — only used if any keyframe is emitted as a timecode. */
  fps?: [number, number];
};

// ─── The animated/static discriminator (FINAL — pure, implemented) ─────────
/** A property string is an MLT animation iff it contains an `=`. This single
 *  rule is load-bearing across parse/serialize, so it lives here implemented
 *  (not stubbed) and is the one piece both bodies build on. */
export function isAnimated(s: string): boolean {
  return s.includes("=");
}

/** Migrate every comma-decimal numeric token in an animation string to a dot
 *  decimal, leaving the `;`/`=`/marker/space structure and every non-numeric
 *  token (colors, paths) byte-identical. The parser calls this on an animation
 *  property value before storing it, so a foreign-locale (`LC_NUMERIC=fr_FR`)
 *  file's `0=0,2;59=0,8` becomes `0=0.2;59=0.8` and renders correctly under the
 *  `C`-locale header vean re-emits — closing the silent mis-render where melt's
 *  `atof("0,2") == 0`. A comma is never structural inside an MLT animation value
 *  (items split on `;`, lhs/value on `=`, rect on spaces, colors are hex), so a
 *  comma strictly between two digits is unambiguously a decimal separator; an
 *  already-dot string is returned unchanged (idempotent), preserving byte
 *  round-trip for vean's own emissions. */
export function normalizeAnimDecimals(s: string): string {
  return s.replace(/(\d),(\d)/g, "$1.$2");
}

// ─── Marker ⇄ interp mapping ────────────────────────────────────────────────
// The marker is the single NON-DIGIT char immediately before `=`. The fixed
// punctuation markers map to a named interp; an alphabetic char is a Penner
// easing (preserved verbatim on the keyframe so the 30+ variants round-trip
// without enumeration); `>` / `<` and any other non-marker punctuation collapse
// to linear (MLT 7 does not treat them as markers).
const PUNCT_MARKER: Record<string, Interp> = {
  "|": "discrete",
  "!": "discrete",
  "~": "smooth",
  $: "smooth_natural",
  "-": "smooth_tight",
};

/** A Penner marker is a single ASCII letter (`a`..`z` or `A`..`D` in MLT, but we
 *  accept any ASCII letter and preserve it verbatim — an unrecognized letter
 *  still round-trips rather than silently degrading to linear). */
function isPennerChar(ch: string): boolean {
  return /^[A-Za-z]$/.test(ch);
}

/** Resolve a marker char to an interp + (for Penner) its preserved char.
 *  An empty marker, or a non-marker punctuation char like `>`/`<`, is linear. */
function markerToInterp(marker: string): { interp: Interp; pennerChar?: string } {
  if (marker === "") return { interp: "linear" };
  const punct = PUNCT_MARKER[marker];
  if (punct) return { interp: punct };
  if (isPennerChar(marker)) return { interp: "penner", pennerChar: marker };
  return { interp: "linear" }; // `>`, `<`, or any other char ⇒ linear
}

/** The canonical marker char emitted for a keyframe's interp (linear ⇒ ""). */
function interpToMarker(kf: Keyframe): string {
  if (kf.interp === "linear") return "";
  if (kf.interp === "penner") return kf.pennerChar ?? "";
  return CANONICAL_MARKER[kf.interp];
}

// ─── Time parsing/formatting ─────────────────────────────────────────────────
const TIMECODE = /^(\d{1,}):(\d{2}):(\d{2})([.:])(\d{1,})$/;

/** Round a frame rate `[num,den]` to the nearest whole FPS for SS:FF timecode
 *  math (FF is a frame index 0..fps-1). Defaults to 25 if no fps is supplied. */
function fpsRound(fps?: [number, number]): number {
  if (!fps) return 25;
  return Math.round(fps[0] / fps[1]);
}

/** Parse the time portion of a keyframe (the part before the marker) into an
 *  absolute frame plus flags describing HOW it was authored, so serialize can
 *  reproduce the exact spelling. `length`/`fps` resolve negatives/timecodes. */
function parseTime(
  raw: string,
  opts: ParseOpts,
): { frame: number; negative?: boolean; timecode?: boolean; timecodeSubform?: ":ff" | ".mmm" } {
  const tc = raw.match(TIMECODE);
  if (tc) {
    const hh = Number(tc[1]);
    const mm = Number(tc[2]);
    const ss = Number(tc[3]);
    const sep = tc[4];
    const frac = tc[5] as string;
    const fps = fpsRound(opts.fps);
    let frames: number;
    if (sep === ":") {
      // HH:MM:SS:FF — FF is a literal frame index. Frame-exact, no ms rounding.
      frames = (hh * 3600 + mm * 60 + ss) * fps + Number(frac);
      return { frame: frames, timecode: true, timecodeSubform: ":ff" };
    }
    // HH:MM:SS.mmm — fractional seconds (millis as written) → frames.
    const millis = Number(`0.${frac}`);
    frames = Math.round((hh * 3600 + mm * 60 + ss + millis) * fps);
    return { frame: frames, timecode: true, timecodeSubform: ".mmm" };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`vean: malformed keyframe time "${raw}"`);
  }
  if (n < 0) {
    // Negative/relative (`-1` = length-1). Per the model contract, negatives are
    // preserved AS WRITTEN ("round-trips as written rather than being resolved
    // early") — the raw negative is stored in `frame`; resolving it to an
    // absolute index against `length` is a consumer concern, not a parse one.
    return { frame: n, negative: true };
  }
  return { frame: n };
}

/** Format a keyframe's time back to its authored spelling. Negative frames are
 *  stored raw and emit as-is (re-base does not apply — they anchor to the source
 *  end); timecode frames render as `HH:MM:SS.mmm`; plain frames are integers. */
function formatTime(kf: Keyframe, rebased: number, fps?: [number, number]): string {
  if (kf.negative) return String(kf.frame);
  if (kf.timecode) {
    const f = fpsRound(fps);
    const pad = (v: number, w: number) => String(v).padStart(w, "0");
    if (kf.timecodeSubform === ":ff") {
      // HH:MM:SS:FF — frame-exact. Decompose the (rebased) absolute frame into
      // whole seconds + a frame index 0..f-1 with NO millisecond rounding, so a
      // frame-aligned timecode round-trips byte-identically (the `:ff` subform
      // avoids the lossy `.mmm` path entirely).
      const ff = ((rebased % f) + f) % f;
      const totalSec = Math.floor(rebased / f);
      const hh = Math.floor(totalSec / 3600);
      const mm = Math.floor((totalSec % 3600) / 60);
      const ss = totalSec % 60;
      return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}:${pad(ff, 2)}`;
    }
    // HH:MM:SS.mmm — millisecond spelling (the default sub-form).
    const totalSeconds = rebased / f;
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    const whole = Math.floor(totalSeconds);
    const ss = whole % 60;
    const millis = Math.round((totalSeconds - whole) * 1000);
    return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)}.${pad(millis, 3)}`;
  }
  return String(rebased);
}

// ─── Number formatting (LC_NUMERIC=C, dot decimal, no exponent) ──────────────
/** Stringify a number with a dot decimal and no trailing-zero/exponent noise.
 *  Integers print bare; fractions print their shortest round-trippable form. */
function fmtNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  // `String` already uses a dot and the shortest round-trip form in JS; it only
  // switches to exponent for extreme magnitudes, which keyframe values never hit.
  return String(n);
}

// ─── Decimal-separator migration (LC_NUMERIC: comma → dot) ────────────────────
/** Parse a numeric body accepting EITHER a dot OR a comma decimal separator. The
 *  comma form arrives from a foreign-locale `.mlt` (see `normalizeAnimDecimals`);
 *  we normalize it to a dot before `Number()` (which only accepts the dot form).
 *  Returns a finite number or `NaN` (the caller decides whether that's malformed). */
function numAcceptingComma(body: string): number {
  return Number(normalizeAnimDecimals(body));
}

// ─── Value parsing/formatting ────────────────────────────────────────────────
const COLOR6 = /^#([0-9a-fA-F]{6})$/;
const COLOR8 = /^#([0-9a-fA-F]{8})$/;

function parseColor(raw: string): ColorValue | null {
  const m6 = raw.match(COLOR6);
  if (m6) {
    const h = m6[1] as string;
    return {
      type: "color",
      a: 255,
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16),
      hasAlpha: false,
    };
  }
  const m8 = raw.match(COLOR8);
  if (m8) {
    const h = m8[1] as string;
    return {
      type: "color",
      a: Number.parseInt(h.slice(0, 2), 16),
      r: Number.parseInt(h.slice(2, 4), 16),
      g: Number.parseInt(h.slice(4, 6), 16),
      b: Number.parseInt(h.slice(6, 8), 16),
      hasAlpha: true,
    };
  }
  return null;
}

function formatColor(c: ColorValue): string {
  const hx = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return c.hasAlpha
    ? `#${hx(c.a)}${hx(c.r)}${hx(c.g)}${hx(c.b)}`
    : `#${hx(c.r)}${hx(c.g)}${hx(c.b)}`;
}

function formatScalar(value: number, percent: boolean): string {
  if (percent) return `${fmtNum(value * 100)}%`;
  return fmtNum(value);
}

/** A scalar a strict parse can reduce to a number (with optional `%`), or `null`
 *  when the token is not numeric (empty, text, or otherwise). Never throws — the
 *  caller falls back to the opaque family for a non-numeric token. */
function tryScalar(raw: string): { value: number; percent: boolean } | null {
  if (raw.endsWith("%")) {
    const n = numAcceptingComma(raw.slice(0, -1));
    return Number.isFinite(n) ? { value: n / 100, percent: true } : null;
  }
  // An empty body is NOT a number (`Number("") === 0` would fabricate a `0` the
  // property never carried). A non-numeric token is opaque, not a scalar.
  if (raw.trim() === "") return null;
  const n = numAcceptingComma(raw);
  return Number.isFinite(n) ? { value: n, percent: false } : null;
}

/** Parse a value token into a typed `KeyframeValue`. Tries color (`#…`), then
 *  rect (5 whitespace-separated numeric components: `x y w h opacity`), then
 *  scalar; anything else (empty `0=`, a text token `0=normal`, a value a strict
 *  parse can't reduce) becomes an OPAQUE value carried verbatim — `parseValue`
 *  NEVER throws, which is what makes the `KeyframeValue` union total. The raw
 *  passed here is already unquoted by the caller. */
function parseValue(raw: string): KeyframeValue {
  const color = parseColor(raw);
  if (color) return color;

  const parts = raw.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 5) {
    // A rect iff ALL five components are numeric (opacity may carry a percent);
    // otherwise it's an opaque token that happens to have five space-separated
    // words, kept verbatim rather than mis-parsed.
    const [xs, ys, ws, hs, os] = parts as [string, string, string, string, string];
    const op = tryScalar(os);
    const x = numAcceptingComma(xs);
    const y = numAcceptingComma(ys);
    const w = numAcceptingComma(ws);
    const h = numAcceptingComma(hs);
    if (
      op != null &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(w) &&
      Number.isFinite(h)
    ) {
      return {
        type: "rect",
        x,
        y,
        w,
        h,
        opacity: op.value,
        opacityPercent: op.percent || undefined,
      };
    }
  }

  const sc = tryScalar(raw);
  if (sc != null) {
    const nv: NumberValue = { type: "number", value: sc.value };
    if (sc.percent) nv.percent = true;
    return nv;
  }
  // Empty / text / un-reducible — carry it verbatim.
  return { type: "opaque", raw };
}

function formatValue(v: KeyframeValue): string {
  if (v.type === "color") return formatColor(v);
  if (v.type === "rect") {
    return [
      fmtNum(v.x),
      fmtNum(v.y),
      fmtNum(v.w),
      fmtNum(v.h),
      formatScalar(v.opacity, v.opacityPercent ?? false),
    ].join(" ");
  }
  if (v.type === "opaque") return v.raw;
  return formatScalar(v.value, v.percent ?? false);
}

// ─── Item tokenizer (quote-aware) ────────────────────────────────────────────
/** Split an animation string into items on `;`, honoring double-quoted values
 *  (a value that itself contains `;` or `=` is quoted on serialize). Quotes are
 *  consumed here; the value parser sees the un-quoted body. */
function splitItems(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (ch === ";" && !inQuote) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Split one item into its `time+marker` and `value` halves at the FIRST
 *  unquoted `=`. (The value may legally contain `=` only when it was quoted.) */
function splitItem(item: string): { lhs: string; value: string } {
  let inQuote = false;
  for (let i = 0; i < item.length; i++) {
    const ch = item[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "=" && !inQuote) {
      return { lhs: item.slice(0, i), value: item.slice(i + 1) };
    }
  }
  return { lhs: item, value: "" };
}

/** Strip surrounding double-quotes from a value token if present. */
function unquote(v: string): string {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1);
  return v;
}

// ─── parseAnim ───────────────────────────────────────────────────────────────
/** Parse an MLT property string into the typed keyframe model. Honors the full
 *  grammar above (markers, timecodes, negative frames, percent, rect, color).
 *  A non-animated string yields `{ static: true, keyframes: [<one kf@0>] }`. */
export function parseAnim(s: string, opts: ParseOpts = {}): Keyframes {
  // Empty (or whitespace-only) is a LEGAL, empty MLT property value — it carries
  // no keyframe and no value. Model it as a static-with-NO-keyframes so serialize
  // re-emits "" faithfully (parsing "" as a value would fabricate a `0` that was
  // never authored — a silent value invention on a blank property).
  if (s.trim() === "") {
    return { valueType: "number", static: true, keyframes: [] };
  }
  // Static: no `=` ⇒ a single keyframe at frame 0, flagged `static` so serialize
  // re-emits the bare value (not `0=value`).
  if (!isAnimated(s)) {
    const value = parseValue(s.trim());
    return {
      valueType: value.type,
      static: true,
      keyframes: [{ frame: 0, value, interp: "linear" }],
    };
  }

  const inn = opts.in ?? 0;
  const keyframes: Keyframe[] = [];
  for (const rawItem of splitItems(s)) {
    const item = rawItem.trim();
    if (item === "") continue; // tolerate a trailing/empty `;` segment
    const { lhs, value: rawValue } = splitItem(item);

    // The marker is the single non-digit char immediately before `=`. Peel it
    // off the END of the lhs; what remains is the (possibly timecode) time.
    let timeStr = lhs;
    let marker = "";
    const last = lhs[lhs.length - 1];
    if (last !== undefined && !/[0-9]/.test(last)) {
      marker = last;
      timeStr = lhs.slice(0, -1);
    }
    const { interp, pennerChar } = markerToInterp(marker);
    const t = parseTime(timeStr, opts);
    // Re-base input that was authored relative to the played window back to
    // absolute model space (the inverse of serialize's re-base). Negative and
    // timecode frames anchor differently and are not shifted.
    const absFrame = t.negative || t.timecode ? t.frame : t.frame + inn;

    const value = parseValue(unquote(rawValue.trim()));
    const kf: Keyframe = { frame: absFrame, value, interp };
    if (pennerChar) kf.pennerChar = pennerChar;
    if (t.negative) kf.negative = true;
    if (t.timecode) {
      kf.timecode = true;
      if (t.timecodeSubform) kf.timecodeSubform = t.timecodeSubform;
    }
    keyframes.push(kf);
  }

  const first = keyframes[0];
  const valueType: KeyframeValue["type"] = first ? first.value.type : "number";
  return { valueType, static: false, keyframes };
}

// ─── serializeAnim ───────────────────────────────────────────────────────────
/** Serialize the typed keyframe model back to an MLT property string. Re-bases
 *  to `opts.in`, emits canonical marker chars, preserves `%`, quotes any value
 *  containing `;` or `=`, dot-decimals throughout. Round-trips byte-faithfully
 *  with `parseAnim`. */
export function serializeAnim(model: Keyframes, opts: SerializeOpts = {}): string {
  const first = model.keyframes[0];
  // A static model is a bare value, no time/`=` — the inverse of the static
  // branch in parseAnim.
  if (model.static) {
    return first ? formatValue(first.value) : "";
  }

  const inn = opts.in ?? 0;
  const items: string[] = [];
  for (const kf of model.keyframes) {
    // Re-base absolute frames to the played window's start; negative/timecode
    // frames anchor independently (handled inside formatTime).
    const rebased = kf.negative || kf.timecode ? kf.frame : kf.frame - inn;
    const timeStr = formatTime(kf, rebased, opts.fps);
    const marker = interpToMarker(kf);
    let value = formatValue(kf.value);
    // Quote any value containing `;` or `=` so the tokenizer recovers it intact.
    if (value.includes(";") || value.includes("=")) value = `"${value}"`;
    items.push(`${timeStr}${marker}=${value}`);
  }
  return items.join(";");
}

// ─── valueAtFrame — evaluate the model at a frame (the resolver's engine) ─────
/** The keyframe whose value family the model carries, with its effective ABSOLUTE
 *  frame resolved (a negative `-1` becomes `length-1`). `frame` is already absolute
 *  in the model; we only need to resolve a keyframe's relative/negative authoring. */
export type EvalOpts = {
  /** Source length (frames), to resolve a negative keyframe time (`-1` → len-1). */
  length?: number;
};

/** Resolve a keyframe's effective absolute frame: a negative/relative time anchors
 *  to the source end (`-1` = `length-1`, `-2` = `length-2`, …). Everything else is
 *  already absolute. Without a `length`, a negative frame stays as authored (its
 *  ordering against positive frames is then undefined, so the evaluator treats it
 *  as the first/last by position — see `valueAtFrame`). */
function effectiveFrame(kf: Keyframe, length?: number): number {
  if (kf.negative && length != null) return length + kf.frame; // length + (-1) = length-1
  return kf.frame;
}

/** Linear interpolation of two numbers at parameter `t` ∈ [0,1]. */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Catmull-Rom interpolation of `p1`→`p2` at `t`, with neighbours `p0`/`p3` for
 *  the tangents (MLT's `~` smooth). Falls back to the endpoints when a neighbour is
 *  missing (clamped tangent), which matches melt clamping at the curve ends. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** Interpolate a single numeric channel between two keyframes at fraction `t`,
 *  honoring the LEFT keyframe's interp:
 *   • `discrete` → hold the left value (no interpolation),
 *   • `smooth`/`smooth_natural`/`smooth_tight` → Catmull-Rom (the `~` family),
 *   • `penner` → approximated by linear (the exact Penner easing is melt-internal;
 *     the resolver reports the effective value and labels the approximation),
 *   • `linear` (and any unknown) → straight lerp.
 *  `prev`/`next2` are the values of the keyframes flanking [left,right] for the
 *  Catmull-Rom tangents (default to the segment endpoints when absent). */
function interpChannel(
  left: number,
  right: number,
  t: number,
  interp: Interp,
  prev = left,
  next2 = right,
): number {
  if (interp === "discrete") return left;
  if (interp === "smooth" || interp === "smooth_natural" || interp === "smooth_tight") {
    return catmullRom(prev, left, right, next2, t);
  }
  return lerp(left, right, t); // linear + penner (documented approximation)
}

/** Pull the numeric channels out of a value for component-wise interpolation. A
 *  rect is `[x,y,w,h,opacity]`; a color `[a,r,g,b]`; a number `[value]`. An opaque
 *  value has no channels (returns `null` — it can't be interpolated; the evaluator
 *  holds it). */
function channelsOf(v: KeyframeValue): number[] | null {
  if (v.type === "number") return [v.value];
  if (v.type === "rect") return [v.x, v.y, v.w, v.h, v.opacity];
  if (v.type === "color") return [v.a, v.r, v.g, v.b];
  return null; // opaque
}

/** Rebuild a value of the same family from interpolated channels (the inverse of
 *  `channelsOf`), preserving the percent/alpha flags from `ref`. */
function valueFromChannels(ref: KeyframeValue, ch: number[]): KeyframeValue {
  if (ref.type === "number") {
    const nv: NumberValue = { type: "number", value: ch[0] as number };
    if (ref.percent) nv.percent = true;
    return nv;
  }
  if (ref.type === "rect") {
    const r: RectValue = {
      type: "rect",
      x: ch[0] as number,
      y: ch[1] as number,
      w: ch[2] as number,
      h: ch[3] as number,
      opacity: ch[4] as number,
    };
    if (ref.opacityPercent) r.opacityPercent = true;
    return r;
  }
  // color
  return {
    type: "color",
    a: Math.round(ch[0] as number),
    r: Math.round(ch[1] as number),
    g: Math.round(ch[2] as number),
    b: Math.round(ch[3] as number),
    hasAlpha: (ref as ColorValue).hasAlpha,
  };
}

/** The effective value of an animation model at an ABSOLUTE `frame` — the engine
 *  the compositor calls to resolve an animated property (DESIGN §4 step 3). Honors
 *  the full grammar: the interp markers (discrete hold / linear / Catmull-Rom
 *  smooth / Penner≈linear), percent + rect + color (interpolated COMPONENT-WISE),
 *  and negative/relative frames (resolved against `opts.length`). Clamps to the
 *  first keyframe before the range and the last keyframe after it (melt's edge
 *  behavior). A static model returns its single value; an empty model returns
 *  `null`. An opaque-valued keyframe can't be interpolated, so the evaluator HOLDS
 *  the left keyframe's opaque value across its segment. */
export function valueAtFrame(
  model: Keyframes,
  frame: number,
  opts: EvalOpts = {},
): KeyframeValue | null {
  const kfs = model.keyframes;
  if (kfs.length === 0) return null;
  if (model.static || kfs.length === 1) return (kfs[0] as Keyframe).value;

  // Sort by effective absolute frame so negative/relative times anchor correctly.
  const resolved = kfs
    .map((kf) => ({ kf, at: effectiveFrame(kf, opts.length) }))
    .sort((a, b) => a.at - b.at);

  const firstEntry = resolved[0] as { kf: Keyframe; at: number };
  const lastEntry = resolved[resolved.length - 1] as { kf: Keyframe; at: number };
  if (frame <= firstEntry.at) return firstEntry.kf.value; // clamp left
  if (frame >= lastEntry.at) return lastEntry.kf.value; // clamp right

  // Find the segment [left, right] containing `frame`.
  let i = 0;
  while (i < resolved.length - 1 && !(frame < (resolved[i + 1] as { at: number }).at)) i++;
  const leftE = resolved[i] as { kf: Keyframe; at: number };
  const rightE = resolved[i + 1] as { kf: Keyframe; at: number };
  const span = rightE.at - leftE.at;
  const t = span === 0 ? 0 : (frame - leftE.at) / span;

  const leftCh = channelsOf(leftE.kf.value);
  const rightCh = channelsOf(rightE.kf.value);
  // Opaque or mismatched families can't be interpolated — hold the left value.
  if (leftCh == null || rightCh == null || leftCh.length !== rightCh.length) {
    return leftE.kf.value;
  }
  const prevCh = channelsOf((resolved[i - 1]?.kf ?? leftE.kf).value) ?? leftCh;
  const next2Ch = channelsOf((resolved[i + 2]?.kf ?? rightE.kf).value) ?? rightCh;
  const out = leftCh.map((lv, c) =>
    interpChannel(
      lv,
      rightCh[c] as number,
      t,
      leftE.kf.interp,
      prevCh[c] ?? lv,
      next2Ch[c] ?? (rightCh[c] as number),
    ),
  );
  return valueFromChannels(leftE.kf.value, out);
}

/** The scalar magnitude of a value for a single-number readout (the common case a
 *  fade query or a per-clip RGB-multiply wants): a number's value, a rect's
 *  opacity, a color's alpha 0..1, an opaque → `null`. */
export function scalarOf(v: KeyframeValue): number | null {
  if (v.type === "number") return v.value;
  if (v.type === "rect") return v.opacity;
  if (v.type === "color") return v.a / 255;
  return null;
}
