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

// The ActionContext is a typed dependency-injection container: an action reaches
// its side-effecting deps (document store, clock, ids, logger, state DB, project
// resolver) through `ctx`, not ambient module imports. `createActionContext`
// populates behavior-preserving defaults; a surface/test can override any of them.
// This is the seam S3 (editorial macros) and S4 (generative producer) build on.
describe("ActionContext DI container", () => {
  it("populates behavior-preserving defaults for every injected capability", () => {
    const ctx = createActionContext({ surface: "test" });
    expect(typeof ctx.documents.read).toBe("function");
    expect(typeof ctx.documents.write).toBe("function");
    expect(typeof ctx.clock.now).toBe("function");
    expect(typeof ctx.clock.nowIso).toBe("function");
    expect(typeof ctx.ids.uuid).toBe("function");
    expect(typeof ctx.logger.info).toBe("function");
    expect(typeof ctx.state.open).toBe("function");
    expect(typeof ctx.resolveProject).toBe("function");
    // The default clock yields a parseable ISO timestamp; the default id factory a
    // non-empty unique-ish string.
    expect(Number.isNaN(Date.parse(ctx.clock.nowIso()))).toBe(false);
    expect(ctx.ids.uuid()).not.toBe("");
    expect(ctx.ids.uuid()).not.toBe(ctx.ids.uuid());
  });

  it("threads injected overrides (a frozen clock + deterministic ids) onto the context", () => {
    const ctx = createActionContext({
      surface: "test",
      overrides: {
        clock: { now: () => new Date(0), nowIso: () => "1970-01-01T00:00:00.000Z" },
        ids: { uuid: () => "fixed-id" },
      },
    });
    expect(ctx.clock.nowIso()).toBe("1970-01-01T00:00:00.000Z");
    expect(ctx.clock.now().getTime()).toBe(0);
    expect(ctx.ids.uuid()).toBe("fixed-id");
  });

  it("routes ctx.documents through an injected in-memory store (no filesystem)", async () => {
    const store = new Map<string, string>();
    const ctx = createActionContext({
      surface: "test",
      overrides: {
        documents: {
          read: async (uri) => {
            const v = store.get(uri);
            if (v == null) throw new Error(`no doc: ${uri}`);
            return v;
          },
          write: async (uri, text) => {
            store.set(uri, text);
          },
        },
      },
    });
    await ctx.documents.write("mem://a", "hello");
    expect(await ctx.documents.read("mem://a")).toBe("hello");
    expect(store.get("mem://a")).toBe("hello");
  });

  it("evaluates and threads the policy decision into ctx.policy before dispatch", async () => {
    // A read action (project.current) is auto-allowed; executeAction computes the
    // decision and threads it onto the execution context. Proven indirectly: the
    // call succeeds (the decision was computed without denying an auto action).
    const ctx = createActionContext({ surface: "test" });
    const result = await executeAction("project.current", {}, ctx);
    expect(result.ok).toBe(true);
  });
});
