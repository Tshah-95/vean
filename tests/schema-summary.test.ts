import { describe, expect, it } from "vitest";
import { z } from "zod";
import { summarizeSchema } from "../src/actions";

describe("schema summaries", () => {
  it("summarizes representative zod shapes used by actions and ops", () => {
    const schema = z
      .object({
        text: z.string(),
        count: z.number().int().default(1),
        enabled: z.boolean().optional(),
        mode: z.enum(["a", "b"]),
        literal: z.literal("fixed"),
        tags: z.array(z.string()),
        choice: z.union([z.string(), z.number()]),
        metadata: z.record(z.string(), z.unknown()),
        refined: z
          .string()
          .min(1)
          .refine((value) => value.length > 0),
      })
      .strict();

    expect(summarizeSchema(schema)).toMatchObject({
      type: "object",
      required: ["text", "mode", "literal", "tags", "choice", "metadata", "refined"],
      properties: {
        text: { type: "string" },
        count: { type: "number", default: 1 },
        enabled: { type: "boolean", optional: true },
        mode: { type: "enum", enum: ["a", "b"] },
        literal: { type: "literal", enum: ["fixed"] },
        tags: { type: "array", items: { type: "string" } },
        choice: { type: "union", union: [{ type: "string" }, { type: "number" }] },
        metadata: { type: "record", items: { type: "unknown" } },
        refined: { type: "string" },
      },
    });
  });

  it("summarizes discriminated unions", () => {
    const schema = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("a"), value: z.string() }),
      z.object({ kind: z.literal("b"), value: z.number() }),
    ]);

    const summary = summarizeSchema(schema);
    expect(summary.type).toBe("union");
    expect(summary.union).toHaveLength(2);
  });
});
