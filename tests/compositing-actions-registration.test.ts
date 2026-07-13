import { describe, expect, it } from "vitest";
import { describeAction, getAction } from "../src/actions";

describe("scene compositing action registration", () => {
  it.each([
    ["timeline.animateTransform", "timeline animate-transform", "animate-transform"],
    ["timeline.applySubjectAlpha", "timeline apply-subject-alpha", "apply-subject-alpha"],
  ])("projects %s to CLI and MCP", (id, cli, mcp) => {
    const action = getAction(id);
    if (!action) throw new Error(`${id} missing`);
    expect(action.surfaces.cli).toEqual({ command: cli });
    expect(action.surfaces.mcp?.name).toBe(mcp);
    expect(action.effect.reversibility).toBe("inverse-op");
    expect(describeAction(action).mcpAnnotations.readOnlyHint).toBe(false);
  });

  it("validates arbitrary normalized and pixel slots", () => {
    const action = getAction("timeline.animateTransform");
    if (!action) throw new Error("timeline.animateTransform missing");
    expect(
      action.input.safeParse({
        clipId: "clip-1",
        startFrame: 10,
        endFrame: 20,
        from: { x: 0, y: 0, width: 1, height: 1 },
        to: { unit: "pixels", x: 700, y: 100, width: 300, height: 1600 },
      }).success,
    ).toBe(true);
    expect(
      action.input.safeParse({
        clipId: "clip-1",
        startFrame: 10,
        endFrame: 20,
        from: { x: 0, y: 0, width: 0, height: 1 },
        to: { x: 0, y: 0, width: 1, height: 1 },
      }).success,
    ).toBe(false);
  });
});
