#!/usr/bin/env bun
// verify-corpus — the Move-0 render-faithfulness gate. Walks every `.mlt` in
// `corpus/`, round-trips it (parse → IR → serialize) AND renders both the
// original and the re-emitted XML via the `melt` driver, grabs matching still
// frames, and compares them with ffmpeg's SSIM. The render half of the Move-0
// gate: it proves the re-emission doesn't just round-trip as bytes/structure but
// that `melt` PAINTS THE SAME PIXELS from it.
//
//   bun run verify:corpus
//
// Per file it reports two numbers:
//   • round-trip  — does the IR reach a stable fixpoint (see roundtrip.ts)?
//   • SSIM        — min over sampled frames of structural similarity between
//                   original-render and re-emitted-render. 1.000 = pixel-identical.
//
// A file PASSES iff it round-trips AND every sampled frame's SSIM ≥ THRESHOLD.
// Overall PASS iff every corpus file passes. Renders land in `out/verify/`
// (gitignored) and are regenerated each run.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { still } from "../src/driver/melt";
import { fromMlt } from "../src/ir/parse";
import { fpsRatio } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import type { Timeline } from "../src/ir/types";
import { roundtripXml } from "./roundtrip";

/** Structural similarity (0..1) between two PNGs via ffmpeg's `ssim` filter — the
 *  render-faithfulness metric. Returns the `All:` channel-averaged score; 1.0 is
 *  pixel-identical. Throws if ffmpeg can't run or the score line is missing (a
 *  failure to MEASURE is not a silent pass). Exported so it can be unit-tested
 *  against fixtures without the melt driver. */
