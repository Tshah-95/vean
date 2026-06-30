import { FADE_IN_SERVICE, FADE_OUT_SERVICE } from "../../ir/builder";
// Dial-range diagnostics — the "value out of the knob's published range" rule,
// checked against the typed DIAL CATALOG (`src/ir/dials/`, generated from
// `melt -query` + curated overrides). This is the diagnostics face of the dials
// schema: a clip filter (or field transition) that sets a knob OUTSIDE the range
// melt/Shotcut document for it — a brightness `level` of 30 where the service caps
// at 15, an opacity of 2 on a 0..1 dial — renders wrong (melt clamps silently) and
// is exactly the kind of "type error for video" the LSP surfaces. By code:
//
//   dial-out-of-range   a filter/transition property is outside its catalogued range
//
// ── The zero-false-positive contract (load-bearing) ─────────────────────────────
// A checker MUST emit ZERO diagnostics on a VALID timeline (the clean-corpus gate,
// tests/diagnostics-harness.test.ts iterates the registry). The dial check is held
// to it by being CONSERVATIVE on every axis:
//   • Only services IN the curated catalog are checked; an unknown service is
//     skipped (no schema ⇒ no bound to violate).
//   • Only `float`/`integer` SCALAR dials are range-checked; string/color/rect/
//     enum/properties dials are not numerically bounded here.
//   • A dial with an ABSENT bound on a side imposes NO limit there (one-sided dials
//     fire only on the bounded side; fully-unbounded dials never fire). An absent
//     bound is "no limit", never `0` — the catalog generator preserves this.
//   • A value that does not cleanly resolve to a number (a text/opaque keyframe, a
//     dB string like "-12dBFS") is NOT checked — it has no scalar to bound.
//   • Animated properties are resolved through the canonical keyframe engine
//     (`parseAnim`): EVERY keyframe value is checked (the peak/trough of an
//     animation is what melt clamps), with percent values read in their 0..1 form
//     against a 0..1 dial. Fade SENTINELS carry no keyframe string and are skipped.
//
// FINALIZED SIGNATURE. The exported `dials: Checker` is the stable contract the
// registry consumes; the registry auto-covers it against the clean corpus.
import { type Dial, checkScalar, getDial, getService, isScalarDial } from "../../ir/dials";
import { type KeyframeValue, isAnimated, parseAnim } from "../../ir/keyframes";
import type { Clip, Filter, Timeline, Track, Transition } from "../../ir/types";
import { type Checker, type Diagnostic, type DiagnosticInput, diag } from "../types";

/** Resolve a single property VALUE token to the scalar(s) the range check bounds.
 *  A static numeric value yields one scalar; an ANIMATED value yields one scalar
 *  PER keyframe (the whole envelope is checked — melt clamps at the extremes, so a
 *  single out-of-range keyframe is a real hazard even if the rest are in range). A
 *  value that isn't numeric on a given keyframe (opaque/text — a dB string, a mode
 *  word) contributes NO scalar (it has no bound to violate). Each scalar carries
 *  the frame it was authored at, for a precise message; a static value reports
 *  frame `null`. */
function resolveScalars(
  value: string,
  fps: [number, number],
  clip: Clip,
): Array<{ value: number; frame: number | null }> {
  if (!isAnimated(value)) {
    const n = parseStaticScalar(value);
    return n == null ? [] : [{ value: n, frame: null }];
  }
  const model = parseAnim(value, { fps, length: clip.length });
  const out: Array<{ value: number; frame: number | null }> = [];
  for (const kf of model.keyframes) {
    const s = scalarOfValue(kf.value);
    if (s != null) out.push({ value: s, frame: kf.negative ? null : kf.frame });
  }
  return out;
}

/** The scalar a static property string carries, or `null` when it isn't a plain
 *  number. Honors a trailing `%` (read as the 0..1 fraction, matching the keyframe
 *  engine's percent handling) so a `50%` opacity checks against a 0..1 dial. A
 *  unit-suffixed audio string (`-12dBFS`, `6dB`) is NOT a plain number and yields
 *  `null` — the dial check leaves dB string knobs alone (their "range" isn't a flat
 *  float bound). */
