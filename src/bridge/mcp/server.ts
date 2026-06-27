// vean-mcp — the stdio MCP server binding.
//
// The DOMAIN-ACTION surface (the LSP is the AMBIENT-FEEDBACK surface). It
// registers the vean tool set on a Model Context Protocol server over stdio and
// marshals each call to the transport-free tool core (`../tools/core`), which
// calls the SHARED core (ops / diagnostics / query / driver). The server owns NO
// rules and NO edit logic — it is JSON-in, ToolResult-out.
//
// Tools:
//   • apply-op   (mutating)  → ToolResult {consequences, inverse, touchedUris,
//                              optional alerts}. Persists the new IR to the doc.
//   • preview-op (read)      → the same ToolResult, WITHOUT persisting (a dry run).
//   • undo       (mutating)  → re-applies an inverse invocation.
//   • render / still (driver)→ shells out to melt for an MP4 / a single PNG.
//   • resolve-value-at-frame / find-references (read) → the navigation queries.
//   • diagnose   (debug)     → the FULL set (the one tool allowed to; the explicit
//                              debug verb, NOT the ambient loop).
//
// Tool-output discipline (review lens #3) is enforced in the tool core: mutating
// tools return mutation-local facts and optional alerts for newly introduced
// blocking errors, never a standing health snapshot or full diagnostic dump. The
// full set is the ambient LSP's job + `diagnose`'s job.
//
// STATELESS PROCESS (Hard boundary #3): the server holds no DB and makes no
// network calls. The "document" is a file on disk addressed by a URI/path; a
// mutating tool reads it, applies the op, and writes it back, so the source of
// truth is always the file the LSP also watches — that single shared file is what
// keeps the MCP edit and the ambient LSP diagnostics in lock-step.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { diagnoseTool, parseDoc, serializeDoc } from "../tools/core";
// The mutating tools come straight from their dedicated module (the output
// discipline lives there) — the binding marshals them, it owns no edit logic.
import { mutate, preview, undoTool } from "../tools/mutate";
// The read/render tools come straight from their dedicated module (`../tools/read`)
// — the queries (resolve/refs) + the melt inspect verbs (render/still). render/
// still return `touchedUris` (the produced artifact the agent inspects next); the
// binding marshals their typed outcome, it owns no query or driver logic.
import { isReadError, referencesTool, renderTool, resolveTool, stillTool } from "../tools/read";
import { isToolError } from "../tools/types";

// ─── Document I/O (file-as-document) ─────────────────────────────────────────
/** Strip a `file://` URI to a filesystem path; pass a bare path through. The MCP
 *  tools accept either, so an agent can give the same URI it gave the LSP. */
function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
}

async function readDoc(uri: string): Promise<string> {
  return await Bun.file(uriToPath(uri)).text();
}

async function writeDoc(uri: string, text: string): Promise<void> {
  await Bun.write(uriToPath(uri), text);
}

/** JSON tool reply helper — a single text block carrying the pretty-printed
 *  payload (the MCP content shape). `isError` flags a tool-level failure. */
function reply(
  payload: unknown,
  isError = false,
): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  const out: { content: Array<{ type: "text"; text: string }>; isError?: boolean } = {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
  if (isError) out.isError = true;
  return out;
}

// ─── Tool registration ───────────────────────────────────────────────────────
/** Register every vean tool on a server. Exposed so a test can register against a
 *  server bound to an in-memory transport, or assert the registered set. */
