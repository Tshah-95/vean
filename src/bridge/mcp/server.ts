#!/usr/bin/env bun
// vean-mcp — the stdio MCP server binding.
//
// MCP is an adapter over the action registry. Product behavior is defined once in
// `src/actions`; this module projects actions with `surfaces.mcp` metadata into
// MCP tools and owns only transport marshalling.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createActionContext, describeAction, executeAction, listActions } from "../../actions";

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

function objectShape(schema: z.ZodType<unknown>): z.ZodRawShape {
  if (schema instanceof z.ZodObject) return schema.shape;
  return { input: schema };
}

function outputIsToolError(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    "ok" in output &&
    (output as { ok?: unknown }).ok === false
  );
}

/** Register every MCP-exposed vean action on a server. */
export function registerTools(server: McpServer): void {
  for (const action of listActions()) {
    const mcp = action.surfaces.mcp;
    if (!mcp || mcp.hidden) continue;
    const descriptor = describeAction(action);
    server.registerTool(
      mcp.name ?? action.id,
      {
        description: action.description,
        inputSchema: objectShape(action.input),
        annotations: descriptor.mcpAnnotations,
      },
      async (input) => {
        const envelope = await executeAction(
          action.id,
          input,
          createActionContext({ surface: "mcp" }),
        );
        if (!envelope.ok) return reply(envelope, true);
        return reply(envelope.output, outputIsToolError(envelope.output));
      },
    );
  }
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