function parseStaticScalar(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  if (t.endsWith("%")) {
    const n = Number(t.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : null;
  }
  // Reject anything with a non-numeric suffix (dB strings, mode words): a clean
  // number consumes the WHOLE token, so `Number` finite AND the token is all-numeric.
  if (!/^[-+]?\d*\.?\d+([eE][-+]?\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The scalar magnitude of a typed keyframe value for the range check: a plain
 *  number's value (already %-divided by the engine), or `null` for rect/color/opaque
 *  values the range check doesn't single-number-bound. (A rect/color is
 *  multi-channel; its bounds belong to a future per-channel rule, not this scalar
 *  one — bounding a rect's opacity here would risk false positives on its x/y/w/h.) */
function scalarOfValue(v: KeyframeValue): number | null {
  return v.type === "number" ? v.value : null;
}

/** Check one service's properties against the catalog, emitting a diagnostic per
 *  property whose value escapes its dial's published/curated range. `locate`
 *  stamps the right `location` (clip+filter vs transition). Shared by the filter
 *  and transition paths so the rule lives once. */
function checkServiceProps(
  serviceId: string,
  properties: Record<string, string | number>,
  fps: [number, number],
  clip: Clip,
  locate: (dialId: string) => Diagnostic["location"],
  serviceLabel: string,
): DiagnosticInput[] {
  const svc = getService(serviceId);
  if (!svc) return []; // un-catalogued service — nothing to bound (conservative)
  const out: DiagnosticInput[] = [];
  for (const [key, raw] of Object.entries(properties)) {
    const dial = getDial(serviceId, key);
    if (!dial || !isScalarDial(dial)) continue; // unknown or non-scalar knob — skip
    if (dial.min == null && dial.max == null) continue; // unbounded dial — no limit
    for (const { value, frame } of resolveScalars(String(raw), fps, clip)) {
      const verdict = checkScalar(dial, value);
      if (verdict.ok) continue;
      out.push(dialDiagnostic(serviceId, serviceLabel, key, dial, verdict, frame, locate(key)));
      break; // one diagnostic per property is enough (the first violating sample)
    }
  }
  return out;
}

/** Build the `dial-out-of-range` diagnostic for one violating value, with a precise
 *  human message (which side, the limit, the unit) and machine `data`. `serviceId`
 *  is the MLT service the knob belongs to (e.g. `brightness`); `dialId` the
 *  property name (`level`). */
function dialDiagnostic(
  serviceId: string,
  serviceLabel: string,
  dialId: string,
  dial: Dial,
  verdict: { bound: "min" | "max"; limit: number; value: number },
  frame: number | null,
  location: Diagnostic["location"],
): DiagnosticInput {
  const unit = dial.unit ? ` ${dial.unit}` : "";
  const side = verdict.bound === "max" ? "exceeds maximum" : "is below minimum";
  const at = frame != null ? ` (at frame ${frame})` : "";
  return diag({
    code: "dial-out-of-range",
    severity: "warning",
    message: `${serviceLabel} ${dialId} = ${verdict.value}${at} ${side} ${verdict.limit}${unit} — melt clamps it, so the rendered value is not what the timeline says`,
    location,
    fix: `set ${dialId} within [${dial.min ?? "-∞"}, ${dial.max ?? "+∞"}]`,
    data: {
      service: serviceId,
      dial: dialId,
      value: verdict.value,
      bound: verdict.bound,
      limit: verdict.limit,
      ...(frame != null ? { frame } : {}),
    },
  });
}

/** All dial-range diagnostics for one clip's filters. Skips fade sentinels (they
 *  carry an integer `frames`, not a knob value, and compile to a known-good
 *  brightness/volume envelope). */
function checkClipFilters(clip: Clip, track: Track, fps: [number, number]): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  clip.filters.forEach((f: Filter, fi: number) => {
    if (f.service === FADE_IN_SERVICE || f.service === FADE_OUT_SERVICE) return; // sentinel
    out.push(
      ...checkServiceProps(
        f.service,
        f.properties,
        fps,
        clip,
        () => ({ clip: clip.id, track: track.id, filter: fi }),
        `clip "${clip.id}" filter ${f.service}`,
      ),
    );
  });
  return out;
}

/** A throwaway clip stand-in for a field transition (which has no source clip),
 *  giving `resolveScalars` a `length` slot for negative-frame resolution. A
 *  transition's keyframe values almost never use negative frames, but the helper
 *  needs the shape — `length` undefined leaves negatives unresolved, which the
 *  scalar path skips anyway (it reports `frame: null` for negatives). */
const TRANSITION_CLIP_STUB = { length: undefined } as unknown as Clip;

/** All dial-range diagnostics for the field-level (cross-track) transitions. */
function checkTransitions(transitions: Transition[], fps: [number, number]): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  transitions.forEach((t: Transition, ti: number) => {
    out.push(
      ...checkServiceProps(
        t.service,
        t.properties,
        fps,
        TRANSITION_CLIP_STUB,
        () => ({ transition: ti }),
        `transition ${t.service}`,
      ),
    );
  });
  return out;
}

// ─── The exported checker ───────────────────────────────────────────────────────
/** Range-check every catalogued filter/transition knob in the timeline against the
 *  dial catalog. PURE (reads the IR + the static catalog, no I/O), document-keyed,
 *  and conservative (zero diagnostics on a valid timeline). Registered in
 *  `src/diagnostics/index.ts`; every surface (LSP, MCP, CLI, UI) gets it for free. */
export const dials: Checker = (state: Timeline): Diagnostic[] => {
  const fps = state.profile.fps;
  const out: DiagnosticInput[] = [];
  for (const track of [...state.tracks.video, ...state.tracks.audio]) {
    for (const item of track.items) {
      if (item.kind !== "clip") continue;
      out.push(...checkClipFilters(item, track, fps));
    }
  }
  out.push(...checkTransitions(state.transitions, fps));
  // `source` is stamped by the registry; cast the inputs to the public Diagnostic.
  return out as Diagnostic[];
};
