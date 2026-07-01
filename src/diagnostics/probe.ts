// The frame-rate RULE — pure, I/O-free, and therefore unit-testable. Given the
// timeline profile and one source's probed rates (from `src/driver/probe.ts`), it
// returns the fps diagnostics for that clip. It is NOT a registered `Checker` (those
// are `(state) => Diagnostic[]` over the IR alone): this rule needs a fact the IR
// does not carry — the source file's real rate — so it is fed probe data by the
// DRIVER-layer orchestrator (`src/driver/probeDiagnostics.ts`) and merged into the
// set by a caller that has I/O. Keeping the RULE here (not in the driver) honors
// "the diagnostics engine is the one place rules live" — only the probing is I/O.
//
// CONSERVATIVE, like every other checker (the no-false-positive gate): each rule
// fires ONLY on a clear, measurable defect and is silent on a matching constant-rate
// source. `null` probe fields (unknown rate, no video stream) judge nothing.
import type { SourceProbe } from "../driver/probe";
import { rationalToFps } from "../driver/probe";
import { type Clip, type Profile, hasAudio } from "../ir/types";
import { type DiagnosticInput, diag } from "./types";

/** Relative gap between a source's nominal rate and the timeline rate beyond which
 *  we flag a mismatch. 0.05% — tight enough that 29.97-vs-30 (0.1%) and 23.976-vs-24
 *  fire, loose enough that an exact match (0%) never does. Rates are exact rationals
 *  from ffprobe, so float noise is ~1e-15 — far below this; no float false positives. */
export const FPS_MISMATCH_TOLERANCE = 0.0005;

/** Relative gap between a source's nominal (`r_frame_rate`) and true average
 *  (`avg_frame_rate`) beyond which we call it variable frame rate. 0.2% — a clean
 *  CFR file reports the two EQUAL (gap 0); Pixel/iPhone VFR reports ~0.3%+. The
 *  margin absorbs a CFR file whose last partial second nudges its average slightly. */
export const VFR_TOLERANCE = 0.002;

/** Location to anchor the diagnostics on (the clip + track ids). */
export type ProbeDiagLocation = { clip: string; track: string };

/** Tunable thresholds — supplied by the orchestrator from the `fps.*Tolerance`
 *  settings, defaulting to the constants above when omitted (so the pure rule and
 *  its tests need no settings/DB). */
export type ProbeThresholds = { mismatchTolerance?: number; vfrTolerance?: number };

/**
 * The fps rule for one source. Emits up to two diagnostics:
 *   • `variable-frame-rate-source` — the source's nominal and average rates diverge
 *     (VFR). On a constant-rate timeline melt duplicates/drops frames unevenly and
 *     audio drifts; the real fix is a CFR transcode. This is the one that fires on
 *     phone footage (nominal 30, average ~29.9).
 *   • `source-fps-mismatch` — the source's nominal rate differs from the timeline
 *     rate (e.g. a 25 or 23.976 clip on a 30 timeline). melt resamples it. A VFR
 *     source whose nominal MATCHES the timeline (phone 30 on a 30 timeline) does NOT
 *     trip this — there the defect is the VFR, reported above, not a nominal mismatch.
 */
