#!/usr/bin/env bun
// lint:comps — comp-authoring diagnostics for the live/bake Remotion seam (DESIGN §P5).
// Scans `remotion/src/compositions/*.tsx` for authoring mistakes that break in the vean
// model specifically, and reports them (nonzero exit on any finding, so it gates).
//
// The rules (regex-based — conservative, textual signals only, no full AST):
//   • overlay-audio: a `<Audio>` / sound-bearing `<Video>`/`<OffthreadVideo>` in an
//     overlay comp. MLT owns ALL audio; overlay comps are VIDEO-ONLY — live preview mutes
//     the Player and the export bakes video-only, so this audio plays in NEITHER path.
//   • delay-render-without-buffer: `delayRender()` with no paired `useBufferState()` /
//     `delayPlayback()`. `delayRender` is a NO-OP in preview — the render blocks on the
//     asset (a font, an image) but the live Player does NOT, so preview shows FALLBACK
//     while export shows the real thing (a real preview↔export divergence — DESIGN §2.4).
//
// The `lintCompSource` core is pure + unit-tested (tests/comp-lint.test.ts); this file is
// only the file walk + reporting.
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export interface CompLintFinding {
  level: "warn" | "error";
  rule: "overlay-audio" | "delay-render-without-buffer";
  message: string;
}

/** Strip line + block comments so a rule never fires on commented-out example code. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Lint one comp's TSX SOURCE (pure). Returns findings, empty when clean. */
export function lintCompSource(id: string, rawSource: string): CompLintFinding[] {
  const source = stripComments(rawSource);
  const findings: CompLintFinding[] = [];

  // overlay-audio: an <Audio …> (not muted), or a <Video>/<OffthreadVideo> that doesn't
  // opt out of audio. A `muted` attribute (or `volume={0}`) clears it.
  const audioTag = /<\s*Audio(\s|>|\/)/.test(source);
  const soundVideoTag = /<\s*(OffthreadVideo|Video)(\s|>|\/)/.test(source);
  const isMuted = /\bmuted\b/.test(source) || /volume\s*=\s*\{?\s*0\b/.test(source);
  if (audioTag || (soundVideoTag && !isMuted)) {
    findings.push({
      level: "warn",
      rule: "overlay-audio",
      message: `composition "${id}" embeds audio (<Audio>/<Video>). Overlay comps are VIDEO-ONLY — MLT owns audio; live preview mutes the Player and the export bakes video-only, so this audio plays in neither path. Mute it, or move the sound to an MLT audio track.`,
    });
  }

  // delay-render-without-buffer: delayRender() without a preview-side delayPlayback().
  if (/\bdelayRender\s*\(/.test(source) && !/\b(useBufferState|delayPlayback)\b/.test(source)) {
    findings.push({
      level: "warn",
      rule: "delay-render-without-buffer",
      message: `composition "${id}" calls delayRender() but never useBufferState().delayPlayback(). delayRender is a no-op in preview — the export blocks on the asset but the live Player does not, so preview shows fallback (e.g. a font) while export shows the real thing. Pair the two so both agree on when content is ready.`,
    });
  }

  return findings;
}

function main(): void {
  const ROOT = resolve(import.meta.dirname, "..");
  const dir = join(ROOT, "remotion", "src", "compositions");
  const files = readdirSync(dir).filter((f) => /\.tsx$/.test(f));
  let total = 0;
  for (const file of files.sort()) {
    const id = file.replace(/\.tsx$/, "");
    const findings = lintCompSource(id, readFileSync(join(dir, file), "utf8"));
    for (const f of findings) {
      total++;
      console.log(`${f.level === "error" ? "ERROR" : "warn "} [${f.rule}] ${f.message}`);
    }
  }
  console.log("");
  if (total === 0) {
    console.log(
      `OVERALL: PASS — ${files.length} composition(s) clean (no audio-in-overlay, no unpaired delayRender).`,
    );
    process.exit(0);
  }
  console.log(`OVERALL: FAIL — ${total} comp-authoring finding(s).`);
  process.exit(1);
}

if (import.meta.main) main();
