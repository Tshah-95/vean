#!/usr/bin/env bun
// build-demo — assembles the committed Move-5 fixture demo project and (re)renders
// its machine-local overlay. This is the seed of vean's product demo: a footage
// base + the vean lower-third on an upper track (qtblend composite) + an audio bed.
//
//   bun corpus/demo/build-demo.ts          # author demo.mlt + render the overlay
//   bun corpus/demo/build-demo.ts --check  # also assert alpha + print evidence
//
// WHAT IS COMMITTED vs REGENERATED
//   committed   : corpus/demo/demo.mlt (the timeline: base + audio + qtblend +
//                 the overlay CLIP ENTRY referencing corpus/demo/lower-third.mov)
//   regenerated : corpus/demo/lower-third.mov (gitignored — a binary ProRes 4444
//                 alpha clip the deterministic Remotion render reproduces on demand)
//
// Because the overlay artifact is gitignored, run THIS script once after a fresh
// clone (or `bun run demo:build`) before `vean preview` / `vean render video`.
//
// The overlay is produced by the REAL `vean remotion render` CLI (the product
// surface, an arm's-length subprocess like melt). demo.mlt is authored DIRECTLY
// through the builder with PINNED ids, so the committed XML is byte-stable across
// machines and runs (tests/demo-fixture.test.ts + the determinism gate guard it);
// only the binary .mov is machine-local.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  audioTrack,
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
const DEMO_DIR = join(REPO, "corpus", "demo");
const DEMO_MLT = join(DEMO_DIR, "demo.mlt");
const OVERLAY_MOV = join(DEMO_DIR, "lower-third.mov");
const CLI = join(REPO, "src", "cli.ts");
// Paths emitted INTO the .mlt are repo-relative so the committed fixture is
// portable and `melt` (run with cwd = REPO) resolves them on any machine.
const OVERLAY_REL = "corpus/demo/lower-third.mov";
const TONE_REL = "corpus/tone.wav";

// ── Demo geometry (all integer frames @ VERTICAL 1080×1920 @30) ──────────────
const DUR = 90; // 3s total
const DISSOLVE = 18; // base cross-fade overlap (frames)
// The base is two solid colours cross-fading — a synthesized "footage" stand-in
// that needs NO external video asset, yet gives visible MOTION so the overlay is
// provably composited over CHANGING footage (not a frozen frame). Brand-free hexes.
const TEAL = "#0E5C63";
const INDIGO = "#241A52";

// Overlay (lower-third) props — brand-free hexes passed to the Remotion comp.
const OVERLAY_PROPS = {
  title: "vean",
  subtitle: "video editor, agent native",
  accent: "#E8B04B",
  barColor: "#11131aee",
};

/** Author the demo IR with PINNED ids (deterministic → byte-stable demo.mlt). */
function buildDemoTimeline() {
  resetIds();

  // Base footage track (V1): teal → indigo cross-fade. The two halves overlap by
  // DISSOLVE frames, giving visible motion under the overlay.
  const half = Math.round(DUR / 2);
  const tailLen = DUR - half + DISSOLVE; // tail extends to cover the overlap
  const base = videoTrack(
    colorClip(half + DISSOLVE, TEAL, { id: "base-a", label: "base:teal" }),
    dissolve(DISSOLVE),
    colorClip(tailLen, INDIGO, { id: "base-b", label: "base:indigo" }),
  );

  // GFX overlay track (V2, BOTTOM of tracks.video = TOP melt compositing layer —
  // see src/actions/graphic.ts). The alpha clip is the Remotion lower-third .mov.
  const overlayClip = clip(OVERLAY_REL, {
    id: "gfx-lowerthird",
    in: 0,
    out: DUR - 1,
    length: DUR,
    label: "graphic:lower-third",
  });
  const gfx = videoTrack(overlayClip);

  // Audio bed (A1): the repo tone, −6 dB, with short fades. gain is a raw
  // multiplier (dbToGain(−6) ≈ 0.501) to keep the build dependency-thin.
  const GAIN_MINUS_6DB = 10 ** (-6 / 20); // ≈ 0.5012
  const bed = audioTrack(
    clip(TONE_REL, {
      id: "bed-tone",
      in: 0,
      dur: DUR,
      gain: GAIN_MINUS_6DB,
      fadeIn: 6,
      fadeOut: 6,
      label: "audio:tone",
    }),
  );

  // The qtblend field transition compositing GFX (B, higher main-tractor index)
  // over the base footage (A, lower index) for the overlay's [0, DUR-1] span.
  // Main-tractor indices: 0 = background producer, 1 = V1 (base), 2 = V2 (gfx),
  // 3 = A1. So a_track = 1 (base), b_track = 2 (gfx). (Mirrors graphic.ts.)
  const qtblend = transition("qtblend", 1, 2, 0, DUR - 1, {});

  return timeline(
    VERTICAL,
    { video: [base, gfx], audio: [bed] },
    { title: "vean demo — lower-third over footage", transitions: [qtblend] },
  );
}