export function probeDiagnostics(
  profile: Profile,
  probe: SourceProbe,
  loc: ProbeDiagLocation,
  thresholds: ProbeThresholds = {},
): DiagnosticInput[] {
  const vfrTol = thresholds.vfrTolerance ?? VFR_TOLERANCE;
  const mismatchTol = thresholds.mismatchTolerance ?? FPS_MISMATCH_TOLERANCE;
  const out: DiagnosticInput[] = [];
  const timelineFps = rationalToFps({ num: profile.fps[0], den: profile.fps[1] });
  if (!(timelineFps > 0)) return out;

  // VFR: nominal vs true-average gap on the SAME source.
  if (probe.rFrameRate && probe.avgFrameRate) {
    const nominal = rationalToFps(probe.rFrameRate);
    const average = rationalToFps(probe.avgFrameRate);
    if (nominal > 0 && Math.abs(nominal - average) / nominal > vfrTol) {
      out.push(
        diag({
          code: "variable-frame-rate-source",
          severity: "warning",
          message: `clip "${loc.clip}" source is variable frame rate (${nominal.toFixed(3)} nominal vs ${average.toFixed(3)} average fps) — on the constant-rate ${fmt(timelineFps)} timeline melt duplicates/drops frames unevenly and audio drifts`,
          location: { clip: loc.clip, track: loc.track },
          fix: "transcode the source to a constant-frame-rate edit intermediate (ProRes / DNxHD), then relink",
          data: {
            nominalFps: round3(nominal),
            averageFps: round3(average),
            timelineFps: round3(timelineFps),
          },
        }),
      );
    }
  }

  // Nominal mismatch: the source's claimed CFR rate vs the timeline rate.
  if (probe.rFrameRate) {
    const nominal = rationalToFps(probe.rFrameRate);
    if (Math.abs(nominal - timelineFps) / timelineFps > mismatchTol) {
      out.push(
        diag({
          code: "source-fps-mismatch",
          severity: "warning",
          message: `clip "${loc.clip}" source is ${fmt(nominal)} fps but the timeline is ${fmt(timelineFps)} — melt resamples it (frame duplication / judder) and stretches its audio to fit`,
          location: { clip: loc.clip, track: loc.track },
          fix: "conform the source to the timeline rate, or set the timeline fps to match the footage",
          data: { sourceFps: round3(nominal), timelineFps: round3(timelineFps) },
        }),
      );
    }
  }

  return out;
}

