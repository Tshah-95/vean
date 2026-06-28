import { describe, expect, it } from "vitest";
import { registerTools } from "../src/bridge/mcp/server";

type RegisteredTool = {
  name: string;
  options: {
    title?: string;
    description?: string;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
      openWorldHint?: boolean;
    };
    _meta?: Record<string, unknown>;
  };
  handler: (input: unknown) => unknown;
};

describe("MCP action projection", () => {
  it("registers discovery/timeline tools once with canonical names and registry metadata", () => {
    const tools: RegisteredTool[] = [];
    const server = {
      registerTool(
        name: string,
        options: RegisteredTool["options"],
        handler: RegisteredTool["handler"],
      ) {
        tools.push({ name, options, handler });
      },
    };

    registerTools(server as never);
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual(
      expect.arrayContaining([
        "discover-manifest",
        "discover-search",
        "timeline-ops-list",
        "timeline-ops-describe",
        "timeline-ops-examples",
        "timeline-current",
        "timeline-use",
        "timeline-list",
        "apply-op",
        "preview-op",
      ]),
    );
    expect(names).not.toEqual(expect.arrayContaining(["crossfade", "volume", "trim-out"]));

    const discover = tools.find((tool) => tool.name === "discover-search");
    expect(discover?.options.title).toBe("Search Vean Surface");
    expect(discover?.options.description).toMatch(/^Use this when/);
    expect(discover?.options.annotations?.readOnlyHint).toBe(true);
    expect(discover?.options.annotations?.openWorldHint).toBe(false);
    expect(discover?.options._meta?.["vean/actionId"]).toBe("discover.search");

    const apply = tools.find((tool) => tool.name === "apply-op");
    expect(apply?.options.description).toMatch(/^Use this when/);
    expect(apply?.options.annotations?.readOnlyHint).toBe(false);
    expect(apply?.options.annotations?.destructiveHint).toBe(false);
    expect(apply?.options._meta?.["vean/actionId"]).toBe("timeline.applyOp");
    expect(apply?.options._meta?.["vean/relatedDiscovery"]).toEqual([
      "timeline.ops.list",
      "timeline.ops.describe",
    ]);
  });
});