export function ssimPng(a: string, b: string): number {
  // `-lavfi ssim -f null -` prints e.g. `[Parsed_ssim_0 ...] SSIM ... All:0.998 (..)`
  // to STDERR (stdout is empty under `-f null`). To capture that line regardless of
  // ffmpeg's exit code, merge fd 2 → fd 1 in a shell and read stdout. `|| true`
  // keeps a non-zero ffmpeg from throwing before we can parse the score; a genuinely
  // missing `All:` token is caught by parseSsimAll. Paths are single-quote-escaped.
  const argv = ["-hide_banner", "-i", a, "-i", b, "-lavfi", "ssim", "-f", "null", "-"];
  const cmd = `ffmpeg ${argv.map(sh).join(" ")} 2>&1 || true`;
  const out = execFileSync("sh", ["-c", cmd], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return parseSsimAll(out);
}

/** POSIX single-quote escape for embedding a path in a `sh -c` command. */
function sh(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Pull the `All:` SSIM value from ffmpeg's `ssim` filter output. Pure + exported
 *  so the parsing contract is golden-tested independent of ffmpeg being present. */
export function parseSsimAll(ffmpegStderr: string): number {
  const m = /SSIM[^\n]*\bAll:([0-9.]+)/.exec(ffmpegStderr);
  if (!m?.[1])
    throw new Error(`ssim: no 'All:' score in ffmpeg output:\n${ffmpegStderr.slice(-400)}`);
  return Number(m[1]);
}

const ROOT = resolve(import.meta.dirname, "..");
const CORPUS = join(ROOT, "corpus");
const OUT = join(ROOT, "out", "verify");

/** Per-frame SSIM must clear this to count as render-faithful. 1.0 is pixel-exact;
 *  a hair below absorbs codec/encoder noise (libx264 + scaling) without letting a
 *  real visual regression through. */
const SSIM_THRESHOLD = 0.98;
/** How many evenly-spaced frames to sample across each timeline for comparison. */
const SAMPLES = 5;

/** Total playtime (frames) of a timeline = the longest track's summed item playtime.
 *  A clip plays `out - in + 1`; a blank plays its `length`; a dissolve overlaps so
 *  it removes `frames` from the running total. Used only to pick sample frames. */
function timelineFrames(tl: Timeline): number {
  const trackLen = (items: Timeline["tracks"]["video"][number]["items"]): number => {
    let total = 0;
    for (const it of items) {
      if (it.kind === "clip") total += it.out - it.in + 1;
      else if (it.kind === "blank") total += it.length;
      else if (it.kind === "dissolve") total -= it.frames; // overlap shortens the run
    }
    return Math.max(0, total);
  };
  const all = [...tl.tracks.video, ...tl.tracks.audio];
  return all.reduce((m, t) => Math.max(m, trackLen(t.items)), 0);
}

/** Pick SAMPLES evenly-spaced 0-based frame indices inside [0, frames-1], dropping
 *  the very last frame (often a fade-to-black or 1-frame-short edge that melt and
 *  re-emitted melt can legitimately disagree on by a pixel of rounding). */
function sampleFrames(frames: number): number[] {
  if (frames <= 1) return [0];
  const usable = Math.max(1, frames - 1);
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const f = Math.floor((usable * i) / Math.max(1, SAMPLES - 1));
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

type FileResult = {
  name: string;
  roundtrip: boolean;
  /** min SSIM over sampled frames; null if a render/grab failed. */
  minSsim: number | null;
  perFrame: { frame: number; ssim: number }[];
  pass: boolean;
  note: string;
};

async function verifyFile(name: string, xml: string): Promise<FileResult> {
  // 1) Round-trip (structural). A non-fixpoint is an immediate, cheap fail —
  //    don't burn a render proving pixels for an IR we already know is unstable.
  const rt = roundtripXml(xml);
  if (!rt.pass) {
    return {
      name,
      roundtrip: false,
      minSsim: null,
      perFrame: [],
      pass: false,
      note: "round-trip is not a fixpoint (parser lost/mangled info)",
    };
  }

  // 2) Render-faithfulness. Write the original + re-emitted XML side by side,
  //    render matching stills with the driver, and SSIM-compare them frame-for-frame.
  const tl = fromMlt(xml);
  const frames = timelineFrames(tl);
  const base = join(OUT, name.replace(/\.mlt$/, ""));
  mkdirSync(base, { recursive: true });

  const origMlt = join(base, "orig.mlt");
  const reMlt = join(base, "reemit.mlt");
  writeFileSync(origMlt, xml);
  writeFileSync(reMlt, rt.emitted);

  const samples = sampleFrames(frames);
  const perFrame: { frame: number; ssim: number }[] = [];
  let minSsim = 1;
  for (const f of samples) {
    const origPng = join(base, `orig-f${f}.png`);
    const rePng = join(base, `reemit-f${f}.png`);
    const a = await still(origMlt, f, origPng);
    const b = await still(reMlt, f, rePng);
    if (a.code !== 0 || b.code !== 0) {
      return {
        name,
        roundtrip: true,
        minSsim: null,
        perFrame,
        pass: false,
        note: `melt still failed at frame ${f} (orig code ${a.code}, reemit code ${b.code})`,
      };
    }
    const s = ssimPng(origPng, rePng);
    perFrame.push({ frame: f, ssim: s });
    minSsim = Math.min(minSsim, s);
  }

  const pass = minSsim >= SSIM_THRESHOLD;
  return {
    name,
    roundtrip: true,
    minSsim,
    perFrame,
    pass,
    note: pass
      ? `${frames}f @ ${fpsRatio(tl.profile).toFixed(3)}fps`
      : `min SSIM < ${SSIM_THRESHOLD}`,
  };
}

function listCorpus(): string[] {
  try {
    return readdirSync(CORPUS)
      .filter((f) => f.endsWith(".mlt"))
      .sort();
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const files = listCorpus();
  if (files.length === 0) {
    console.error(`verify:corpus — no .mlt files in ${CORPUS}`);
    console.error("Add corpus files (see corpus/README.md) before running the gate.");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });

  const results: FileResult[] = [];
  for (const name of files) {
    const xml = await Bun.file(join(CORPUS, name)).text();
    let r: FileResult;
    try {
      r = await verifyFile(name, xml);
    } catch (err) {
      r = {
        name,
        roundtrip: false,
        minSsim: null,
        perFrame: [],
        pass: false,
        note: `threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    results.push(r);

    const rtMark = r.roundtrip ? "rt:PASS" : "rt:FAIL";
    const ssimStr = r.minSsim == null ? "ssim:  —  " : `ssim:${r.minSsim.toFixed(4)}`;
    const status = r.pass ? "PASS" : "FAIL";
    console.log(`${status}  ${name.padEnd(28)} ${rtMark}  ${ssimStr}  (${r.note})`);
    if (r.perFrame.length > 0) {
      const cells = r.perFrame.map((p) => `f${p.frame}:${p.ssim.toFixed(4)}`).join("  ");
      console.log(`        ${cells}`);
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log("");
  console.log(
    failed.length === 0
      ? `OVERALL: PASS — ${results.length}/${results.length} corpus files faithful`
      : `OVERALL: FAIL — ${failed.length}/${results.length} failed: ${failed.map((f) => f.name).join(", ")}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
