// FPS CONFORM — the pure decision + edit engine shared by (1) autodetect-on-init
// and (2) the `source-fps-mismatch` fix. Both reduce to one operation: set the
// timeline's profile fps to a source's NOMINAL rate. Pure (no I/O, no DB): given a
// profile and a source probe (from `src/driver/probe.ts`), it proposes/applies the
// change; the I/O (probing, reading the `fps.autodetect` setting, saving) lives in
// the action/CLI caller. Profile-fps is project config, not clip edit-algebra, so
// it is NOT a `src/ops` op — it is an action-layer edit, reversible by re-conforming
// to the captured prior fps.
//
// Why the NOMINAL rate (r_frame_rate), not the average: the nominal is the source's
// constant-rate INTENT (a 25fps clip reports 25/1; a VFR phone clip reports its 30/1
// ceiling). Matching it is what "conform the timeline to the footage" means. A VFR
// source is a TRANSCODE concern (no single CFR matches it), handled separately — so
// conform deliberately ignores the average and never "fixes" VFR by changing fps.
import type { SourceProbe } from "../driver/probe";
import { rationalToFps } from "../driver/probe";
import type { Fps, Profile, Timeline } from "../ir/types";

/** How autodetect should treat an fps difference (the `fps.autodetect` setting). */
export type FpsConformMode = "off" | "confirm" | "auto";

/** A proposed profile-fps change: the current rate and the rate to set. */
export type FpsProposal = { fromFps: Fps; toFps: Fps };

/** The source's nominal rate as an Fps `[num, den]`, or null if unknown. */
function sourceNominalFps(probe: SourceProbe): Fps | null {
  return probe.rFrameRate ? [probe.rFrameRate.num, probe.rFrameRate.den] : null;
}

/**
 * Propose conforming the profile fps to a source's nominal rate, or null when the
 * rate is unknown or already matches (within `tol`, the same relative tolerance the
 * mismatch diagnostic uses, so "would the diagnostic fire?" and "is there a conform
 * to propose?" agree). Pure.
 */
export function proposeFpsConform(
  profile: Profile,
  probe: SourceProbe,
  tol = 0.0005,
): FpsProposal | null {
  const nominal = sourceNominalFps(probe);
  if (!nominal) return null;
  const cur = rationalToFps({ num: profile.fps[0], den: profile.fps[1] });
  const next = rationalToFps({ num: nominal[0], den: nominal[1] });
  if (!(cur > 0) || Math.abs(cur - next) / cur <= tol) return null;
  return { fromFps: [profile.fps[0], profile.fps[1]], toFps: nominal };
}

/** Replace the trailing rate token of a profile description so the label stays
 *  coherent after a conform: `landscape-1920x1080-30` → `…-25` / `…-2997`. */
function retagDescription(description: string, fps: Fps): string {
  const ratio = fps[0] / fps[1];
  const tag = Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(2).replace(".", "");
  return /-\d+$/.test(description)
    ? description.replace(/-\d+$/, `-${tag}`)
    : `${description}-${tag}`;
}

/**
 * Apply a profile-fps change to a deep clone. Frame INTEGERS are unchanged — only
 * the profile's rational rate (and its description label) move, which reinterprets
 * how those integer frames map to wall-clock time. Pure; never mutates `timeline`.
 */
export function applyFpsConform(timeline: Timeline, toFps: Fps): Timeline {
  const clone: Timeline = JSON.parse(JSON.stringify(timeline));
  clone.profile.fps = [toFps[0], toFps[1]];
  clone.profile.description = retagDescription(clone.profile.description, toFps);
  return clone;
}

/** What autodetect resolves to for a first clip, given the mode. */
export type AutodetectDecision =
  | { decision: "off" }
  | { decision: "match" } // unknown rate, or already matching → nothing to do
  | { decision: "propose"; proposal: FpsProposal } // confirm mode: surface, don't apply
  | { decision: "apply"; proposal: FpsProposal }; // auto mode: apply

/**
 * Resolve the autodetect action for a first clip. `off` short-circuits; otherwise we
 * propose a conform (or `match` if none). `confirm` surfaces the proposal without
 * applying; `auto` applies it. The caller does the I/O (apply + save, or prompt).
 */
export function autodetectDecision(
  mode: FpsConformMode,
  profile: Profile,
  probe: SourceProbe,
): AutodetectDecision {
  if (mode === "off") return { decision: "off" };
  const proposal = proposeFpsConform(profile, probe);
  if (!proposal) return { decision: "match" };
  return mode === "auto" ? { decision: "apply", proposal } : { decision: "propose", proposal };
}
