import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    expect(descriptor.inputSummary.type).toBe("object");
    expect(descriptor.outputSummary.type).toBe("unknown");
    expect(descriptor.aliases).toEqual([]);
    expect(descriptor.examples).toEqual([]);
    expect(descriptor.effect).toBe(status.effect);
  });

  it("enriches descriptors for representative actions and points generic timeline ops at op discovery", () => {
    for (const id of [
      "state.status",
      "media.root.add",
      "timeline.previewOp",
      "render.still",
      "discover.manifest",
    ]) {
      const action = getAction(id);
      if (!action) throw new Error(`${id} action missing`);
      const descriptor = describeAction(action);
      expect(descriptor.inputSummary.type).toBe("object");
      expect(descriptor.outputSummary).toBeDefined();
      expect(descriptor.effect).toBe(action.effect);
      expect(descriptor.mcpAnnotations).toBeDefined();
    }

    const apply = getAction("timeline.applyOp");
    const preview = getAction("timeline.previewOp");
    if (!apply || !preview) throw new Error("timeline op actions missing");
    expect(describeAction(apply).relatedDiscovery).toEqual([
      "timeline.ops.list",
      "timeline.ops.describe",
    ]);
    expect(describeAction(preview).relatedDiscovery).toEqual([
      "timeline.ops.list",
      "timeline.ops.describe",
    ]);
  });

  it("keeps every CLI action canonical and present in the discovery manifest", async () => {
    const actions = listActions();
    expect(actions.every((action) => !action.id.includes("crossfade"))).toBe(true);

    const projectRoot = mkdtempSync(join(tmpdir(), "vean-actions-registry-"));
    const configHome = mkdtempSync(join(tmpdir(), "vean-actions-config-"));
    const ctx = createActionContext({
      cwd: projectRoot,
      env: { ...process.env, VEAN_CONFIG_HOME: configHome },
      surface: "test",
    });
    const manifest = await executeAction("discover.manifest", {}, ctx);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const commands = new Set(
      (manifest.output as { commands: Array<{ command: string }> }).commands.map(
        (command) => command.command,
      ),
    );
    for (const action of actions) {
      const cli = action.surfaces.cli;
      if (!cli || "hidden" in cli) continue;
      expect(commands).toContain(cli.command ?? action.id);
    }
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