/** Integers print clean (30); fractional rates get two decimals (29.97). */
function fmt(fps: number): string {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// ─── Stream-selector RULES that need a probe (the file's real stream layout) ─────
//
// The pure `link` checker (src/diagnostics/checks/link.ts) judges the stream
// selectors it can from the IR alone (a video-only clip carrying a dead audio
// filter). Two selector defects need a fact the IR does NOT carry — the SOURCE
// file's actual stream layout — so, exactly like the fps rule above, they are PURE
// functions over an already-gathered `SourceProbe` fed by the driver orchestrator
// (src/driver/probeDiagnostics.ts), stamped `source: "probe"` and merged into the
// set. They unit-test without ffprobe (a synthetic probe), and — the load-bearing
// discipline — GUARD behind available probe data: an unknown stream count judges
// NOTHING (`audioStreams === null`), never a false positive.
//
// The probe reads the count of AUDIO streams (`audioStreams`) but not a count of
// VIDEO streams (it reads only the FIRST video stream's facts). So we can validate
// AUDIO selectors (`audioIndex`/`astream`) against the real count and detect audio
// disabled on a file that never had audio; a VIDEO selector past the (unknown) video
// count is skipped gracefully — uncertainty is silence.

/** Where a stream-selector diagnostic anchors (the clip + track ids). Mirrors the
 *  fps rule's `ProbeDiagLocation`. */
export type StreamProbeLocation = { clip: string; track: string };

/**
 * `redundant-stream-selector` (probe slice) — a clip DISABLES audio (a selector sets
 * `audioIndex`/`astream` to `-1`, so `hasAudio(clip)` is false) but the SOURCE FILE
 * carries NO audio stream at all (`audioStreams === 0`). The selector is redundant:
 * there was never any audio to turn off. It renders correctly (nothing changes), so
 * this is `info` — waste/noise, not a hazard. The in-IR slice (a dead audio FILTER on
 * a video-only clip) lives in checks/link.ts; this slice needs the source's audio
 * stream count, which only a probe knows.
 *
 * GUARDED: fires ONLY when the clip actually turns audio off via a selector AND the
 * probe positively reports ZERO audio streams. An unknown count (`audioStreams ===
 * null`) or a clip with audio on / no selectors judges nothing.
 */
export function redundantStreamSelectorDiagnostic(
  clip: Clip,
  probe: SourceProbe,
  loc: StreamProbeLocation,
): DiagnosticInput[] {
  if (clip.streams == null) return []; // no selectors → nothing redundant
  if (hasAudio(clip)) return []; // audio is ON → the selector isn't disabling anything
  if (probe.audioStreams == null) return []; // unknown count → judge nothing (guard)
  if (probe.audioStreams > 0) return []; // the file HAS audio → disabling it is meaningful, not redundant
  return [
    diag({
      code: "redundant-stream-selector",
      severity: "info",
      message: `clip "${loc.clip}" turns audio off with a stream selector, but its source "${probe.path}" has no audio stream — the selector is redundant (there was never any audio to disable)`,
      location: { clip: loc.clip, track: loc.track },
      fix: "drop the audio-off stream selector — the source carries no audio",
      data: { audioStreams: probe.audioStreams, audioIndex: clip.streams.audioIndex ?? -1 },
    }),
  ];
}

/**
 * `invalid-stream-selector` — a clip selects a stream INDEX beyond what the source
 * file contains (e.g. `audioIndex=3` / `astream=3` on a file with a single audio
 * stream), so melt decodes nothing on that side (silence / black) — an ERROR: the
 * clip won't play the stream the edit asked for. We validate the AUDIO selectors
 * (`audioIndex` absolute, `astream` relative) against the probed `audioStreams`
 * count. `-1` (OFF) is always valid, never flagged. The relative `astream` and the
 * absolute `audioIndex` both index into the file's audio streams `[0, audioStreams)`;
 * a non-negative index `>= audioStreams` is out of range.
 *
 * GUARDED (skip gracefully when unknown): fires only when `audioStreams` is a known
 * positive-or-zero count. A `null` count judges nothing. VIDEO selectors
 * (`vstream`/`videoIndex`) are NOT validated — the probe reads only the first video
 * stream, not a count, so the video-stream count is unknown; per the guard we skip
 * them rather than risk a false positive.
 */
export function invalidStreamSelectorDiagnostic(
  clip: Clip,
  probe: SourceProbe,
  loc: StreamProbeLocation,
): DiagnosticInput[] {
  const s = clip.streams;
  if (s == null) return []; // no selectors → nothing to validate
  if (probe.audioStreams == null) return []; // unknown count → judge nothing (guard)
  const audioStreams = probe.audioStreams;
  const out: DiagnosticInput[] = [];
  // Both the relative `astream` and absolute `audioIndex` index into [0, audioStreams).
  // `-1` = OFF is always valid. A non-negative index at/beyond the count is invalid.
  const checks: Array<[keyof typeof s, string]> = [
    ["astream", "astream"],
    ["audioIndex", "audio_index"],
  ];
  for (const [key, prop] of checks) {
    const idx = s[key];
    if (idx == null || idx === -1) continue; // absent or OFF → valid
    if (idx < 0) continue; // any other negative is out of scope (only -1 is meaningful)
    if (idx >= audioStreams) {
      out.push(
        diag({
          code: "invalid-stream-selector",
          severity: "error",
          message: `clip "${loc.clip}" selects audio stream ${idx} (${prop}=${idx}) but its source "${probe.path}" has only ${audioStreams} audio stream${audioStreams === 1 ? "" : "s"} (valid indices 0..${audioStreams - 1}) — melt decodes silence`,
          location: { clip: loc.clip, track: loc.track },
          fix: `select an audio stream in 0..${audioStreams - 1}, or turn audio off (-1)`,
          data: { selector: prop, index: idx, audioStreams },
        }),
      );
      // One diagnostic is enough signal; astream (checked first, since it overrides
      // audio_index) is the one reported when both are out of range.
      break;
    }
  }
  return out;
}