/** Render the LowerThird overlay to corpus/demo/lower-third.mov via the REAL
 *  `vean remotion render` CLI (an arm's-length subprocess, like melt). */
function renderOverlay(): { ok: boolean; pixFmt?: string; hasAlpha?: boolean; detail?: string } {
  const out = execFileSync(
    "bun",
    [
      CLI,
      "remotion",
      "render",
      "LowerThird",
      "--profile",
      "vertical",
      "--frames",
      `0-${DUR - 1}`,
      "--out",
      OVERLAY_MOV,
      "--props-json",
      JSON.stringify(OVERLAY_PROPS),
      "--force",
      "--json",
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  return JSON.parse(out);
}

function ffprobePixFmt(path: string): string {
  return execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=pix_fmt",
      "-of",
      "default=nw=1:nk=1",
      path,
    ],
    { encoding: "utf8" },
  ).trim();
}

async function main() {
  const check = process.argv.includes("--check");

  // 1) Render the alpha overlay (the gitignored binary the .mlt references).
  console.log("→ rendering LowerThird overlay via `vean remotion render` …");
  const r = renderOverlay();
  if (!r.ok) {
    console.error(`FAIL  remotion render: ${r.detail ?? JSON.stringify(r)}`);
    process.exit(1);
  }
  if (!r.hasAlpha) {
    console.error(`FAIL  overlay has no alpha plane (pix_fmt=${r.pixFmt}); composite would break`);
    process.exit(1);
  }
  console.log(`  overlay: ${OVERLAY_MOV}  pix_fmt=${r.pixFmt}  hasAlpha=${r.hasAlpha}`);

  // 2) Author + write the deterministic demo.mlt.
  const tl = buildDemoTimeline();
  const xml = toMlt(tl);
  await Bun.write(DEMO_MLT, xml);
  // Guard: the committed XML must be a round-trip fixpoint (no determinism drift).
  const rt = toMlt(fromMlt(toMlt(fromMlt(xml))));
  if (rt !== xml) {
    console.error("FAIL  demo.mlt is not a round-trip fixpoint (determinism drift)");
    process.exit(1);
  }
  console.log(`  timeline: ${DEMO_MLT}  (${xml.length} bytes, round-trip stable)`);

  if (!existsSync(OVERLAY_MOV)) {
    console.error(`FAIL  expected overlay at ${OVERLAY_MOV}`);
    process.exit(1);
  }

  if (check) {
    const pf = ffprobePixFmt(OVERLAY_MOV);
    console.log("\n--- evidence ---");
    console.log(`overlay pix_fmt : ${pf}  (alpha=${/yuva/.test(pf)})`);
    console.log("demo.mlt        : committed (overlay clip + qtblend + audio bed)");
    if (!/yuva/.test(pf)) {
      console.error("FAIL  overlay pix_fmt has no alpha plane");
      process.exit(1);
    }
  }

  console.log(
    "\nDONE. Preview:  vean preview --timeline corpus/demo/demo.mlt\n" +
      "      Export:   vean render video corpus/demo/demo.mlt --out out/demo.mp4",
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
