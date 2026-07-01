// Collect the source files a timeline references — the pure half of `media.consolidate`
// (Premiere's "Collect Files and Copy to New Location"). The copy itself is fs I/O and
// lives in the action; this module is pure path math so it unit-tests in vitest.
//
// This is the FULL-file Collect mode. The trim-to-used-portions + handles + transcode
// variant ("Consolidate and Transcode") needs the melt/ffmpeg render layer and is
// deferred (see DESIGN-MEDIA.md).
import { isAbsolute, resolve } from "node:path";
import type { Clip, Timeline } from "../ir/types";

/** A clip points at a real media FILE (not a `color` generator, a Remotion overlay,
 *  or a `graphic` label). Mirrors `probeableFile` in driver/probeDiagnostics — kept
 *  separate so the two can diverge (consolidate may later opt to include graphics). */
function fileBacked(clip: Clip): boolean {
  if (clip.service === "color") return false;
  const r = clip.resource.replace(/\\/g, "/").trim();
  if (r === "") return false;
  if (/cache\/remotion\//.test(r)) return false;
  if (clip.label && /^graphic\b/i.test(clip.label)) return false;
  return r.includes("/") || /\.[a-z0-9]{2,4}$/i.test(r);
}

/**
 * The distinct source files a timeline references, as absolute paths (relative
 * resources resolve against `baseDir` — the directory of the `.mlt`). File-backed
 * clips only; order-preserving, de-duplicated.
 */
export function timelineSourceFiles(timeline: Timeline, baseDir?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const track of [...timeline.tracks.video, ...timeline.tracks.audio]) {
    for (const item of track.items) {
      if (item.kind !== "clip" || !fileBacked(item)) continue;
      const abs =
        isAbsolute(item.resource) || !baseDir ? item.resource : resolve(baseDir, item.resource);
      if (seen.has(abs)) continue;
      seen.add(abs);
      out.push(abs);
    }
  }
  return out;
}
