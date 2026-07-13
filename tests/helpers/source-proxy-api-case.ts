// Bun-hosted API integration case. Root Vitest runs under Node, which cannot load
// bun:sqlite; this helper runs the real preview handler in its production runtime.
import { createPreviewHandler } from "../../src/preview/server";

const [root, source, timeline] = process.argv.slice(2);
if (!root || !source || !timeline) throw new Error("expected root source timeline");
const handler = createPreviewHandler({ repo: root, timeline, port: 0, dev: false });
const response = await handler(
  new Request(
    `http://127.0.0.1/api/source-proxy?path=${encodeURIComponent(source)}&route=${encodeURIComponent(timeline)}`,
  ),
);
console.log(JSON.stringify({ status: response.status, body: await response.json() }));
