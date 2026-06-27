#!/usr/bin/env bun
// still — the still tool from the shell (the agent's EYE: grab one exact frame).
// Drives `melt` to render a single inclusive frame of a `.mlt` to a true PNG,
// through the SAME read/render tool core (`src/bridge/tools/read stillTool`) the
// MCP `still` tool uses — one code path, three surfaces (MCP / CLI / tests).
//
//   bun run still <file.mlt> <frame> [out.png]
//
// Prints the produced PNG path in `touchedUris` (the frame to inspect next) — the
// same field the MCP tool returns. A bad frame (negative/non-integer) or a melt
// failure is a typed failure (a message), not an uncaught throw. A driver verb.
import { stillTool } from "../src/bridge/tools/read";

const USAGE = "usage: bun run still <file.mlt> <frame> [out.png]";

function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
}

/** Default the output beside `out/<stem>-f<frame>.png` when not given. */
function defaultOut(file: string, frame: number): string {
  const stem = (file.split("/").pop() ?? file).replace(/\.mlt$/i, "");
  return `out/${stem}-f${frame}.png`;
}

async function main(): Promise<void> {
  const [, , file, frameArg, outArg] = process.argv;
  if (!file || frameArg === undefined) {
    console.error(USAGE);
    process.exit(2);
  }
  const frame = Number(frameArg);
  if (!Number.isInteger(frame) || frame < 0) {
    console.error(`still: <frame> must be a non-negative integer, got "${frameArg}"`);
    process.exit(2);
  }
  const out = outArg ?? defaultOut(file, frame);
  const outcome = await stillTool(uriToPath(file), frame, out);
  if (!outcome.ok) {
    console.error(`still: ${outcome.kind} — ${outcome.detail}`);
    process.exit(1);
  }
  console.log(`still: produced ${outcome.outPath} (frame ${frame})`);
  console.log(`  touchedUris: ${JSON.stringify(outcome.touchedUris)}`);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
