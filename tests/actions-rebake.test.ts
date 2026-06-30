// Stable JSON tests for the graphic.rebake action (the RE-BAKE step of the
// Remotion-overlay effort). These assert the registry shape — effect metadata,
// scopes, CLI/MCP projection, discovery-manifest presence — and the input
// schema's identification contract WITHOUT touching the real Remotion subprocess
// (a full render is verified only by the real gate, never in vitest).
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createActionContext, describeAction, executeAction, getAction } from "../src/actions";

describe("graphic.rebake action", () => {
  it("registers with render-effect metadata + CLI/MCP projection", () => {
    const action = getAction("graphic.rebake");
    if (!action) throw new Error("graphic.rebake action missing");
    const d = describeAction(action);
    expect(d.effect.kind).toBe("render");
    expect(d.effect.mutates).toEqual(expect.arrayContaining(["filesystem", "process"]));
    expect(d.effect.idempotency).toBe("idempotent");
    expect(d.effect.openWorld).toBe(false);
    expect(d.effect.destructive).toBe(false);
    expect(d.effect.job).toMatchObject({ mode: "inline", cancellable: true, retrySafe: true });
    expect(d.surfaces.cli).toEqual({ command: "remotion rebake" });
    expect(d.surfaces.mcp).toEqual({ name: "rebake-graphic" });
    expect(d.relatedDiscovery).toEqual(["remotion.render", "timeline.addGraphic"]);
    expect(action.scopes).toEqual(
      expect.arrayContaining([
        "timeline:read",
        "render:execute",
        "process:execute",
        "fs:read",
        "fs:write",
        "state:read",
        "state:write",
      ]),
    );
    // It mutates the filesystem/process, so it is not read-only.
    expect(d.mcpAnnotations.readOnlyHint).toBe(false);
    expect(d.mcpAnnotations.idempotentHint).toBe(true);
  });

  it("requires EXACTLY ONE of composition or clipUuid", () => {
    const action = getAction("graphic.rebake");
    if (!action) throw new Error("graphic.rebake action missing");
    // Neither → invalid.
    expect(action.input.safeParse({}).success).toBe(false);
    // Both → invalid (ambiguous identity).
    expect(action.input.safeParse({ composition: "LowerThird", clipUuid: "clip-1" }).success).toBe(
      false,
    );
    // Composition alone → valid (direct identity).
    const direct = action.input.safeParse({ composition: "LowerThird", props: { title: "hi" } });
    expect(direct.success).toBe(true);
    if (direct.success) {
      // The default profile is applied by the schema.
      expect((direct.data as { profile: string }).profile).toBe("vertical");
    }
    // Clip uuid alone → valid (in-timeline identity).
    expect(action.input.safeParse({ clipUuid: "clip-1", timeline: "timeline:main" }).success).toBe(
      true,
    );
  });

  it("appears in the discovery manifest as `remotion rebake`", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vean-rebake-disc-"));
    const configHome = mkdtempSync(join(tmpdir(), "vean-rebake-disc-config-"));
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
    expect(commands).toContain("remotion rebake");
  });

  it("rejects an unsupported (non-integer-fps) profile via the delegated render", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vean-rebake-fps-"));
    const configHome = mkdtempSync(join(tmpdir(), "vean-rebake-fps-config-"));
    const ctx = createActionContext({
      cwd: projectRoot,
      env: { ...process.env, VEAN_CONFIG_HOME: configHome },
      surface: "test",
    });
    const envelope = await executeAction(
      "graphic.rebake",
      { composition: "LowerThird", profile: "landscape-2997" },
      ctx,
    );
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    // The delegated remotion.render short-circuits on the unsupported fps BEFORE
    // any subprocess runs — so this exercises the clip-free rebake path cheaply.
    expect(envelope.output).toMatchObject({ ok: false, kind: "unsupported-fps" });
  });

  it("carries the clip-mode address fields through input validation", () => {
    const action = getAction("graphic.rebake");
    if (!action) throw new Error("graphic.rebake action missing");
    // Clip mode addresses an overlay by uuid on a timeline route (+ optional repo);
    // the parse must preserve those fields so execute() can resolve the document.
    // (Executing clip mode requires the Bun runtime for the .mlt read, which the
    // real CLI/MCP surfaces provide and the headless render gate exercises — it is
    // out of scope for the Node-runtime vitest, per AGENTS.md.)
    const parsed = action.input.safeParse({
      clipUuid: "overlay-7",
      timeline: "timeline:main",
      repo: "/tmp/some/repo",
      props: { title: "edited" },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const data = parsed.data as {
      clipUuid: string;
      timeline: string;
      repo: string;
      props: Record<string, unknown>;
    };
    expect(data.clipUuid).toBe("overlay-7");
    expect(data.timeline).toBe("timeline:main");
    expect(data.repo).toBe("/tmp/some/repo");
    expect(data.props).toEqual({ title: "edited" });
  });
});
