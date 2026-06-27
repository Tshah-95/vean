import { describe, expect, it } from "vitest";
import {
  createActionContext,
  describeAction,
  executeAction,
  getAction,
  listActions,
} from "../src/actions";

describe("action registry", () => {
  it("lists the seeded Move-3 public actions with effect projections", () => {
    const ids = listActions().map((action) => action.id);
    expect(ids).toContain("setup.doctor");
    expect(ids).toContain("state.init");
    expect(ids).toContain("timeline.previewOp");
    expect(ids).toContain("render.still");
    expect(ids).toContain("project.use");
    expect(ids).toContain("jobs.claim");

    const status = getAction("state.status");
    if (!status) throw new Error("state.status action missing");
    const descriptor = describeAction(status);
    expect(descriptor.mcpAnnotations.readOnlyHint).toBe(true);
    expect(descriptor.mcpAnnotations.destructiveHint).toBe(false);
    expect(descriptor.surfaces.cli).toEqual({ command: "state status" });
  });

  it("returns stable typed envelopes for unknown and invalid actions", async () => {
    const ctx = createActionContext({ surface: "test" });

    await expect(executeAction("missing.action", {}, ctx)).resolves.toMatchObject({
      ok: false,
      actionId: "missing.action",
      kind: "not-found",
    });

    await expect(executeAction("jobs.claim", {}, ctx)).resolves.toMatchObject({
      ok: false,
      actionId: "jobs.claim",
      kind: "validation",
    });
  });
});
