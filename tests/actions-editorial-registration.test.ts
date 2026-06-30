// Stream S3 registration gate — the editorial macros + inspect-timeline are
// registered as first-class actions with the right surfaces (CLI command + MCP
// name) and effect metadata (timeline edits are reversible inverse-op writes;
// inspect-timeline is a render). Proven through the public registry API only, so
// it stays a stable JSON contract test (DESIGN-MOVE3 "add a stable JSON test").
import { describe, expect, it } from "vitest";
import { describeAction, getAction, listActions } from "../src/actions";

const EDITORIAL_IDS = [
  "timeline.applyLayout",
  "timeline.addBrollOverRange",
  "timeline.duckMusic",
  "timeline.tightenCut",
  "timeline.removeDeadAir",
] as const;

describe("editorial macro registration", () => {
  it("registers every editorial macro as a reversible timeline-write action", () => {
    const ids = new Set(listActions().map((a) => a.id));
    for (const id of EDITORIAL_IDS) {
      expect(ids).toContain(id);
      const action = getAction(id);
      if (!action) throw new Error(`${id} missing`);
      // A timeline edit: writes the timeline + the document, reversible by inverse op.
      expect(action.scopes).toContain("timeline:write");
      expect(action.effect.mutates).toContain("timeline");
      expect(action.effect.reversibility).toBe("inverse-op");
      // Both CLI + MCP surfaces are projected (the macro is agent- and human-facing).
      const cli = action.surfaces.cli;
      expect(cli && !("hidden" in cli)).toBe(true);
      expect(action.surfaces.mcp?.name).toBeTruthy();
      // The descriptor projects without throwing and is a mutating (non-read) hint.
      const d = describeAction(action);
      expect(d.mcpAnnotations.readOnlyHint).toBe(false);
    }
  });

  it("exposes apply-layout with the three layout modes and a crop-aware description", () => {
    const action = getAction("timeline.applyLayout");
    if (!action) throw new Error("timeline.applyLayout missing");
    // The input schema accepts all three modes and rejects an unknown one.
    expect(
      action.input.safeParse({
        brollResource: "/x.mp4",
        mode: "intercut",
        position: 0,
        durationFrames: 30,
      }).success,
    ).toBe(true);
    expect(
      action.input.safeParse({
        brollResource: "/x.mp4",
        mode: "split",
        position: 0,
        durationFrames: 30,
      }).success,
    ).toBe(true);
    expect(
      action.input.safeParse({
        brollResource: "/x.mp4",
        mode: "overlay",
        position: 0,
        durationFrames: 30,
      }).success,
    ).toBe(true);
    expect(
      action.input.safeParse({
        brollResource: "/x.mp4",
        mode: "bogus",
        position: 0,
        durationFrames: 30,
      }).success,
    ).toBe(false);
    // The description encodes the editorial taste (prefer the layout over a
    // low-level property edit + the crop-without-stretch rule).
    expect(action.description.toLowerCase()).toContain("without stretching");
    expect(action.description.toLowerCase()).toContain("low-level");
  });

  it("registers inspect-timeline as a render action that produces stills", () => {
    const action = getAction("inspect.timeline");
    if (!action) throw new Error("inspect.timeline missing");
    expect(action.effect.kind).toBe("render");
    expect(action.scopes).toContain("render:execute");
    expect(action.surfaces.cli && !("hidden" in action.surfaces.cli)).toBe(true);
    expect(action.surfaces.mcp?.name).toBe("inspect-timeline");
    // The range input validates and the maxFrames cap is enforced by the schema.
    expect(action.input.safeParse({ startFrame: 0, endFrame: 100, maxFrames: 8 }).success).toBe(
      true,
    );
    expect(action.input.safeParse({ startFrame: 0, endFrame: 100, maxFrames: 1000 }).success).toBe(
      false,
    );
  });
});