export function registerTools(server: McpServer): void {
  // apply-op — the mutating workhorse. Reads the doc, applies the op via the edit
  // algebra, persists the new IR, returns the focused ToolResult.
  server.registerTool(
    "apply-op",
    {
      description:
        "Apply an edit op to a .mlt document. Returns consequences, the inverse (for undo), touched URIs, and optional alerts only if this edit introduced new blocking errors. Full diagnostics are the ambient vean-lsp's job or the explicit diagnose tool's job. Persists the new document.",
      inputSchema: {
        uri: z.string().describe("file:// URI or path of the .mlt document to edit"),
        op: z.string().describe("the op name (append, split, trimIn, move, dissolve, gain, …)"),
        args: z.record(z.string(), z.unknown()).describe("the op's arguments"),
      },
    },
    async ({ uri, op, args }) => {
      let state: ReturnType<typeof parseDoc>;
      try {
        state = parseDoc(await readDoc(uri));
      } catch (err) {
        return reply({ ok: false, kind: "parse", detail: errMsg(err) }, true);
      }
      const { outcome, newState } = mutate(state, { op, args }, uri);
      if (isToolError(outcome)) return reply(outcome, true);
      if (newState) await writeDoc(uri, serializeDoc(newState));
      return reply(outcome);
    },
  );

  // preview-op — the dry run: the SAME ToolResult, document UNCHANGED.
  server.registerTool(
    "preview-op",
    {
      description:
        "Preview an edit op WITHOUT applying it: returns the same consequences + inverse + optional alerts the edit WOULD produce, but does not change the document. The 'report before you render' surface.",
      inputSchema: {
        uri: z.string(),
        op: z.string(),
        args: z.record(z.string(), z.unknown()),
      },
    },
    async ({ uri, op, args }) => {
      let state: ReturnType<typeof parseDoc>;
      try {
        state = parseDoc(await readDoc(uri));
      } catch (err) {
        return reply({ ok: false, kind: "parse", detail: errMsg(err) }, true);
      }
      const outcome = preview(state, { op, args }, uri);
      return reply(outcome, isToolError(outcome));
    },
  );

  // undo — re-apply a prior result's inverse invocation.
  server.registerTool(
    "undo",
    {
      description:
        "Undo an edit by re-applying its inverse invocation (the `inverse` field a prior apply-op returned). Returns consequences, a redo inverse, touched URIs, and optional alerts.",
      inputSchema: {
        uri: z.string(),
        inverse: z
          .object({ op: z.string(), args: z.record(z.string(), z.unknown()) })
          .describe("the inverse invocation from a prior apply-op result"),
      },
    },
    async ({ uri, inverse }) => {
      let state: ReturnType<typeof parseDoc>;
      try {
        state = parseDoc(await readDoc(uri));
      } catch (err) {
        return reply({ ok: false, kind: "parse", detail: errMsg(err) }, true);
      }
      const { outcome, newState } = undoTool(state, inverse, uri);
      if (isToolError(outcome)) return reply(outcome, true);
      if (newState) await writeDoc(uri, serializeDoc(newState));
      return reply(outcome);
    },
  );

  // resolve-value-at-frame — go-to-definition for video (read).
  server.registerTool(
    "resolve-value-at-frame",
    {
      description:
        "Resolve the effective value of a parameter (a clip filter property, a clip's fade, or a field transition property) at a timeline frame, with the resolution path. Read-only.",
      inputSchema: {
        uri: z.string(),
        frame: z.number().int().nonnegative(),
        target: z.record(z.string(), z.unknown()).describe("the ResolveTarget (scope + ids)"),
      },
    },
    async ({ uri, frame, target }) => {
      let state: ReturnType<typeof parseDoc>;
      try {
        state = parseDoc(await readDoc(uri));
      } catch (err) {
        return reply({ ok: false, kind: "parse", detail: errMsg(err) }, true);
      }
      // The target is validated structurally by the resolver; cast at the boundary.
      const outcome = resolveTool(state, frame, target as never);
      return reply(outcome, isReadError(outcome));
    },
  );

  // find-references — find-all-references (read).
  server.registerTool(
    "find-references",
    {
      description:
        "Find references in the timeline: clips using a source, readers/writers of a property, or a clip's adjacency/ripple set (what moves if it moves). Read-only.",
      inputSchema: {
        uri: z.string(),
        query: z.record(z.string(), z.unknown()).describe("the ReferenceQuery"),
      },
    },
    async ({ uri, query }) => {
      let state: ReturnType<typeof parseDoc>;
      try {
        state = parseDoc(await readDoc(uri));
      } catch (err) {
        return reply({ ok: false, kind: "parse", detail: errMsg(err) }, true);
      }
      const outcome = referencesTool(state, query as never);
      return reply(outcome, isReadError(outcome));
    },
  );

  // diagnose — the DEBUG verb (the one tool allowed to return the FULL set).
  server.registerTool(
    "diagnose",
    {
      description:
        "DEBUG/CI verb: the FULL current diagnostic set + health for a document. This is the ONE tool that returns the full set — call it deliberately for a complete report. After ordinary edits, rely on mutation consequences/alerts + the ambient vean-lsp; do NOT poll this.",
      inputSchema: { uri: z.string() },
    },
    async ({ uri }) => {
      try {
        const state = parseDoc(await readDoc(uri));
        return reply(diagnoseTool(state));
      } catch (err) {
        return reply({ ok: false, kind: "parse", detail: errMsg(err) }, true);
      }
    },
  );

  // render — headless melt render to MP4 (driver). Returns the produced MP4 in
  // `touchedUris` — the artifact the agent inspects next.
  server.registerTool(
    "render",
    {
      description:
        "Render a .mlt document headless to a video file via melt (arm's-length subprocess). Returns the produced MP4 in `touchedUris` (the artifact to inspect next), plus `outPath` and the melt stderr.",
      inputSchema: {
        uri: z.string(),
        out: z.string().describe("output video path (e.g. out/x.mp4)"),
      },
    },
    async ({ uri, out }) => {
      const outcome = await renderTool(uriToPath(uri), out);
      return reply(outcome, isReadError(outcome));
    },
  );

  // still — grab one exact frame to a PNG (driver) — the agent's eyes. Returns the
  // produced PNG in `touchedUris` so the agent reads the frame next.
  server.registerTool(
    "still",
    {
      description:
        "Grab one exact frame (0-based) of a .mlt as a PNG via melt — the perceptual-inspection surface (an agent reads the PNG). Returns the produced PNG in `touchedUris` (the frame to inspect next), plus `outPath`.",
      inputSchema: {
        uri: z.string(),
        frame: z.number().int().nonnegative(),
        out: z.string().describe("output PNG path"),
      },
    },
    async ({ uri, frame, out }) => {
      const outcome = await stillTool(uriToPath(uri), frame, out);
      return reply(outcome, isReadError(outcome));
    },
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Boot the stdio MCP server. */
export async function main(): Promise<void> {
  const server = new McpServer({ name: "vean-mcp", version: "0.1.0" });
  registerTools(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
