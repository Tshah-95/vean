#!/usr/bin/env bun
// read-tools artifact gate — the REAL-binary leg of the read/render tool core.
//
// The vitest suite (`tests/read-tools.test.ts`) proves the read/render tools'
// CONTRACT under Node with a fake `Bun.spawn` (argv + touchedUris shape). This is
// its companion: it drives `renderTool` / `stillTool` against a real corpus
// document through the REAL melt binary and asserts a true MP4 / PNG lands on disk
// at exactly the path the tool reports in `touchedUris` — the agent's "inspect the
// frame" loop, end to end, through MY tool surface (not the driver directly).
//
// Exits 1 on any failure (a CI gate, alongside `verify:corpus` and `move2:e2e`).
import { renderTool, stillTool } from "../src/bridge/tools/read";

const SRC = "corpus/vean-multitrack.mlt";
const OUT_DIR = "out/read-tools";
const FRAME = 30;

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  console.log(`  ✓ ${msg}`);
}

async function main(): Promise<void> {
  console.log("read-tools artifact gate — renderTool / stillTool → real files\n");
  // melt's avformat consumer writes INTO the output dir; it must exist first.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(OUT_DIR, { recursive: true });
  const mp4 = `${OUT_DIR}/multitrack.mp4`;
  const png = `${OUT_DIR}/multitrack-f${FRAME}.png`;

  // 1) renderTool → a real MP4; touchedUris names it.
  console.log("[1] renderTool → MP4");
  const rendered = await renderTool(SRC, mp4);
  if (!rendered.ok) console.error(`  (render failed: ${rendered.kind} — ${rendered.detail})`);
  assert(rendered.ok, "renderTool returned ok (no thrown MeltError)");
  if (!rendered.ok) process.exit(1);
  assert(rendered.touchedUris.length === 1, "render touchedUris has exactly one entry");
  assert(rendered.touchedUris[0] === mp4, "render touchedUris names the produced MP4");
  assert(rendered.outPath === mp4, "render outPath mirrors touchedUris");
  const mp4File = Bun.file(mp4);
  assert(
    (await mp4File.exists()) && mp4File.size > 0,
    `the MP4 is real on disk (${mp4File.size} bytes)`,
  );

  // 2) stillTool → a real PNG; touchedUris names it (the frame the agent reads).
  console.log("\n[2] stillTool → PNG (the agent's eye)");
  const grabbed = await stillTool(SRC, FRAME, png);
  assert(grabbed.ok, "stillTool returned ok");
  if (!grabbed.ok) process.exit(1);
  assert(grabbed.touchedUris[0] === png, "still touchedUris names the produced PNG");
  const pngFile = Bun.file(png);
  assert(
    (await pngFile.exists()) && pngFile.size > 0,
    `the PNG is a real frame on disk (${pngFile.size} bytes)`,
  );
  // It is a TRUE PNG (the driver pins vcodec=png; the magic bytes confirm it).
  const head = new Uint8Array(await pngFile.slice(0, 8).arrayBuffer());
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  assert(isPng, "the artifact is a true PNG (magic bytes \\x89PNG), not a JPEG in a .png");

  // 3) a typed failure (not a throw) on a missing document.
  console.log("\n[3] a missing document is a typed ReadError, not a throw");
  const missing = await renderTool("corpus/does-not-exist.mlt", `${OUT_DIR}/never.mp4`);
  assert(!missing.ok, "renderTool on a missing doc returns ok:false (typed error)");
  if (!missing.ok) assert(missing.kind === "render", "the failure is kind 'render'");

  const pass = process.exitCode !== 1;
  console.log(
    `\n${pass ? "OVERALL PASS" : "OVERALL FAIL"} — read/render tools produce real artifacts`,
  );
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
