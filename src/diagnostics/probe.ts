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
import type { Profile } from "../ir/types";
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
): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  const timelineFps = rationalToFps({ num: profile.fps[0], den: profile.fps[1] });
  if (!(timelineFps > 0)) return out;

  // VFR: nominal vs true-average gap on the SAME source.
  if (probe.rFrameRate && probe.avgFrameRate) {
    const nominal = rationalToFps(probe.rFrameRate);
    const average = rationalToFps(probe.avgFrameRate);
    if (nominal > 0 && Math.abs(nominal - average) / nominal > VFR_TOLERANCE) {
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
    if (Math.abs(nominal - timelineFps) / timelineFps > FPS_MISMATCH_TOLERANCE) {
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
