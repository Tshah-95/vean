#!/usr/bin/env bun
// verify:graphic — the render-faithfulness gate for the COMPOSITE SEAM
// (`timeline.addGraphic`). This is the gate the original black-background defect
// slipped past: the unit tests (tests/timeline-add-graphic.test.ts,
// tests/actions-remotion.test.ts) only assert registry shape + IR structure and
// never render, so a composite that paints SOLID BLACK where the overlay is
// transparent passed every check. This gate RENDERS the real composite with
// `melt` and SAMPLES pixels, proving the footage shows through the overlay's
// transparent regions.
//
//   bun run verify:graphic
//
// What it does (no committed binary fixtures — it self-generates the alpha clip):
//   1. ffmpeg-renders a known alpha overlay: a 1080×1920 ProRes 4444 clip that is
//      fully TRANSPARENT except an OPAQUE red bar in the lower third. This mirrors
//      a Remotion lower-third export (the real producer of these overlays).
//   2. Builds the composite through the REAL `addGraphic` action over a solid-blue
//      footage clip, then serializes via `toMlt` — the exact path the CLI/MCP take.
//   3. `melt`-renders a still and samples two pixels:
//        • the BAR region   → must be RED  (the overlay composited on top), and
//        • a NON-BAR region → must be BLUE (the FOOTAGE showing through the
//          overlay's transparent alpha — the regression this gate guards).
//      If the non-bar pixel is BLACK, the black background is winning = the bug.
//   4. Asserts the returned inverse sequence reconstructs the original IR exactly
//      (the composite is reversible — undo replays a graphic).
//
// A failure to render or MEASURE is a hard FAIL (never a silent pass), exactly
// like verify:corpus. Requires `melt` + `ffmpeg` + `ffprobe` on PATH.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addGraphic } from "../src/actions/graphic";
import { still } from "../src/driver/melt";
import { clip, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { fromMlt } from "../src/ir/parse";
import { VERTICAL } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import { apply } from "../src/ops";
import { isEditError } from "../src/ops/types";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "out", "verify-graphic");

// VERTICAL is 1080×1920. The overlay's opaque bar covers y∈[1500,1700); sample the
// bar at its center, and a non-bar region well above it.
const W = VERTICAL.width;
const BAR_Y0 = 1500;
const BAR_H = 200;
const BAR_SAMPLE = { x: Math.floor(W / 2), y: BAR_Y0 + Math.floor(BAR_H / 2) }; // (540, 1600)
const NONBAR_SAMPLE = { x: Math.floor(W / 2), y: 400 }; // (540, 400) — transparent overlay region
const FRAME = 45;

