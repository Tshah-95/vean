// The keyframe model — the typed representation of an MLT animation string, and
// the byte-faithful round-trip between the two. This file owns ONE risky format
// contract: MLT property strings like `"0=100;50~=0;-1|=50%"`. Get this wrong
// and a render silently mis-animates rather than erroring, so it is golden-tested
// before anything stacks on it.
//
// THIS IS A MOVE-0 STUB. The signatures and the typed model below are FINAL —
// parallel build agents fill the two function bodies and nothing else. Do not
// change the exported shapes.
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
export type KeyframeValue = NumberValue | RectValue | ColorValue;

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
): { frame: number; negative?: boolean; timecode?: boolean } {
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
      // HH:MM:SS:FF — FF is a literal frame index.
      frames = (hh * 3600 + mm * 60 + ss) * fps + Number(frac);
    } else {
      // HH:MM:SS.mmm — fractional seconds (millis as written) → frames.
      const millis = Number(`0.${frac}`);
      frames = Math.round((hh * 3600 + mm * 60 + ss + millis) * fps);
    }
    return { frame: frames, timecode: true };
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
    const totalSeconds = rebased / f;
    const hh = Math.floor(totalSeconds / 3600);
    const mm = Math.floor((totalSeconds % 3600) / 60);
    const whole = Math.floor(totalSeconds);
    const ss = whole % 60;
    const millis = Math.round((totalSeconds - whole) * 1000);
    const pad = (v: number, w: number) => String(v).padStart(w, "0");
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

/** A scalar is percent-flagged iff it ends in `%`. The numeric model holds the
 *  divided-by-100 value; the `%` is re-emitted on serialize (the flag preserves
 *  it). Returns the parsed number and whether a `%` was present. */
function parseScalar(raw: string): { value: number; percent: boolean } {
  if (raw.endsWith("%")) {
    const body = raw.slice(0, -1);
    const n = Number(body);
    if (!Number.isFinite(n)) throw new Error(`vean: malformed percent value "${raw}"`);
    return { value: n / 100, percent: true };
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`vean: malformed numeric value "${raw}"`);
  return { value: n, percent: false };
}

function formatScalar(value: number, percent: boolean): string {
  if (percent) return `${fmtNum(value * 100)}%`;
  return fmtNum(value);
}

/** Parse a value token into a typed `KeyframeValue`. Tries color (`#…`), then
 *  rect (5 whitespace-separated components: `x y w h opacity`), then scalar. */
function parseValue(raw: string): KeyframeValue {
  const color = parseColor(raw);
  if (color) return color;

  const parts = raw.split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 5) {
    // rect — opacity may carry a percent; x/y/w/h are plain numbers.
    const [xs, ys, ws, hs, os] = parts as [string, string, string, string, string];
    const op = parseScalar(os);
    const num = (p: string) => {
      const v = Number(p);
      if (!Number.isFinite(v)) throw new Error(`vean: malformed rect component "${p}"`);
      return v;
    };
    return {
      type: "rect",
      x: num(xs),
      y: num(ys),
      w: num(ws),
      h: num(hs),
      opacity: op.value,
      opacityPercent: op.percent || undefined,
    };
  }

  const sc = parseScalar(raw);
  const nv: NumberValue = { type: "number", value: sc.value };
  if (sc.percent) nv.percent = true;
  return nv;
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
    if (t.timecode) kf.timecode = true;
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
