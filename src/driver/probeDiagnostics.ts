// The DRIVER-layer fps diagnostics orchestrator: the async, I/O-bearing half that
// the pure rule (`src/diagnostics/probe.ts`) can't be. It walks a timeline's
// file-backed clips, ffprobes each unique source (`src/driver/probe.ts`, cached),
// applies the pure rule, and returns the diagnostics stamped `source: "probe"` so a
// caller WITH I/O (the preview server's /api/diagnostics today; the CLI `diagnose`
// verb next) can MERGE them into the pure engine's set — exactly the composition the
// `// TODO(driver)` markers in `checks/media.ts` describe.
//
// Boundary: this lives in `src/driver` (it does I/O); it imports the pure RULE from
// `src/diagnostics` (types are erased, no runtime coupling) — never the reverse.
import { isAbsolute, resolve } from "node:path";
import type { Diagnostic } from "../diagnostics/types";
import { probeDiagnostics } from "../diagnostics/probe";
import type { Clip, Timeline } from "../ir/types";
import { probeSource } from "./probe";

export type ProbeDiagnosticsOpts = {
  /** Directory to resolve RELATIVE clip resources against (the .mlt's own dir).
   *  Absolute resources are probed as-is; omit for absolute-only timelines. */
  baseDir?: string;
};

/** A clip is probeable for fps iff it points at a real media FILE — not a generator
 *  (`color`) and not a Remotion graphic overlay (those are CFR by construction and
 *  rendered by us). Color specs (`"0"`, `"#ff0000"`, `"red"`) and the remotion cache
 *  are excluded; a path-shaped resource is kept. */
function probeableFile(clip: Clip): boolean {
  if (clip.service === "color") return false;
  const resource = clip.resource.replace(/\\/g, "/");
  if (resource.trim() === "") return false;
  if (resource.includes("/.vean/cache/remotion/") || /cache\/remotion\//.test(resource)) {
    return false; // a rendered Remotion overlay — not source footage
  }
  if (clip.label && /^graphic\b/i.test(clip.label)) return false;
  // A real file path has a separator or a media-ish extension; a color spec doesn't.
  return resource.includes("/") || /\.[a-z0-9]{2,4}$/i.test(resource);
}

/**
 * Probe every file-backed clip in `state` and return the fps diagnostics. Async +
 * I/O (ffprobe). Probes run in parallel; the probe cache dedups repeated sources to
 * one spawn. A clip whose file is missing/unreadable yields no diagnostic here
 * (a dangling FILE ref is a separate driver concern, not an fps judgement).
 */
export async function collectProbeDiagnostics(
  state: Timeline,
  opts: ProbeDiagnosticsOpts = {},
): Promise<Diagnostic[]> {
  const profile = state.profile;
  const targets: { clip: Clip; trackId: string }[] = [];
  for (const track of [...state.tracks.video, ...state.tracks.audio]) {
    for (const item of track.items) {
      if (item.kind === "clip" && probeableFile(item)) {
        targets.push({ clip: item, trackId: track.id });
      }
    }
  }

  const resolvePath = (resource: string): string =>
    isAbsolute(resource) || !opts.baseDir ? resource : resolve(opts.baseDir, resource);

  const perClip = await Promise.all(
    targets.map(async ({ clip, trackId }) => {
      const probe = await probeSource(resolvePath(clip.resource));
      if (!probe) return [];
      return probeDiagnostics(profile, probe, { clip: clip.id, track: trackId });
    }),
  );

  // Stamp provenance (the registry stamps `source` for pure checkers; probe
  // diagnostics are merged outside it, so we stamp here).
  return perClip.flat().map((d) => ({ ...d, source: "probe" }));
}
