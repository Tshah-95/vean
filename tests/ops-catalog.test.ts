import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OP_NAMES, REGISTRY } from "../src/ops";
import { describeOp, listOpDescriptors, resolveOpName, searchOps } from "../src/ops/catalog";

describe("op catalog", () => {
  it("has exactly one descriptor for every public op and no internal inverse op", () => {
    const descriptors = listOpDescriptors();
    expect(descriptors.map((descriptor) => descriptor.op)).toEqual(OP_NAMES);
    expect(descriptors.some((descriptor) => descriptor.op.startsWith("_"))).toBe(false);
  });

  it("uses the registry args schema by reference and validates every example", () => {
    for (const descriptor of listOpDescriptors()) {
      expect(descriptor.input).toBe(REGISTRY[descriptor.op]?.args);
      for (const example of descriptor.examples) {
        expect(() => descriptor.input.parse(example.args)).not.toThrow();
      }
    }
  });

  it("keeps aliases unique and resolves them to canonical ops", () => {
    const aliases = listOpDescriptors().flatMap((descriptor) => descriptor.aliases);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(resolveOpName("crossfade")).toEqual({
      canonicalOp: "dissolve",
      resolvedFrom: "crossfade",
    });
    expect(resolveOpName("trim-out")).toEqual({
      canonicalOp: "trimOut",
      resolvedFrom: "trim-out",
    });
  });

  it("documents trimOut and gain with the public wire semantics", () => {
    const trimOut = describeOp("trimOut").descriptor;
    expect(`${trimOut.summary} ${trimOut.description}`).toMatch(/positive delta shortens/i);
    const source = readFileSync("src/ops/types.ts", "utf8");
    expect(source).toMatch(/trimOut: \+ shortens/);

    const gain = describeOp("gain").descriptor;
    expect(`${gain.summary} ${gain.description}`).toMatch(/decibels|dB/i);
  });

  it("does not expose internal inverse ops through describe or search", () => {
    expect(() => describeOp("_unlift")).toThrow(/unknown op/);
    expect(searchOps("_unlift")).toEqual([]);
  });
});
