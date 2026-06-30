#!/usr/bin/env bun
// build-graphic-overlay — authors the committed `graphic-overlay.mlt` fixture: the
// SIBLING of demo.mlt that exercises the LIVE Remotion `<Player>` path (not the
// footage-composite path demo.mlt proves).
//
//   bun corpus/demo/build-graphic-overlay.ts
//
// WHY THIS FIXTURE EXISTS (the gap it closes)
//   The viewer routes an upper-track overlay clip to the `@remotion/player` overlay
//   ONLY when it is a GRAPHIC clip — `viewer/src/types.ts isGraphicClip`: a clip
//   whose label matches /^graphic\b/i OR whose resource is under `cache/remotion/`.
//   demo.mlt's overlay is a baked video FILE (`corpus/demo/lower-third.mov`) authored
//   with a `graphic:` label — but `label` is NOT serialized (it round-trips to
//   nothing; see `src/ir/serialize.ts`), and the resource is not under
//   `cache/remotion/`. So after commit ba0948c the viewer correctly composites
//   demo.mlt's overlay as FOOTAGE (decoded, over-composited), and NO committed
//   timeline ever made `isGraphicClip` return true — the live `OverlayPlayer`
//   (@remotion/player seeked to the master frame) and the App `deriveOverlay`
//   present:true branch went unexercised by any drive-able fixture.
//
//   This fixture is the missing one: its overlay clip's resource lives in the real
//   Remotion render cache (`.vean/cache/remotion/…`), so `isGraphicClip` returns true
//   on BOTH sides (viewer + `src/preview/proxy.ts`). The viewer then:
//     • `deriveOverlay` → present:true → mounts `OverlayPlayer`,
//     • `resolveLayers` SKIPS the graphic track (footage compositor leaves it to the
//       `<Player>`), and
//     • the live `<Player>` renders the hardcoded `LowerThird` composition (the Vite
//       `@remotion-comp` alias) seeked to the master clock, ON TOP of the footage.
//   `bun run verify:live-overlay` drives all four end-to-end.
//
// COMMITTED vs MACHINE-LOCAL
//   committed   : corpus/demo/graphic-overlay.mlt (deterministic, byte-stable — the
//                 author below uses PINNED ids; tests/graphic-overlay-fixture.test.ts
//                 + the determinism gate guard it).
//   NOT needed  : a binary overlay. The LIVE `<Player>` renders LowerThird from the
//                 viewer's Vite alias, NOT from the `.vean/cache/remotion/…` file — so
//                 the live-preview gate needs NO render and NO `melt`/Remotion on a
//                 fresh clone. (The path is the real cache location an exported
//                 overlay WOULD occupy; it is gitignored and optional.)
import { join, resolve } from "node:path";
import {
  clip,
  colorClip,
  dissolve,
  resetIds,
  timeline,
  transition,
  videoTrack,
} from "../../src/ir/builder";
import { fromMlt } from "../../src/ir/parse";
import { VERTICAL } from "../../src/ir/profile";
import { toMlt } from "../../src/ir/serialize";

const REPO = resolve(import.meta.dirname, "..", "..");
const OUT_MLT = join(REPO, "corpus", "demo", "graphic-overlay.mlt");

// ── Geometry (mirrors demo.mlt so the moving-footage base is the proven shape) ──
// All integer frames @ VERTICAL 1080×1920 @30 (Move-5 integer-fps invariant).
const DUR = 90; // 3s overlay span
const DISSOLVE = 18; // base cross-fade overlap (frames)
const TEAL = "#0E5C63";
const INDIGO = "#241A52";

// The overlay resource lives in the REAL Remotion render cache (`.vean/cache/remotion/`)
// — the location an exported overlay occupies and the signal `isGraphicClip` keys on
// (`/cache\/remotion\//`). The file itself need not exist: the live `<Player>` renders
// the composition from source, never from this path (see header).
const OVERLAY_REL = ".vean/cache/remotion/lower-third.mov";

/** Author the fixture IR with PINNED ids → a deterministic, byte-stable .mlt. */
function buildGraphicOverlayTimeline() {
  resetIds();

  // Base footage track (V1): teal → indigo cross-fade — a synthesized "footage"
  // stand-in with visible MOTION under the overlay (the dissolve overlap). Identical
  // geometry to demo.mlt: teal solo [0,44] · dissolve [45,62] · indigo solo [63,107].
  const half = Math.round(DUR / 2);
  const tailLen = DUR - half + DISSOLVE;
  const base = videoTrack(
    colorClip(half + DISSOLVE, TEAL, { id: "base-a", label: "base:teal" }),
    dissolve(DISSOLVE),
    colorClip(tailLen, INDIGO, { id: "base-b", label: "base:indigo" }),
  );

  // GFX overlay track (V2, bottom of tracks.video = TOP melt compositing layer). The
  // GRAPHIC clip: a `cache/remotion/` resource ⇒ `isGraphicClip` true ⇒ the live
  // `<Player>` draws it. (The `graphic:` label is also set, for documentation — but
  // it does not serialize, so the resource path is the load-bearing signal.)
  const overlayClip = clip(OVERLAY_REL, {
    id: "gfx-lowerthird",
    in: 0,
    out: DUR - 1,
    length: DUR,
    label: "graphic:lower-third",
  });
  const gfx = videoTrack(overlayClip);

  // The qtblend field transition compositing GFX (B, higher main-tractor index) over
  // the base footage (A, lower index) for [0, DUR-1]. Main-tractor indices: 0 =
  // background, 1 = V1 (base), 2 = V2 (gfx). So a_track = 1, b_track = 2 (mirrors
  // src/actions/graphic.ts). A qtblend over a GRAPHIC bTrack is the Player-overlay
  // seam; over a plain video bTrack it is a footage over-composite (demo.mlt).
  const qtblend = transition("qtblend", 1, 2, 0, DUR - 1, {});

  return timeline(
    VERTICAL,
    { video: [base, gfx] },
    {
      title: "vean — live graphic overlay (Remotion Player)",
      transitions: [qtblend],
    },
  );
}

async function main() {
  const tl = buildGraphicOverlayTimeline();
  const xml = toMlt(tl);
  await Bun.write(OUT_MLT, xml);

  // Guard: the committed XML must be a round-trip fixpoint (no determinism drift).
  const rt = toMlt(fromMlt(toMlt(fromMlt(xml))));
  if (rt !== xml) {
    console.error("FAIL  graphic-overlay.mlt is not a round-trip fixpoint (determinism drift)");
    process.exit(1);
  }

  console.log(`  timeline: ${OUT_MLT}  (${xml.length} bytes, round-trip stable)`);
  const previewPath = join("corpus", "demo", "graphic-overlay.mlt");
  console.log(
    `\nDONE. Live-preview gate:  bun run verify:live-overlay\n      Preview manually:   vean preview --timeline ${previewPath}`,
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
