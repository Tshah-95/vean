// Stable JSON tests for the Move-5 actions: timeline.addComposition,
// timeline.addGraphic, timeline.new, timeline.addAudio. These assert the registry
// shape — effect metadata, scopes, CLI/MCP projection, and presence in the
// discovery manifest — WITHOUT touching the real Remotion/melt subprocesses
// (frame rendering is verified only by the real gate, never in vitest, per
// AGENTS.md). Baking a comp is EXPORT-ONLY (internal to render.video); adding a
// comp to the timeline is a live, no-bake edit (timeline.addComposition).
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

describe("Move-5 actions registry", () => {
  it("registers timeline.addComposition as a live, no-bake timeline update", () => {
    const action = getAction("timeline.addComposition");
    if (!action) throw new Error("timeline.addComposition action missing");
    const d = describeAction(action);
    expect(d.effect.kind).toBe("update");
    expect(d.effect.mutates).toEqual(expect.arrayContaining(["timeline", "filesystem"]));
    expect(d.effect.reversibility).toBe("inverse-op");
    // The whole point: adding a comp does NOT bake — no render/process scope.
    expect(action.scopes).toEqual(expect.arrayContaining(["timeline:write"]));
    expect(action.scopes).not.toContain("render:execute");
    expect(action.scopes).not.toContain("process:execute");
    expect(d.surfaces.cli).toEqual({ command: "timeline add-composition" });
    expect(d.surfaces.mcp).toEqual({ name: "add-composition" });
  });

  it("registers timeline.addGraphic as a reversible timeline update", () => {
    const action = getAction("timeline.addGraphic");
    if (!action) throw new Error("timeline.addGraphic action missing");
    const d = describeAction(action);
    expect(d.effect.kind).toBe("update");
    expect(d.effect.mutates).toEqual(expect.arrayContaining(["timeline", "filesystem"]));
    expect(d.effect.reversibility).toBe("inverse-op");
    expect(d.surfaces.cli).toEqual({ command: "timeline add-graphic" });
    expect(d.surfaces.mcp).toEqual({ name: "add-graphic" });
    expect(d.relatedDiscovery).toEqual(["timeline.addComposition", "timeline.ops.describe"]);
  });

  it("registers timeline.new as a create that writes a file + project state", () => {
    const action = getAction("timeline.new");
    if (!action) throw new Error("timeline.new action missing");
    const d = describeAction(action);
    expect(d.effect.kind).toBe("create");
    expect(d.effect.mutates).toEqual(expect.arrayContaining(["filesystem", "projectState"]));
    expect(d.surfaces.cli).toEqual({ command: "timeline new" });
    expect(d.surfaces.mcp).toEqual({ name: "timeline-new" });
  });

  it("registers timeline.addAudio with the add-music alias + inverse-op reversibility", () => {
    const action = getAction("timeline.addAudio");
    if (!action) throw new Error("timeline.addAudio action missing");
    const d = describeAction(action);
    expect(d.effect.kind).toBe("update");
    expect(d.effect.reversibility).toBe("inverse-op");
    expect(d.aliases).toEqual(["add-music"]);
    expect(d.surfaces.cli).toEqual({ command: "timeline add-audio" });
    expect(d.surfaces.mcp).toEqual({ name: "add-audio" });
  });

  it("lists every new CLI command in the discovery manifest", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vean-move5-actions-"));
    const configHome = mkdtempSync(join(tmpdir(), "vean-move5-config-"));
    const ctx = createActionContext({
      cwd: projectRoot,
      env: { ...process.env, VEAN_CONFIG_HOME: configHome },
      surface: "test",
    });
    const manifest = await executeAction("discover.manifest", {}, ctx);
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;
    const commands = new Set(
      (manifest.output as { commands: Array<{ command: string }> }).commands.map((c) => c.command),
    );
    for (const cmd of [
      "timeline add-composition",
      "timeline add-graphic",
      "timeline new",
      "timeline add-audio",
    ]) {
      expect(commands).toContain(cmd);
    }
  });

  it("keeps every CLI action present in the discovery manifest (registry invariant)", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vean-move5-inv-"));
    const configHome = mkdtempSync(join(tmpdir(), "vean-move5-inv-config-"));
    const ctx = createActionContext({
      cwd: projectRoot,
      env: { ...process.env, VEAN_CONFIG_HOME: configHome },
      surface: "test",
    });
    const manifest = await executeAction("discover.manifest", {}, ctx);
    if (!manifest.ok) throw new Error("manifest failed");
    const commands = new Set(
      (manifest.output as { commands: Array<{ command: string }> }).commands.map((c) => c.command),
    );
    for (const action of listActions()) {
      const cli = action.surfaces.cli;
      if (!cli || "hidden" in cli) continue;
      expect(commands).toContain(cli.command ?? action.id);
    }
  });
});
