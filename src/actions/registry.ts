import { resolve } from "node:path";
import { z } from "zod";
import {
  projectConfigPath,
  resolveProject,
  resolveProjectReference,
  setActiveProject,
} from "../project/context";
import type {
  ActionContext,
  ActionDefinition,
  ActionDescriptor,
  ActionEffect,
  ActionEnvelope,
} from "./types";

const jsonString = z
  .string()
  .default("{}")
  .refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, "expected valid JSON");

const repoInput = z.object({ repo: z.string().optional() });
const projectInput = z.object({ project: z.string().optional() });
const emptyInput = z.object({}).strict();

function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
}

async function readDoc(uri: string): Promise<string> {
  return await Bun.file(uriToPath(uri)).text();
}

async function writeDoc(uri: string, text: string): Promise<void> {
  await Bun.write(uriToPath(uri), text);
}

const baseEffects = {
  read: {
    kind: "read",
    mutates: [],
    openWorld: false,
    destructive: false,
    idempotency: "pure",
    reversibility: "none-needed",
    dryRun: "none",
    approval: "auto",
    audit: "none",
  },
  stateRead: {
    kind: "read",
    mutates: [],
    openWorld: false,
    destructive: false,
    idempotency: "pure",
    reversibility: "none-needed",
    dryRun: "none",
    approval: "auto",
    audit: "metadata",
  },
  stateWrite: {
    kind: "update",
    mutates: ["projectState"],
    openWorld: false,
    destructive: false,
    idempotency: "idempotent",
    reversibility: "snapshot",
    dryRun: "none",
    approval: "ask",
    audit: "metadata",
  },
  jobWrite: {
    kind: "update",
    mutates: ["jobState"],
    openWorld: false,
    destructive: false,
    idempotency: "non-idempotent",
    reversibility: "manual",
    dryRun: "none",
    approval: "ask",
    audit: "metadata",
    job: { mode: "inline", cancellable: false, retrySafe: false },
  },
} satisfies Record<string, ActionEffect>;

function action<I, O>(definition: ActionDefinition<I, O>): ActionDefinition<I, O> {
  return definition;
}

export function createActionContext(options: {
  cwd?: string;
  surface?: ActionContext["surface"];
  project?: string;
  env?: NodeJS.ProcessEnv;
}): ActionContext {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  return {
    cwd,
    surface: options.surface ?? "cli",
    env,
    project: resolveProject({ project: options.project, cwd, env }),
  };
}