/** POSIX single-quote escape for a path embedded in a `sh -c` command. */
function sh(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** The `RRGGBB` hex of a single pixel of a PNG, via ffmpeg's rawvideo decode. */
function pixelHex(png: string, x: number, y: number): string {
  const cmd =
    `ffmpeg -hide_banner -loglevel error -i ${sh(png)} ` +
    `-vf "crop=1:1:${x}:${y}" -f rawvideo -pix_fmt rgb24 - | xxd -p`;
  return execFileSync("sh", ["-c", cmd], { encoding: "utf8" }).trim();
}

/** Classify a hex pixel into a coarse colour bucket so codec/chroma noise (a few
 *  LSBs off pure primaries — ProRes 4444 is 12-bit and melt re-quantizes) doesn't
 *  flake the gate. Returns "red" | "blue" | "black" | "other". */
function bucket(hex: string): "red" | "blue" | "black" | "other" {
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  if (r < 40 && g < 40 && b < 40) return "black";
  if (r > 180 && g < 80 && b < 80) return "red";
  if (b > 180 && r < 80 && g < 80) return "blue";
  return "other";
}

/** Render the known alpha overlay (transparent canvas + opaque red bar) so the
 *  gate has no committed binary dependency. Verifies the encoded clip carries an
 *  alpha plane (yuva*) — a clip WITHOUT alpha would silently make the test
 *  meaningless (the original Remotion-export bug: a missing `--image-format=png`
 *  produced yuv422p12le with no alpha). */
function makeOverlay(path: string): void {
  const dur = "3"; // 90 frames @30
  // One ffmpeg command line, assembled from labelled segments for readability:
  // a transparent canvas + an opaque red box, overlaid so the box region gets
  // full alpha, encoded as ProRes 4444 with an alpha plane.
  const inTransparent = `-f lavfi -i "color=c=black@0.0:s=${W}x${VERTICAL.height}:r=30:d=${dur},format=rgba"`;
  const inRedBox = `-f lavfi -i "color=c=red:s=${W}x${BAR_H}:r=30:d=${dur},format=rgba"`;
  const filter = `-filter_complex "[0][1]overlay=x=0:y=${BAR_Y0}:format=auto,format=yuva444p10le"`;
  const enc = "-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le";
  const cmd = `ffmpeg -hide_banner -loglevel error -y ${inTransparent} ${inRedBox} ${filter} ${enc} ${sh(path)}`;
  execFileSync("sh", ["-c", cmd], { encoding: "utf8" });

  const pixFmt = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=pix_fmt",
      "-of",
      "default=nw=1",
      path,
    ],
    { encoding: "utf8" },
  ).trim();
  if (!pixFmt.includes("yuva")) {
    throw new Error(
      `overlay has NO alpha plane (${pixFmt}); the composite gate would be meaningless`,
    );
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  // 1) The alpha overlay (transparent + opaque red bar).
  const overlay = join(OUT, "overlay.mov");
  makeOverlay(overlay);

  // 2) Build the composite through the REAL addGraphic action over blue footage.
  resetIds();
  const footage = clip("#FF0000FF", { id: "footage", dur: 90, length: 90 }); // #AARRGGBB → opaque BLUE
  (footage as { service?: string }).service = "color";
  const original = timeline(VERTICAL, { video: [videoTrack(footage)] });

  const result = addGraphic(original, {
    clipPath: overlay,
    position: 0,
    durationFrames: 90,
    newTrack: true,
  });
  // addGraphic returns AddGraphicResult (a composed sequence — `inverse` is an
  // OpInvocation[]) or an EditError; discriminate on the presence of `state`.
  if (!("state" in result)) {
    console.error(`FAIL  addGraphic returned an error: ${JSON.stringify(result)}`);
    process.exit(1);
  }

  const mlt = join(OUT, "composite.mlt");
  writeFileSync(mlt, toMlt(result.state));

  // 3) Render a still and sample the bar + non-bar pixels.
  const png = join(OUT, `composite-f${FRAME}.png`);
  const r = await still(mlt, FRAME, png);
  if (r.code !== 0) {
    console.error(`FAIL  melt still failed (code ${r.code}):\n${r.stderr.slice(-400)}`);
    process.exit(1);
  }

  const barHex = pixelHex(png, BAR_SAMPLE.x, BAR_SAMPLE.y);
  const nonBarHex = pixelHex(png, NONBAR_SAMPLE.x, NONBAR_SAMPLE.y);
  const bar = bucket(barHex);
  const nonBar = bucket(nonBarHex);

  console.log(
    `bar     (${BAR_SAMPLE.x},${BAR_SAMPLE.y})  #${barHex}  → ${bar}    (expect red — overlay on top)`,
  );
  console.log(
    `non-bar (${NONBAR_SAMPLE.x},${NONBAR_SAMPLE.y})   #${nonBarHex}  → ${nonBar}   (expect blue — FOOTAGE through transparent overlay)`,
  );

  const failures: string[] = [];
  if (bar !== "red") {
    failures.push(
      `overlay did not composite on top: bar pixel is ${bar} (#${barHex}), expected red`,
    );
  }
  if (nonBar === "black") {
    failures.push(
      `REGRESSION: footage does NOT show through the overlay's transparent region — the black background is winning (non-bar pixel #${nonBarHex}). This is the composite-seam defect.`,
    );
  } else if (nonBar !== "blue") {
    failures.push(`non-bar pixel is ${nonBar} (#${nonBarHex}), expected the footage blue`);
  }

  // 4) The composite is reversible — the inverse reconstructs the original IR.
  let work = result.state;
  for (const inv of result.inverse) {
    const back = apply(inv, work);
    if (isEditError(back)) {
      failures.push(`inverse step errored: ${JSON.stringify(back)}`);
      break;
    }
    work = back.state;
  }
  if (JSON.stringify(work) !== JSON.stringify(original)) {
    failures.push("inverse did not reconstruct the original IR exactly");
  }

  // 5) The serialized composite is a round-trip fixpoint (no determinism drift).
  const a = toMlt(fromMlt(toMlt(result.state)));
  const b = toMlt(fromMlt(a));
  if (a !== b) failures.push("serialized composite is not a round-trip fixpoint");

  console.log("");
  if (failures.length === 0) {
    console.log(
      "OVERALL: PASS — footage shows through the overlay's alpha; the composite is reversible.",
    );
    process.exit(0);
  }
  for (const f of failures) console.log(`FAIL  ${f}`);
  console.log(`\nOVERALL: FAIL — ${failures.length} composite defect(s).`);
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
