// EXPORT-ONLY bake. A Remotion comp is a LIVE first-class timeline entity the
// viewer renders natively (see DESIGN-LIVE-COMP-PREVIEW.md); baking to an alpha
// .mov is needed ONLY for the melt export (melt can't render React). render.video
// calls this to materialize every comp overlay's .mov from its composition id,
// into the resource path the timeline already references, right before melt.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseDoc } from "../bridge/tools/core";
import type { Clip } from "../ir/types";

export type OverlayBakeResult =
  | { ok: true; baked: Array<{ id: string; outPath: string; pixFmt: string }> }
  | { ok: false; kind: string; detail: string };

/** Bake every live comp overlay in a timeline to its `.mov` resource path (the
 *  export truth). No cache dedup — a fresh export always re-renders from source. */
export async function bakeOverlaysForExport(
  timelinePath: string,
  repo: string,
): Promise<OverlayBakeResult> {
  const state = parseDoc(readFileSync(timelinePath, "utf8"));
  const overlays: Clip[] = [];
  for (const track of state.tracks.video) {
    for (const item of track.items) {
      if (item.kind === "clip" && item.composition) overlays.push(item);
    }
  }
  if (overlays.length === 0) return { ok: true, baked: [] };

  const { remotionWorkspaceForRepo, renderComposition, RemotionError } = await import(
    "../driver/remotion"
  );
  const { entry, bin } = remotionWorkspaceForRepo(repo);

  const baked: Array<{ id: string; outPath: string; pixFmt: string }> = [];
  for (const clip of overlays) {
    const compId = clip.composition?.id;
    if (!compId) continue;
    mkdirSync(dirname(clip.resource), { recursive: true });
    try {
      const result = await renderComposition(compId, clip.resource, {
        entry,
        ...(bin ? { bin } : {}),
        props: clip.composition?.props ?? {},
      });
      if (!result.hasAlpha) {
        return {
          ok: false,
          kind: "no-alpha",
          detail: `overlay "${compId}" rendered without an alpha plane (pix_fmt=${result.pixFmt})`,
        };
      }
      baked.push({ id: compId, outPath: result.outPath, pixFmt: result.pixFmt });
    } catch (error) {
      const detail =
        error instanceof RemotionError ? error.message : String((error as Error)?.message ?? error);
      return { ok: false, kind: "render", detail: `baking overlay "${compId}": ${detail}` };
    }
  }
  return { ok: true, baked };
}
