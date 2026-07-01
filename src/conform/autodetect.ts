// AUTODETECT-ON-FIRST-CLIP — the async orchestration that fires fps autodetect when
// an op takes the timeline from 0 → ≥1 video clips (the first clip lands, the
// Premiere "new sequence from clip" moment). FIRST-CLIP ONLY by design: re-checking
// every append would fight a deliberate mixed-rate timeline and get noisy.
//
// It reads the `fps.autodetect` setting and, in `auto` mode, conforms the profile to
// the clip's nominal rate via the pure engine (`./fps`); in `confirm` it surfaces a
// proposal (the caller decides how to present it); `off` short-circuits. The I/O
// (probe + settings read) lives here, not in the pure op or the pure rule, so the
// edit algebra and `./fps` stay deterministic. Best-effort: any probe/settings miss
// returns null (autodetect never blocks or breaks an edit).
import { isAbsolute, resolve } from "node:path";
import { probeSource } from "../driver/probe";
import type { Clip, Timeline } from "../ir/types";
import { getSettingValue } from "../state/settingsStore";
import {
  type AutodetectDecision,
  type FpsConformMode,
  applyFpsConform,
  autodetectDecision,
} from "./fps";

function videoClipCount(tl: Timeline): number {
  let n = 0;
  for (const track of tl.tracks.video) for (const it of track.items) if (it.kind === "clip") n++;
  return n;
}

function firstVideoClip(tl: Timeline): Clip | null {
  for (const track of tl.tracks.video)
    for (const it of track.items) if (it.kind === "clip") return it;
  return null;
}

export type AutodetectOutcome = {
  /** The resolved decision (off / match / propose / apply). */
  decision: AutodetectDecision;
  /** The conformed timeline when decision === "apply"; otherwise the input `next`. */
  state: Timeline;
};

/**
 * Fire first-clip fps autodetect. Returns null unless this op added the FIRST video
 * clip (0 → ≥1) AND `fps.autodetect` is not `off` AND the clip probes to a rate that
 * differs from the timeline. In `auto` the returned `state` is conformed; in `confirm`
 * the `decision` carries the proposal and `state` is unchanged. Never throws.
 */
export async function autodetectFirstClip(
  prev: Timeline,
  next: Timeline,
  opts: { repo: string; baseDir: string },
): Promise<AutodetectOutcome | null> {
  if (videoClipCount(prev) !== 0 || videoClipCount(next) < 1) return null;
  let mode: FpsConformMode;
  try {
    mode = getSettingValue(opts.repo, "fps.autodetect") as FpsConformMode;
  } catch {
    mode = "confirm";
  }
  if (mode === "off") return null;
  const clip = firstVideoClip(next);
  if (!clip) return null;
  const path = isAbsolute(clip.resource) ? clip.resource : resolve(opts.baseDir, clip.resource);
  const probe = await probeSource(path);
  if (!probe) return null;
  const decision = autodetectDecision(mode, next.profile, probe);
  if (decision.decision === "apply") {
    return { decision, state: applyFpsConform(next, decision.proposal.toFps) };
  }
  if (decision.decision === "propose") {
    return { decision, state: next };
  }
  return null; // match (already matches) or off
}