const actions = [
  action({
    id: "timeline.applyOp",
    title: "Apply Timeline Operation",
    description: "Apply an edit operation to a .mlt document and persist the result.",
    input: z.object({
      uri: z.string(),
      op: z.string(),
      args: z.record(z.string(), z.unknown()).default({}),
    }),
    output: z.unknown(),
    scopes: ["timeline:write", "fs:read", "fs:write"],
    effect: {
      kind: "update",
      mutates: ["timeline", "filesystem"],
      openWorld: false,
      destructive: false,
      idempotency: "non-idempotent",
      reversibility: "inverse-op",
      dryRun: "supported",
      approval: "ask",
      audit: "full-input",
    },
    surfaces: { cli: { command: "timeline apply-op" }, mcp: { name: "apply-op" } },
    async execute(_ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { mutate } = await import("../bridge/tools/mutate");
      const { isToolError } = await import("../bridge/tools/types");
      const state = parseDoc(await readDoc(input.uri));
      const { outcome, newState } = mutate(state, { op: input.op, args: input.args }, input.uri);
      if (!isToolError(outcome) && newState) await writeDoc(input.uri, serializeDoc(newState));
      return outcome;
    },
  }),
  action({
    id: "timeline.previewOp",
    title: "Preview Timeline Operation",
    description: "Preview an edit operation without changing the document.",
    input: z.object({
      uri: z.string(),
      op: z.string(),
      args: z.record(z.string(), z.unknown()).default({}),
    }),
    output: z.unknown(),
    scopes: ["timeline:read", "fs:read"],
    effect: {
      kind: "preview",
      mutates: [],
      openWorld: false,
      destructive: false,
      idempotency: "pure",
      reversibility: "none-needed",
      dryRun: "none",
      approval: "auto",
      audit: "full-input",
    },
    surfaces: { cli: { command: "timeline preview-op" }, mcp: { name: "preview-op" } },
    async execute(_ctx, input) {
      const { parseDoc } = await import("../bridge/tools/core");
      const { preview } = await import("../bridge/tools/mutate");
      const state = parseDoc(await readDoc(input.uri));
      return preview(state, { op: input.op, args: input.args }, input.uri);
    },
  }),
  action({
    id: "timeline.undo",
    title: "Undo Timeline Operation",
    description: "Undo an edit by applying a prior result's inverse invocation.",
    input: z.object({
      uri: z.string(),
      inverse: z.object({ op: z.string(), args: z.record(z.string(), z.unknown()) }),
    }),
    output: z.unknown(),
    scopes: ["timeline:write", "fs:read", "fs:write"],
    effect: {
      kind: "update",
      mutates: ["timeline", "filesystem"],
      openWorld: false,
      destructive: false,
      idempotency: "non-idempotent",
      reversibility: "inverse-op",
      dryRun: "supported",
      approval: "ask",
      audit: "full-input",
    },
    surfaces: { cli: { command: "timeline undo" }, mcp: { name: "undo" } },
    async execute(_ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { undoTool } = await import("../bridge/tools/mutate");
      const { isToolError } = await import("../bridge/tools/types");
      const state = parseDoc(await readDoc(input.uri));
      const { outcome, newState } = undoTool(state, input.inverse, input.uri);
      if (!isToolError(outcome) && newState) await writeDoc(input.uri, serializeDoc(newState));
      return outcome;
    },
  }),
  action({
    id: "timeline.diagnose",
    title: "Diagnose Timeline",
    description: "Debug/CI verb that returns the full diagnostic set for a document.",
    input: z.object({ uri: z.string() }),
    output: z.unknown(),
    scopes: ["timeline:read", "fs:read"],
    effect: baseEffects.read,
    surfaces: { cli: { command: "timeline diagnose" }, mcp: { name: "diagnose" } },
    async execute(_ctx, input) {
      const { diagnoseTool, parseDoc } = await import("../bridge/tools/core");
      return diagnoseTool(parseDoc(await readDoc(input.uri)));
    },
  }),
  action({
    id: "timeline.resolveValueAtFrame",
    title: "Resolve Value At Frame",
    description: "Resolve a parameter's effective value at a timeline frame.",
    input: z.object({
      uri: z.string(),
      frame: z.number().int().nonnegative(),
      target: z.record(z.string(), z.unknown()),
    }),
    output: z.unknown(),
    scopes: ["timeline:read", "fs:read"],
    effect: baseEffects.read,
    surfaces: {
      cli: { command: "timeline resolve-value-at-frame" },
      mcp: { name: "resolve-value-at-frame" },
    },
    async execute(_ctx, input) {
      const { parseDoc } = await import("../bridge/tools/core");
      const { resolveTool } = await import("../bridge/tools/read");
      return resolveTool(parseDoc(await readDoc(input.uri)), input.frame, input.target as never);
    },
  }),
  action({
    id: "timeline.findReferences",
    title: "Find References",
    description: "Find references in the timeline graph.",
    input: z.object({
      uri: z.string(),
      query: z.record(z.string(), z.unknown()),
    }),
    output: z.unknown(),
    scopes: ["timeline:read", "fs:read"],
    effect: baseEffects.read,
    surfaces: { cli: { command: "timeline find-references" }, mcp: { name: "find-references" } },
    async execute(_ctx, input) {
      const { parseDoc } = await import("../bridge/tools/core");
      const { referencesTool } = await import("../bridge/tools/read");
      return referencesTool(parseDoc(await readDoc(input.uri)), input.query as never);
    },
  }),
  action({
    id: "render.video",
    title: "Render Video",
    description: "Render a .mlt document to a video artifact via melt.",
    input: z.object({ uri: z.string(), out: z.string() }),
    output: z.unknown(),
    scopes: ["timeline:read", "render:execute", "process:execute", "fs:read", "fs:write"],
    effect: {
      kind: "render",
      mutates: ["filesystem", "process"],
      openWorld: false,
      destructive: false,
      idempotency: "non-idempotent",
      reversibility: "manual",
      dryRun: "none",
      approval: "ask",
      audit: "metadata",
      job: { mode: "inline", cancellable: true, retrySafe: false },
    },
    surfaces: { cli: { command: "render video" }, mcp: { name: "render" } },
    async execute(_ctx, input) {
      const { renderTool } = await import("../bridge/tools/read");
      return await renderTool(uriToPath(input.uri), input.out);
    },
  }),
  action({
    id: "render.still",
    title: "Render Still",
    description: "Grab one exact frame of a .mlt document as a PNG via melt.",
    input: z.object({
      uri: z.string(),
      frame: z.number().int().nonnegative(),
      out: z.string(),
    }),
    output: z.unknown(),
    scopes: ["timeline:read", "render:execute", "process:execute", "fs:read", "fs:write"],
    effect: {
      kind: "render",
      mutates: ["filesystem", "process"],
      openWorld: false,
      destructive: false,
      idempotency: "non-idempotent",
      reversibility: "manual",
      dryRun: "none",
      approval: "ask",
      audit: "metadata",
      job: { mode: "inline", cancellable: true, retrySafe: false },
    },
    surfaces: { cli: { command: "render still" }, mcp: { name: "still" } },
    async execute(_ctx, input) {
      const { stillTool } = await import("../bridge/tools/read");
      return await stillTool(uriToPath(input.uri), input.frame, input.out);
    },
  }),
  action({
    id: "media.root.add",
    title: "Add Media Root",
    description: "Register a project media root with a role and lightweight policy.",
    input: z.object({
      repo: z.string().optional(),
      role: z.string().default("raw"),
      path: z.string(),
      policyJson: jsonString,
      setRoute: z.boolean().default(true),
    }),
    output: z.unknown(),
    scopes: ["media:write", "state:write"],
    effect: baseEffects.stateWrite,
    surfaces: { cli: { command: "media root add" }, mcp: { name: "media-root-add" } },
    async execute(ctx, input) {
      const { addMediaRoot, defaultRouteAliasForRoot, setRouteAlias } = await import(
        "../state/media"
      );
      const repo = input.repo ?? ctx.project?.rootPath ?? ctx.cwd;
      const root = addMediaRoot(repo, input);
      const route = input.setRoute
        ? setRouteAlias(repo, defaultRouteAliasForRoot(root), root.path)
        : null;
      return { root, route };
    },
  }),
  action({
    id: "media.root.list",
    title: "List Media Roots",
    description: "List registered media roots for the current project.",
    input: z.object({ repo: z.string().optional(), role: z.string().optional() }),
    output: z.unknown(),
    scopes: ["media:read", "state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "media root list" }, mcp: { name: "media-root-list" } },
    async execute(ctx, input) {
      const { listMediaRoots } = await import("../state/media");
      return listMediaRoots(input.repo ?? ctx.project?.rootPath ?? ctx.cwd, input.role);
    },
  }),
  action({
    id: "media.root.remove",
    title: "Remove Media Root",
    description: "Remove a media root and its cataloged assets from the project.",
    input: z.object({ repo: z.string().optional(), id: z.string() }),
    output: z.unknown(),
    scopes: ["media:write", "state:write"],
    effect: {
      ...baseEffects.stateWrite,
      destructive: true,
      reversibility: "manual",
      approval: "ask-strong",
    },
    surfaces: { cli: { command: "media root remove" }, mcp: { name: "media-root-remove" } },
    async execute(ctx, input) {
      const { removeMediaRoot } = await import("../state/media");
      return removeMediaRoot(input.repo ?? ctx.project?.rootPath ?? ctx.cwd, input.id) ?? null;
    },
  }),
  action({
    id: "media.scan",
    title: "Scan Media Root",
    description: "Scan a media root and catalog lightweight file metadata.",
    input: z.object({
      repo: z.string().optional(),
      rootId: z.string().optional(),
      limit: z.number().int().positive().default(1000),
    }),
    output: z.unknown(),
    scopes: ["media:write", "state:write", "fs:read"],
    effect: {
      kind: "update",
      mutates: ["projectState"],
      openWorld: false,
      destructive: false,
      idempotency: "idempotent",
      reversibility: "snapshot",
      dryRun: "none",
      approval: "ask",
      audit: "metadata",
      job: { mode: "inline", cancellable: true, retrySafe: true },
    },
    surfaces: { cli: { command: "media scan" }, mcp: { name: "media-scan" } },
    async execute(ctx, input) {
      const { scanMediaRoot } = await import("../state/media");
      return scanMediaRoot(input.repo ?? ctx.project?.rootPath ?? ctx.cwd, input);
    },
  }),
  action({
    id: "media.list",
    title: "List Media Assets",
    description: "List cataloged media assets for the current project.",
    input: z.object({ repo: z.string().optional(), kind: z.string().optional() }),
    output: z.unknown(),
    scopes: ["media:read", "state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "media list" }, mcp: { name: "media-list" } },
    async execute(ctx, input) {
      const { listMediaAssets } = await import("../state/media");
      return listMediaAssets(input.repo ?? ctx.project?.rootPath ?? ctx.cwd, input.kind);
    },
  }),
  action({
    id: "media.find",
    title: "Find Media Assets",
    description: "Find cataloged media assets by relative-path substring.",
    input: z.object({ repo: z.string().optional(), query: z.string() }),
    output: z.unknown(),
    scopes: ["media:read", "state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "media find" }, mcp: { name: "media-find" } },
    async execute(ctx, input) {
      const { findMediaAssets } = await import("../state/media");
      return findMediaAssets(input.repo ?? ctx.project?.rootPath ?? ctx.cwd, input.query);
    },
  }),
  action({
    id: "route.set",
    title: "Set Route Alias",
    description: "Set a project route alias such as media:raw or renders:review.",
    input: z.object({ repo: z.string().optional(), alias: z.string(), target: z.string() }),
    output: z.unknown(),
    scopes: ["state:write"],
    effect: baseEffects.stateWrite,
    surfaces: { cli: { command: "route set" }, mcp: { name: "route-set" } },
    async execute(ctx, input) {
      const { setRouteAlias } = await import("../state/media");
      return setRouteAlias(
        input.repo ?? ctx.project?.rootPath ?? ctx.cwd,
        input.alias,
        input.target,
      );
    },
  }),
  action({
    id: "route.list",
    title: "List Route Aliases",
    description: "List project route aliases.",
    input: repoInput,
    output: z.unknown(),
    scopes: ["state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "route list" }, mcp: { name: "route-list" } },
    async execute(ctx, input) {
      const { listRouteAliases } = await import("../state/media");
      return listRouteAliases(input.repo ?? ctx.project?.rootPath ?? ctx.cwd);
    },
  }),
  action({
    id: "route.resolve",
    title: "Resolve Route Alias",
    description: "Resolve a project route alias to its target.",
    input: z.object({ repo: z.string().optional(), alias: z.string() }),
    output: z.unknown(),
    scopes: ["state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "route resolve" }, mcp: { name: "route-resolve" } },
    async execute(ctx, input) {
      const { resolveRouteAlias } = await import("../state/media");
      return resolveRouteAlias(input.repo ?? ctx.project?.rootPath ?? ctx.cwd, input.alias) ?? null;
    },
  }),
  action({
    id: "setup.doctor",
    title: "Doctor",
    description: "Verify local dependencies, agent integrations, and stdio servers.",
    input: z.object({
      repo: z.string().optional(),
      host: z.enum(["all", "claude-code", "codex"]).default("all"),
      surface: z.enum(["all", "cli", "lsp", "mcp", "cli-lsp", "mcp-lsp"]).default("lsp"),
      strict: z.boolean().optional(),
      probe: z.boolean().optional(),
    }),
    output: z.unknown(),
    scopes: ["process:execute", "state:read"],
    effect: {
      ...baseEffects.read,
      kind: "execute",
      mutates: ["process"],
      approval: "auto",
      audit: "metadata",
    },
    surfaces: { cli: { command: "doctor" } },
    async execute(_ctx, input) {
      const { runDoctor } = await import("../cli/doctor");
      return await runDoctor(input);
    },
  }),
  action({
    id: "state.init",
    title: "Initialize State",
    description: "Create .vean/vean.db and run local state migrations.",
    input: repoInput,
    output: z.unknown(),
    scopes: ["state:write", "fs:write"],
    effect: baseEffects.stateWrite,
    surfaces: { cli: { command: "state init" } },
    async execute(ctx, input) {
      const { initializeState } = await import("../state/migrate");
      return initializeState(input.repo ?? ctx.project?.rootPath ?? ctx.cwd);
    },
  }),
  action({
    id: "state.status",
    title: "State Status",
    description: "Inspect repo-local vean state without mutating it.",
    input: repoInput,
    output: z.unknown(),
    scopes: ["state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "state status" } },
    async execute(ctx, input) {
      const { getStateStatus } = await import("../state/migrate");
      return getStateStatus(input.repo ?? ctx.project?.rootPath ?? ctx.cwd);
    },
  }),
  action({
    id: "project.init",
    title: "Initialize Project",
    description: "Initialize local state and register the repo as a vean project.",
    input: repoInput,
    output: z.unknown(),
    scopes: ["state:write", "fs:write"],
    effect: baseEffects.stateWrite,
    surfaces: { cli: { command: "project init" } },
    async execute(ctx, input) {
      const { initializeProject } = await import("../state/project");
      const project = initializeProject(input.repo ?? ctx.project?.rootPath ?? ctx.cwd);
      setActiveProject(project, ctx.env);
      return { project, active: true, configPath: projectConfigPath(ctx.env) };
    },
  }),
  action({
    id: "project.use",
    title: "Use Project",
    description: "Select a project for future project-aware vean commands.",
    input: projectInput,
    output: z.unknown(),
    scopes: ["state:write"],
    effect: baseEffects.stateWrite,
    surfaces: { cli: { command: "project use" } },
    async execute(ctx, input) {
      const root = input.project
        ? resolveProjectReference(input.project, ctx.env)
        : (ctx.project?.rootPath ?? ctx.cwd);
      const { initializeProject } = await import("../state/project");
      const project = initializeProject(root);
      const known = setActiveProject(project, ctx.env);
      return { project, activeProject: known, configPath: projectConfigPath(ctx.env) };
    },
  }),
  action({
    id: "project.list",
    title: "List Projects",
    description: "List projects known to this user's vean config.",
    input: emptyInput,
    output: z.unknown(),
    scopes: ["state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "project list" } },
    async execute(ctx) {
      const { listKnownProjects } = await import("../project/context");
      return { projects: listKnownProjects(ctx.env), configPath: projectConfigPath(ctx.env) };
    },
  }),
  action({
    id: "project.current",
    title: "Current Project",
    description: "Resolve the current project from flags, env, nearest .vean, or active pointer.",
    input: projectInput,
    output: z.unknown(),
    scopes: ["state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "project current" } },
    execute(ctx, input) {
      const project = resolveProject({ project: input.project, cwd: ctx.cwd, env: ctx.env });
      return { project: project ?? null, configPath: projectConfigPath(ctx.env) };
    },
  }),
  action({
    id: "project.status",
    title: "Project Status",
    description: "Resolve a project and inspect its repo-local state.",
    input: projectInput,
    output: z.unknown(),
    scopes: ["state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "project status" } },
    async execute(ctx, input) {
      const project = resolveProject({ project: input.project, cwd: ctx.cwd, env: ctx.env });
      if (!project) return { project: null, state: null, configPath: projectConfigPath(ctx.env) };
      const { getStateStatus } = await import("../state/migrate");
      return {
        project,
        state: getStateStatus(project.rootPath),
        configPath: projectConfigPath(ctx.env),
      };
    },
  }),
  action({
    id: "jobs.list",
    title: "List Jobs",
    description: "List jobs recorded in .vean/vean.db.",
    input: repoInput,
    output: z.unknown(),
    scopes: ["jobs:read", "state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "jobs list" } },
    async execute(ctx, input) {
      const { listJobs } = await import("../state/jobs");
      return listJobs(input.repo ?? ctx.project?.rootPath ?? ctx.cwd);
    },
  }),
  action({
    id: "jobs.enqueue",
    title: "Enqueue Job",
    description: "Create a queued local job.",
    input: z.object({
      repo: z.string().optional(),
      kind: z.string(),
      payloadJson: jsonString,
      priority: z.number().int().default(0),
      maxAttempts: z.number().int().positive().default(3),
    }),
    output: z.unknown(),
    scopes: ["jobs:write", "state:write"],
    effect: baseEffects.jobWrite,
    surfaces: { cli: { command: "jobs enqueue" } },
    async execute(ctx, input) {
      const { enqueueJob } = await import("../state/jobs");
      return enqueueJob(input.repo ?? ctx.project?.rootPath ?? ctx.cwd, input);
    },
  }),
  action({
    id: "jobs.claim",
    title: "Claim Job",
    description: "Claim the next queued job with a short lease.",
    input: z.object({
      repo: z.string().optional(),
      worker: z.string(),
      leaseMs: z.number().int().positive().default(60_000),
    }),
    output: z.unknown(),
    scopes: ["jobs:write", "state:write"],
    effect: baseEffects.jobWrite,
    surfaces: { cli: { command: "jobs claim" } },
    async execute(ctx, input) {
      const { claimNextJob } = await import("../state/jobs");
      return (
        claimNextJob(input.repo ?? ctx.project?.rootPath ?? ctx.cwd, input.worker, input.leaseMs) ??
        null
      );
    },
  }),
  action({
    id: "jobs.complete",
    title: "Complete Job",
    description: "Mark a local job done.",
    input: z.object({
      repo: z.string().optional(),
      id: z.string(),
      resultJson: jsonString,
    }),
    output: z.unknown(),
    scopes: ["jobs:write", "state:write"],
    effect: baseEffects.jobWrite,
    surfaces: { cli: { command: "jobs complete" } },
    async execute(ctx, input) {
      const { completeJob } = await import("../state/jobs");
      return (
        completeJob(input.repo ?? ctx.project?.rootPath ?? ctx.cwd, input.id, input.resultJson) ??
        null
      );
    },
  }),
  action({
    id: "jobs.fail",
    title: "Fail Job",
    description: "Mark a local job failed.",
    input: z.object({
      repo: z.string().optional(),
      id: z.string(),
      error: z.string(),
    }),
    output: z.unknown(),
    scopes: ["jobs:write", "state:write"],
    effect: baseEffects.jobWrite,
    surfaces: { cli: { command: "jobs fail" } },
    async execute(ctx, input) {
      const { failJob } = await import("../state/jobs");
      return failJob(input.repo ?? ctx.project?.rootPath ?? ctx.cwd, input.id, input.error) ?? null;
    },
  }),
];

const registry = new Map<string, ActionDefinition>(
  actions.map((definition) => [definition.id, definition]),
);

export function listActions(): ActionDefinition[] {
  return [...registry.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function getAction(id: string): ActionDefinition | undefined {
  return registry.get(id);
}

export function describeAction(action: ActionDefinition): ActionDescriptor {
  return {
    id: action.id,
    title: action.title,
    description: action.description,
    scopes: action.scopes,
    effect: action.effect,
    surfaces: action.surfaces,
    mcpAnnotations: {
      readOnlyHint: action.effect.mutates.length === 0,
      destructiveHint: action.effect.destructive,
      idempotentHint:
        action.effect.idempotency === "pure" || action.effect.idempotency === "idempotent",
      openWorldHint: action.effect.openWorld,
    },
  };
}

export async function executeAction(
  id: string,
  input: unknown,
  ctx: ActionContext,
): Promise<ActionEnvelope> {
  const definition = getAction(id);
  if (!definition) {
    return {
      ok: false,
      actionId: id,
      kind: "not-found",
      detail: `unknown action: ${id}`,
      project: ctx.project,
    };
  }
  if (definition.effect.approval === "deny") {
    return {
      ok: false,
      actionId: id,
      kind: "policy",
      detail: "action is denied by policy",
      project: ctx.project,
    };
  }
  const parsed = definition.input.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      actionId: id,
      kind: "validation",
      detail: parsed.error.issues.map((issue) => issue.message).join("; "),
      project: ctx.project,
    };
  }
  try {
    const output = await definition.execute(ctx, parsed.data);
    const checked = definition.output.safeParse(output);
    if (!checked.success) {
      return {
        ok: false,
        actionId: id,
        kind: "validation",
        detail: `handler returned invalid output: ${checked.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
        project: ctx.project,
      };
    }
    return { ok: true, actionId: id, output: checked.data, project: ctx.project };
  } catch (error) {
    return {
      ok: false,
      actionId: id,
      kind: "execution",
      detail: error instanceof Error ? error.message : String(error),
      project: ctx.project,
    };
  }
}
