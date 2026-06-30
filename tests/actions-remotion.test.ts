// Stable JSON tests for the Move-5 actions: remotion.render, timeline.addGraphic,
// timeline.new, timeline.addAudio. These assert the registry shape — effect
// metadata, scopes, CLI/MCP projection, and presence in the discovery manifest —
// WITHOUT touching the real Remotion/melt subprocesses (frame rendering is
// verified only by the real gate, never in vitest, per AGENTS.md).
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
  it("registers remotion.render with render-effect metadata + CLI/MCP projection", () => {
    const action = getAction("remotion.render");
    if (!action) throw new Error("remotion.render action missing");
    const d = describeAction(action);
    expect(d.effect.kind).toBe("render");
    expect(d.effect.mutates).toEqual(expect.arrayContaining(["filesystem", "process"]));
    expect(d.effect.idempotency).toBe("idempotent");
    expect(d.effect.openWorld).toBe(false);
    expect(d.effect.job).toMatchObject({ mode: "inline", cancellable: true, retrySafe: true });
    expect(d.surfaces.cli).toEqual({ command: "remotion render" });
    expect(d.surfaces.mcp).toEqual({ name: "remotion-render" });
    expect(action.scopes).toEqual(
      expect.arrayContaining([
        "render:execute",
        "process:execute",
        "fs:read",
        "fs:write",
        "state:read",
        "state:write",
      ]),
    );
    // Read-only hint must be false (it mutates), destructive false.
    expect(d.mcpAnnotations.readOnlyHint).toBe(false);
    expect(d.mcpAnnotations.destructiveHint).toBe(false);
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
    expect(d.relatedDiscovery).toEqual(["remotion.render", "timeline.ops.describe"]);
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
      "remotion render",
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

  it("rejects a non-integer-fps profile with a typed unsupported-fps failure", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vean-move5-fps-"));
    const configHome = mkdtempSync(join(tmpdir(), "vean-move5-fps-config-"));
    const ctx = createActionContext({
      cwd: projectRoot,
      env: { ...process.env, VEAN_CONFIG_HOME: configHome },
      surface: "test",
    });
    const envelope = await executeAction(
      "remotion.render",
      { composition: "LowerThird", profile: "landscape-2997" },
      ctx,
    );
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    expect(envelope.output).toMatchObject({ ok: false, kind: "unsupported-fps" });
  });
});
