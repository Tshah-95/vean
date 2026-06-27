#!/usr/bin/env bun
// render — the render tool from the shell (the agent's "produce an MP4" verb).
// Drives `melt` headless to render a whole `.mlt` to a video file, through the SAME
// read/render tool core (`src/bridge/tools/read renderTool`) the MCP `render` tool
// uses — one code path, three surfaces (MCP / CLI / tests).
//
//   bun run render <file.mlt> [out.mp4]
//
// Prints the produced artifact path in `touchedUris` (the file to inspect next) —
// exactly the field the MCP tool returns, so the CLI and the agent see the same
// "here is what to look at" answer. A nonzero melt exit is a typed failure (a
// stderr tail), not an uncaught throw. This is a driver verb (it shells out to a
// system binary), not part of an agent safety loop.
import { renderTool } from "../src/bridge/tools/read";

const USAGE = "usage: bun run render <file.mlt> [out.mp4]";

function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
}

/** Default the output beside `out/<stem>.mp4` when not given. */
function defaultOut(file: string): string {
  const stem = (file.split("/").pop() ?? file).replace(/\.mlt$/i, "");
  return `out/${stem}.mp4`;
}

async function main(): Promise<void> {
  const [, , file, outArg] = process.argv;
  if (!file) {
    console.error(USAGE);
    process.exit(2);
  }
  const out = outArg ?? defaultOut(file);
  const outcome = await renderTool(uriToPath(file), out);
  if (!outcome.ok) {
    console.error(`render: ${outcome.kind} — ${outcome.detail}`);
    process.exit(1);
  }
  console.log(`render: produced ${outcome.outPath}`);
  console.log(`  touchedUris: ${JSON.stringify(outcome.touchedUris)}`);
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
