#!/usr/bin/env bun
// verify:move5 — the END-TO-END gate for the Move-5 demo fixture (corpus/demo).
// This is the render-faithfulness proof for the whole producer→composite→export
// pipeline: the vean lower-third (a Remotion alpha clip) composited over a moving
// footage base via qtblend, with an audio bed, exported to a real mp4.
//
//   bun run verify:move5
//
// It is intentionally NOT part of `verify:corpus` (which globs top-level
// corpus/*.mlt only): the demo references corpus/demo/lower-third.mov, a gitignored
// binary that only exists after `bun run demo:build`. So this gate OWNS the demo's
// render proof and regenerates the overlay itself.
//
// CHECKS (each a hard FAIL — never a silent pass):
//   1. ALPHA      — the Remotion overlay carries an alpha plane (pix_fmt ~ yuva*).
//   2. COMPOSITE  — a still inside the overlay range shows the footage THROUGH the
//                   overlay's transparent regions (NOT black) and the dark bar ON
//                   TOP; the footage colour DRIFTS between two frames (proof the
//                   overlay composites over CHANGING footage, not a frozen frame).
//   3. EXPORT     — `vean render video` produces an mp4 with exactly one VIDEO and
//                   one AUDIO stream (the tone bed survives the export).
//
// Requires `melt` + `ffmpeg` + `ffprobe` on PATH and a `bun install`'d remotion/.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");
const DEMO_MLT = "corpus/demo/demo.mlt"; // repo-relative (run with cwd = ROOT)
const OVERLAY_MOV = join(ROOT, "corpus", "demo", "lower-third.mov");
const OUT = join(ROOT, "out", "verify-move5");

const failures: string[] = [];
const pass = (msg: string) => console.log(`ok    ${msg}`);
const fail = (msg: string) => {
  failures.push(msg);
  console.log(`FAIL  ${msg}`);
};

/** Run the vean CLI, parse the trailing JSON object from stdout. */
function vean(args: string[]): Record<string, unknown> {
  const out = execFileSync("bun", [CLI, ...args, "--json"], { cwd: ROOT, encoding: "utf8" });
  // The CLI prints a single JSON object for --json; parse the whole stdout.
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

/** Count streams of a given codec_type in a media file. */
function streamCount(path: string, codecType: "video" | "audio"): number {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      codecType === "video" ? "v" : "a",
      "-show_entries",
      "stream=index",
      "-of",
      "csv=p=0",
      path,
    ],
    { encoding: "utf8" },
  ).trim();
  return out ? out.split("\n").filter(Boolean).length : 0;
}

/** The RRGGBB hex of one pixel of a PNG via ffmpeg rawvideo. */
function pixelHex(png: string, x: number, y: number): string {
  const out = execFileSync(
    "sh",
    [
      "-c",
      `ffmpeg -hide_banner -loglevel error -i '${png}' -vf "crop=1:1:${x}:${y}" -f rawvideo -pix_fmt rgb24 - | xxd -p`,
    ],
    { encoding: "utf8" },
  ).trim();
  return out;
}

function isDark(hex: string): boolean {
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return r < 45 && g < 45 && b < 60;
}

function isBlack(hex: string): boolean {
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return r < 16 && g < 16 && b < 16;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  // ── 0) (Re)build the demo: render the overlay + author demo.mlt. ──
  console.log("→ building demo fixture (overlay render + demo.mlt) …");
  execFileSync("bun", [join(ROOT, "corpus", "demo", "build-demo.ts")], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "inherit",
  });

  // ── 1) ALPHA ──
  const pf = ffprobePixFmt(OVERLAY_MOV);
  if (/yuva/.test(pf)) pass(`alpha    overlay pix_fmt=${pf} (carries an alpha plane)`);
  else fail(`alpha    overlay pix_fmt=${pf} has NO alpha plane (expected yuva*)`);

  // ── 2) COMPOSITE (two stills inside the overlay range) ──
  // The base cross-fades teal → indigo; sample the same point at f45 (teal) and
  // f80 (indigo) to prove the overlay composites over CHANGING footage, and a bar
  // pixel to prove the overlay is on top.
  const f45 = join(OUT, "demo-f45.png");
  const f80 = join(OUT, "demo-f80.png");
  const s45 = vean(["render", "still", DEMO_MLT, "45", "--out", f45]);
  const s80 = vean(["render", "still", DEMO_MLT, "80", "--out", f80]);
  if (!s45.ok || !s80.ok) {
    fail(`composite still render failed (f45.ok=${s45.ok} f80.ok=${s80.ok})`);
  } else {
    // Transparent-overlay region near the top of the frame (the bar is lower-third).
    const bg45 = pixelHex(f45, 540, 300);
    const bg80 = pixelHex(f80, 540, 300);
    // Bar body (lower-third, ~72% down): expect the dark bar on top.
    const bar45 = pixelHex(f45, 300, 1390);

    if (isBlack(bg45)) {
      fail(`composite f45 transparent region is BLACK (#${bg45}) — footage not showing through`);
    } else {
      pass(`composite f45 footage shows through transparent overlay (#${bg45}, not black)`);
    }
    if (bg45 === bg80) {
      fail(`composite footage did not change between f45 and f80 (#${bg45}) — frozen base?`);
    } else {
      pass(`composite footage drifts under overlay: f45 #${bg45} → f80 #${bg80} (moving footage)`);
    }
    if (isDark(bar45)) {
      pass(`composite overlay bar renders ON TOP at lower-third (#${bar45}, dark bar)`);
    } else {
      fail(`composite overlay bar not found on top at (300,1390): #${bar45} (expected dark bar)`);
    }
  }

  // ── 3) EXPORT (mp4 with one video + one audio stream) ──
  const mp4 = join(OUT, "demo.mp4");
  const ex = vean(["render", "video", DEMO_MLT, "--out", mp4]);
  if (!ex.ok) {
    fail(`export render video failed: ${JSON.stringify(ex).slice(0, 200)}`);
  } else {
    const nv = streamCount(mp4, "video");
    const na = streamCount(mp4, "audio");
    if (nv === 1) pass("export mp4 has 1 video stream");
    else fail(`export mp4 has ${nv} video streams (expected 1)`);
    if (na === 1) pass("export mp4 has 1 audio stream (the tone bed survived)");
    else fail(`export mp4 has ${na} audio streams (expected 1 — audio bed lost?)`);
    console.log(`  mp4: ${mp4}`);
  }

  console.log("");
  if (failures.length === 0) {
    console.log(
      "OVERALL: PASS — Move-5 demo composites overlay over moving footage + carries audio.",
    );
    process.exit(0);
  }
  console.log(`OVERALL: FAIL — ${failures.length} defect(s).`);
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
