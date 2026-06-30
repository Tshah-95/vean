import { resolve } from "node:path";
import { z } from "zod";
import { describeOp, listOpDescriptors, searchOps } from "../ops/catalog";
import {
  projectConfigPath,
  resolveProject,
  resolveProjectReference,
  setActiveProject,
} from "../project/context";
import type { ResolvedProject } from "../project/context";
import { defaultPolicyLevel, evaluatePolicy } from "./policy";
import { summarizeSchema } from "./schema-summary";
import { importWithProvenanceAction } from "./generate-import";
import { skillActions } from "./skills";
import type {
  ActionContext,
  ActionDefinition,
  ActionDescriptor,
  ActionEffect,
  ActionEnvelope,
  Clock,
  DocumentStore,
  IdFactory,
  Logger,
  StateAccess,
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
/** A non-negative integer frame (mirrors src/ir/types `frame`). */
const frame = z.number().int().nonnegative();
/** A track address: a stable track id or a (kind, index) pair. */
const trackAddrInput = z.union([
  z.object({ trackId: z.string().min(1) }),
  z.object({ kind: z.enum(["video", "audio"]), index: z.number().int().nonnegative() }),
]);
const discoverKind = z.enum(["all", "command", "action", "op", "route"]).default("all");
const discoverLimit = z.coerce.number().int().positive().max(50).default(10);

function uriToPath(uri: string): string {
  return uri.startsWith("file://") ? decodeURIComponent(uri.slice("file://".length)) : uri;
}

/** Render an op EditError to a human-readable detail string for an action
 *  envelope (the composite actions return EditErrors as typed failures). */
function editErrorMsg(e: { kind: string; detail?: string; uuid?: string; track?: string }): string {
  if (e.detail) return e.detail;
  if (e.kind === "clip-not-found") return `clip not found: ${e.uuid}`;
  if (e.kind === "track-not-found") return `track not found: ${e.track}`;
  return e.kind;
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

function repoFor(ctx: ActionContext, repo?: string): string {
  return repo ?? ctx.project?.rootPath ?? ctx.cwd;
}

function projectFor(ctx: ActionContext, repo?: string): ResolvedProject {
  const root = repoFor(ctx, repo);
  return (
    resolveProject({ project: root, cwd: ctx.cwd, env: ctx.env }) ?? {
      rootPath: root,
      source: "explicit",
      stateDbPath: "",
    }
  );
}

type SearchResult = {
  kind: "command" | "action" | "op" | "route";
  canonicalId?: string;
  canonicalOp?: string;
  title: string;
  aliases: string[];
  command?: string;
  actionId?: string;
  describeCommand?: string;
  rank: number;
  score: number;
  reason: string;
};

function textScore(
  query: string,
  fields: Array<[field: string, value: string | undefined, weight: number]>,
): { score: number; reason: string } {
  const q = query.toLowerCase().trim();
  let best = { score: 0, reason: "" };
  for (const [field, value, weight] of fields) {
    if (!value) continue;
    const text = value.toLowerCase();
    if (text === q) {
      const score = weight + 20;
      if (score > best.score) best = { score, reason: `${field} exact match` };
    } else if (text.includes(q) || q.split(/\s+/).every((part) => text.includes(part))) {
      if (weight > best.score) best = { score: weight, reason: `${field} match` };
    }
  }
  return best;
}

function commandDescriptors() {
  return listActions()
    .filter((entry) => entry.surfaces.cli && !("hidden" in entry.surfaces.cli))
    .map((entry) => {
      const cli = entry.surfaces.cli as { command?: string };
      return {
        kind: "command" as const,
        command: cli.command ?? entry.id,
        actionId: entry.id,
        title: entry.title,
        description: entry.description,
        aliases: entry.aliases ?? [],
      };
    });
}

function searchRegistry(
  query: string,
  kind: z.infer<typeof discoverKind>,
  limit: number,
  routes: Array<{ alias: string; target: string }> = [],
): SearchResult[] {
  const results: SearchResult[] = [];
  if (kind === "all" || kind === "op") results.push(...searchOps(query));
  if (kind === "all" || kind === "action") {
    for (const entry of listActions()) {
      const scored = textScore(query, [
        ["id", entry.id, 100],
        ["title", entry.title, 70],
        ["description", entry.description, 40],
        ...(entry.aliases ?? []).map((alias) => ["alias", alias, 90] as [string, string, number]),
      ]);
      if (scored.score > 0) {
        results.push({
          kind: "action",
          canonicalId: entry.id,
          actionId: entry.id,
          title: entry.title,
          aliases: entry.aliases ?? [],
          describeCommand: `vean action describe ${entry.id} --json`,
          rank: 0,
          score: scored.score,
          reason: scored.reason,
        });
      }
    }
  }
  if (kind === "all" || kind === "command") {
    for (const command of commandDescriptors()) {
      const scored = textScore(query, [
        ["command", command.command, 100],
        ["title", command.title, 70],
        ["description", command.description, 40],
      ]);
      if (scored.score > 0) {
        results.push({
          kind: "command",
          canonicalId: command.command,
          actionId: command.actionId,
          title: command.title,
          aliases: command.aliases,
          command: `vean ${command.command} --json`,
          rank: 0,
          score: scored.score,
          reason: scored.reason,
        });
      }
    }
  }
  if (kind === "all" || kind === "route") {
    for (const route of routes) {
      const scored = textScore(query, [
        ["alias", route.alias, 100],
        ["target", route.target, 50],
      ]);
      if (scored.score > 0) {
        results.push({
          kind: "route",
          canonicalId: route.alias,
          title: route.alias,
          aliases: [],
          command: `vean route resolve ${route.alias} --json`,
          rank: 0,
          score: scored.score,
          reason: scored.reason,
        });
      }
    }
  }
  return results
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.kind.localeCompare(b.kind) ||
        (a.canonicalId ?? a.canonicalOp ?? a.title).localeCompare(
          b.canonicalId ?? b.canonicalOp ?? b.title,
        ),
    )
    .slice(0, limit)
    .map((result, index) => ({ ...result, rank: index + 1 }));
}

/** The default filesystem-backed document store (Bun file IO). The historical
 *  `readDoc`/`writeDoc` behavior, now injected through the context so a surface or
 *  test can swap it. */
const fsDocuments: DocumentStore = {
  read: (uri) => readDoc(uri),
  write: (uri, text) => writeDoc(uri, text),
};

/** The default system clock. */
const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

/** The default id factory (crypto.randomUUID, with a dependency-free fallback for
 *  any runtime lacking it). */
const cryptoIds: IdFactory = {
  uuid: () => {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    return c?.randomUUID
      ? c.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  },
};

/** The default console-backed logger. `debug` is intentionally quiet (the CLI is
 *  not chatty by default); the rest map to their console channels. */
const consoleLogger: Logger = {
  debug: () => {},
  info: (message, fields) => (fields ? console.info(message, fields) : console.info(message)),
  warn: (message, fields) => (fields ? console.warn(message, fields) : console.warn(message)),
  error: (message, fields) => (fields ? console.error(message, fields) : console.error(message)),
};

/** The default lazy state-DB access — imports `bun:sqlite` only on first open, so
 *  constructing a context stays light. */
const lazyState: StateAccess = {
  open: async (repo) => {
    const { openStateDb } = await import("../state/db");
    return openStateDb(repo);
  },
};

export function createActionContext(options: {
  cwd?: string;
  surface?: ActionContext["surface"];
  project?: string;
  env?: NodeJS.ProcessEnv;
  /** Override any injected capability (tests, future surfaces). Anything omitted
   *  falls back to the behavior-preserving default. */
  overrides?: Partial<
    Pick<ActionContext, "documents" | "clock" | "ids" | "logger" | "state" | "signal" | "policy">
  >;
}): ActionContext {
  const cwd = resolve(options.cwd ?? process.cwd());
  const env = options.env ?? process.env;
  const o = options.overrides ?? {};
  return {
    cwd,
    surface: options.surface ?? "cli",
    env,
    project: resolveProject({ project: options.project, cwd, env }),
    documents: o.documents ?? fsDocuments,
    clock: o.clock ?? systemClock,
    ids: o.ids ?? cryptoIds,
    logger: o.logger ?? consoleLogger,
    // The project resolver is bound to this context's cwd/env so actions resolve a
    // reference without re-threading them (cwd/env supplied per call still win).
    resolveProject: (resolveOptions) => resolveProject({ cwd, env, ...resolveOptions }),
    state: o.state ?? lazyState,
    signal: o.signal,
    policy: o.policy,
  };
}

const actions = [
  action({
    id: "discover.manifest",
    title: "Discover Vean Surface",
    description: "Use this when an agent or human needs the current vean command/action/op map.",
    input: emptyInput,
    output: z.unknown(),
    scopes: ["state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "discover" }, mcp: { name: "discover-manifest" } },
    async execute(ctx) {
      const project = ctx.project ?? null;
      const { activeTimeline, routeAliases } = project
        ? await (async () => {
            const { currentTimeline } = await import("../state/timeline");
            const { listRouteAliases } = await import("../state/media");
            return {
              activeTimeline: currentTimeline(project.rootPath, project),
              routeAliases: listRouteAliases(project.rootPath),
            };
          })()
        : { activeTimeline: null, routeAliases: [] };
      const active =
        activeTimeline && !("ok" in activeTimeline) ? activeTimeline.activeTimeline : null;
      const opFamilies = listOpDescriptors().reduce(
        (acc, descriptor) => {
          const group = acc.find((entry) => entry.category === descriptor.category);
          if (group) group.ops.push(descriptor.op);
          else acc.push({ category: descriptor.category, ops: [descriptor.op] });
          return acc;
        },
        [] as Array<{ category: string; ops: string[] }>,
      );
      return {
        project,
        activeTimeline: active,
        commands: commandDescriptors(),
        actions: listActions().map(describeAction),
        opFamilies,
        routes: [
          { namespace: "timeline", examples: ["timeline:main"] },
          { namespace: "media", examples: ["media:raw", "media:proxy"] },
          { namespace: "renders", examples: ["renders:review"] },
        ],
        routeAliases,
        next: [
          "vean timeline ops list --json",
          "vean timeline current --json",
          "vean discover <query> --json",
        ],
      };
    },
  }),
  action({
    id: "discover.search",
    title: "Search Vean Surface",
    description:
      "Use this when mapping an editing intent to a canonical vean command, action, or op.",
    input: z.object({
      query: z.string().trim().min(1),
      kind: discoverKind,
      limit: discoverLimit,
    }),
    output: z.unknown(),
    scopes: ["state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "discover" }, mcp: { name: "discover-search" } },
    async execute(ctx, input) {
      const { listRouteAliases } = await import("../state/media");
      const routes = ctx.project ? listRouteAliases(ctx.project.rootPath) : [];
      const results = searchRegistry(input.query, input.kind ?? "all", input.limit ?? 10, routes);
      const ambiguous =
        input.query.toLowerCase().trim() === "delete" &&
        results.some((result) => result.canonicalOp === "lift") &&
        results.some((result) => result.canonicalOp === "remove");
      return {
        query: input.query,
        kind: input.kind ?? "all",
        limit: input.limit ?? 10,
        ambiguous,
        results,
      };
    },
  }),
  action({
    id: "timeline.ops.list",
    title: "List Timeline Operations",
    description:
      "Use this when discovering the public edit operations available for .mlt timelines.",
    input: z.object({ category: z.string().optional() }),
    output: z.unknown(),
    scopes: ["timeline:read"],
    effect: baseEffects.read,
    surfaces: { cli: { command: "timeline ops list" }, mcp: { name: "timeline-ops-list" } },
    execute(_ctx, input) {
      const operations = listOpDescriptors().filter(
        (descriptor) => !input.category || descriptor.category === input.category,
      );
      const publicOperations = operations.map(({ input: _input, ...descriptor }) => descriptor);
      const groups = publicOperations.reduce(
        (acc, descriptor) => {
          const group = acc.find((entry) => entry.category === descriptor.category);
          if (group) group.ops.push(descriptor.op);
          else acc.push({ category: descriptor.category, ops: [descriptor.op] });
          return acc;
        },
        [] as Array<{ category: string; ops: string[] }>,
      );
      return { operations: publicOperations, groups };
    },
  }),
  action({
    id: "timeline.ops.describe",
    title: "Describe Timeline Operation",
    description: "Use this when an agent needs an edit op's arguments, aliases, and examples.",
    input: z.object({ op: z.string() }),
    output: z.unknown(),
    scopes: ["timeline:read"],
    effect: baseEffects.read,
    surfaces: {
      cli: { command: "timeline ops describe" },
      mcp: { name: "timeline-ops-describe" },
    },
    execute(_ctx, input) {
      const { descriptor, canonicalOp, resolvedFrom } = describeOp(input.op);
      const { input: _schema, ...publicDescriptor } = descriptor;
      return { canonicalOp, resolvedFrom, descriptor: publicDescriptor };
    },
  }),
  action({
    id: "timeline.ops.examples",
    title: "Timeline Operation Examples",
    description: "Use this when an agent needs concrete valid JSON args for a timeline operation.",
    input: z.object({ op: z.string() }),
    output: z.unknown(),
    scopes: ["timeline:read"],
    effect: baseEffects.read,
    surfaces: {
      cli: { command: "timeline ops examples" },
      mcp: { name: "timeline-ops-examples" },
    },
    execute(_ctx, input) {
      const { descriptor, canonicalOp, resolvedFrom } = describeOp(input.op);
      return { canonicalOp, resolvedFrom, examples: descriptor.examples };
    },
  }),
  action({
    id: "timeline.applyOp",
    title: "Apply Timeline Operation",
    description: "Apply an edit operation to a .mlt document and persist the result.",
    relatedDiscovery: ["timeline.ops.list", "timeline.ops.describe"],
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
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
    async execute(ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { mutate } = await import("../bridge/tools/mutate");
      const { isToolError } = await import("../bridge/tools/types");
      const { resolveTimelineTarget } = await import("../state/timeline");
      if (input.op.startsWith("_")) {
        return { ok: false, kind: "non-public-op", detail: `op is not public: ${input.op}` };
      }
      let resolvedOp: { canonicalOp: string; resolvedFrom?: string };
      try {
        const { resolveOpName } = await import("../ops/catalog");
        resolvedOp = resolveOpName(input.op);
      } catch {
        const { searchOps } = await import("../ops/catalog");
        return {
          ok: false,
          kind: "unknown-op",
          detail: `unknown op: ${input.op}`,
          suggestions: searchOps(input.op).slice(0, 5),
          command: "vean timeline ops list --json",
        };
      }
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const state = parseDoc(await ctx.documents.read(timeline.uri));
      const { outcome, newState } = mutate(
        state,
        { op: resolvedOp.canonicalOp, args: input.args },
        timeline.uri,
      );
      let fpsAutodetect:
        | { applied: true; fromFps: [number, number]; toFps: [number, number] }
        | { applied: false; proposal: { fromFps: [number, number]; toFps: [number, number] } }
        | undefined;
      if (!isToolError(outcome) && newState) {
        let finalState = newState;
        // First-clip fps autodetect (the `fps.autodetect` setting): when this op put
        // the first video clip on the timeline, conform the profile to it (auto) or
        // surface a proposal (confirm). Best-effort — never block/break the edit.
        try {
          const { dirname } = await import("node:path");
          const { autodetectFirstClip } = await import("../conform/autodetect");
          const ad = await autodetectFirstClip(state, newState, {
            repo: project.rootPath,
            baseDir: dirname(timeline.uri),
          });
          if (ad?.decision.decision === "apply") {
            finalState = ad.state;
            fpsAutodetect = { applied: true, ...ad.decision.proposal };
          } else if (ad?.decision.decision === "propose") {
            fpsAutodetect = { applied: false, proposal: ad.decision.proposal };
          }
        } catch {
          /* autodetect is best-effort */
        }
        await ctx.documents.write(timeline.uri, serializeDoc(finalState));
      }
      return {
        ...outcome,
        invocation: { op: resolvedOp.canonicalOp, resolvedFrom: resolvedOp.resolvedFrom },
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        project: timeline.project,
        ...(fpsAutodetect ? { fpsAutodetect } : {}),
      };
    },
  }),
  action({
    id: "timeline.previewOp",
    title: "Preview Timeline Operation",
    description: "Preview an edit operation without changing the document.",
    relatedDiscovery: ["timeline.ops.list", "timeline.ops.describe"],
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
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
    async execute(ctx, input) {
      const { parseDoc } = await import("../bridge/tools/core");
      const { preview } = await import("../bridge/tools/mutate");
      const { resolveTimelineTarget } = await import("../state/timeline");
      if (input.op.startsWith("_")) {
        return { ok: false, kind: "non-public-op", detail: `op is not public: ${input.op}` };
      }
      let resolvedOp: { canonicalOp: string; resolvedFrom?: string };
      try {
        const { resolveOpName } = await import("../ops/catalog");
        resolvedOp = resolveOpName(input.op);
      } catch {
        const { searchOps } = await import("../ops/catalog");
        return {
          ok: false,
          kind: "unknown-op",
          detail: `unknown op: ${input.op}`,
          suggestions: searchOps(input.op).slice(0, 5),
          command: "vean timeline ops list --json",
        };
      }
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const state = parseDoc(await ctx.documents.read(timeline.uri));
      const outcome = preview(
        state,
        { op: resolvedOp.canonicalOp, args: input.args },
        timeline.uri,
      );
      return {
        ...outcome,
        invocation: { op: resolvedOp.canonicalOp, resolvedFrom: resolvedOp.resolvedFrom },
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        project: timeline.project,
      };
    },
  }),
  action({
    id: "timeline.undo",
    title: "Undo Timeline Operation",
    description: "Undo an edit by applying a prior result's inverse invocation.",
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
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
    async execute(ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { undoTool } = await import("../bridge/tools/mutate");
      const { isToolError } = await import("../bridge/tools/types");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const inverse = input.inverse.op.startsWith("_")
        ? input.inverse
        : {
            ...input.inverse,
            op: (await import("../ops/catalog")).resolveOpName(input.inverse.op).canonicalOp,
          };
      const state = parseDoc(await ctx.documents.read(timeline.uri));
      const { outcome, newState } = undoTool(state, inverse, timeline.uri);
      if (!isToolError(outcome) && newState)
        await ctx.documents.write(timeline.uri, serializeDoc(newState));
      return {
        ...outcome,
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        project: timeline.project,
      };
    },
  }),
  action({
    id: "timeline.diagnose",
    title: "Diagnose Timeline",
    description: "Debug/CI verb that returns the full diagnostic set for a document.",
    input: z.object({ uri: z.string().optional(), timeline: z.string().optional() }),
    output: z.unknown(),
    scopes: ["timeline:read", "fs:read"],
    effect: baseEffects.read,
    surfaces: { cli: { command: "timeline diagnose" }, mcp: { name: "diagnose" } },
    async execute(ctx, input) {
      const { diagnoseTool, parseDoc } = await import("../bridge/tools/core");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      return {
        ok: true,
        ...diagnoseTool(parseDoc(await ctx.documents.read(timeline.uri))),
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        project: timeline.project,
      };
    },
  }),
  action({
    id: "timeline.resolveValueAtFrame",
    title: "Resolve Value At Frame",
    description: "Resolve a parameter's effective value at a timeline frame.",
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
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
    async execute(ctx, input) {
      const { parseDoc } = await import("../bridge/tools/core");
      const { resolveTool } = await import("../bridge/tools/read");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      return {
        ...resolveTool(
          parseDoc(await ctx.documents.read(timeline.uri)),
          input.frame,
          input.target as never,
        ),
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        project: timeline.project,
      };
    },
  }),
  action({
    id: "timeline.findReferences",
    title: "Find References",
    description: "Find references in the timeline graph.",
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
      query: z.record(z.string(), z.unknown()),
    }),
    output: z.unknown(),
    scopes: ["timeline:read", "fs:read"],
    effect: baseEffects.read,
    surfaces: { cli: { command: "timeline find-references" }, mcp: { name: "find-references" } },
    async execute(ctx, input) {
      const { parseDoc } = await import("../bridge/tools/core");
      const { referencesTool } = await import("../bridge/tools/read");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      return {
        ...referencesTool(parseDoc(await ctx.documents.read(timeline.uri)), input.query as never),
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        project: timeline.project,
      };
    },
  }),
  action({
    id: "timeline.current",
    title: "Current Timeline",
    description: "Use this when resolving the active timeline:main route for the current project.",
    input: repoInput,
    output: z.unknown(),
    scopes: ["timeline:read", "state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "timeline current" }, mcp: { name: "timeline-current" } },
    async execute(ctx, input) {
      const { currentTimeline } = await import("../state/timeline");
      const project = projectFor(ctx, input.repo);
      return currentTimeline(project.rootPath, project);
    },
  }),
  action({
    id: "timeline.use",
    title: "Use Timeline",
    description: "Use this when setting the project active timeline:main route.",
    input: z.object({ repo: z.string().optional(), target: z.string() }),
    output: z.unknown(),
    scopes: ["timeline:read", "state:write"],
    effect: baseEffects.stateWrite,
    surfaces: { cli: { command: "timeline use" }, mcp: { name: "timeline-use" } },
    async execute(ctx, input) {
      const { useTimeline } = await import("../state/timeline");
      const project = projectFor(ctx, input.repo);
      return useTimeline(project.rootPath, project, input.target);
    },
  }),
  action({
    id: "timeline.list",
    title: "List Timelines",
    description: "Use this when listing cataloged and routed .mlt timelines for a project.",
    input: repoInput,
    output: z.unknown(),
    scopes: ["timeline:read", "state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "timeline list" }, mcp: { name: "timeline-list" } },
    async execute(ctx, input) {
      const { listTimelines } = await import("../state/timeline");
      const project = projectFor(ctx, input.repo);
      return listTimelines(project.rootPath, project);
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
    id: "preview.serve",
    title: "Serve Preview",
    description:
      "Start a local 127.0.0.1 web viewer: a frame-accurate timeline strip and a footage-proxy + Remotion-overlay composited preview slaved to one master clock. Stays in the foreground until interrupted.",
    relatedDiscovery: ["timeline.current", "remotion.render", "timeline.addGraphic"],
    input: z.object({
      repo: z.string().optional(),
      timeline: z.string().optional(),
      // 0 = let the OS pick a free ephemeral port (the worktree-native default,
      // DESIGN-WORKTREE §4.2). A caller that wants a stable port passes one
      // explicitly (the Tauri shell does for its WKWebView); `VEAN_PREVIEW_PORT`
      // overrides the default for direct invocations without touching the flag.
      port: z.number().int().nonnegative().default(0),
      open: z.boolean().default(true),
      // Dev is the DEFAULT: serve the live Vite/HMR viewer so anything you open
      // reflects the current checkout's UI code. `dev: false` (CLI `--prod`) serves
      // the pre-built `viewer/dist` snapshot — used by the shipped Mac app and the
      // test probe, which must not spin up a Vite child.
      dev: z.boolean().default(true),
      /** When true (tests/CI), start the server and return immediately instead
       *  of blocking the process; the caller stops it. */
      detached: z.boolean().default(false),
    }),
    output: z.unknown(),
    scopes: [
      "state:read",
      "timeline:read",
      "render:execute",
      "process:execute",
      "fs:read",
      "fs:write",
    ],
    effect: {
      kind: "execute",
      mutates: ["process"],
      openWorld: false,
      destructive: false,
      idempotency: "non-idempotent",
      reversibility: "none-needed",
      dryRun: "none",
      approval: "ask",
      audit: "metadata",
      job: { mode: "inline", cancellable: true, retrySafe: false },
    },
    surfaces: { cli: { command: "preview" }, mcp: { hidden: true } },
    async execute(ctx, input) {
      const { startPreviewServer } = await import("../preview/server");
      const repo = repoFor(ctx, input.repo);
      // Port precedence: an explicit non-zero `--port` wins; otherwise honor
      // VEAN_PREVIEW_PORT when it parses to a valid port; otherwise 0 (the OS
      // picks a free ephemeral port and the bound port is read back below).
      let port = input.port ?? 0;
      if (port === 0) {
        const envPort = Number.parseInt(ctx.env.VEAN_PREVIEW_PORT ?? "", 10);
        if (Number.isInteger(envPort) && envPort >= 0 && envPort <= 65_535) port = envPort;
      }
      const handle = await startPreviewServer({
        repo,
        ...(input.timeline ? { timeline: input.timeline } : {}),
        port,
        dev: input.dev ?? true,
      });
      // Echo the ACTUAL bound URL: with the ephemeral default the CLI can't know
      // the port up front, so the action is the only place that has it (and
      // `vean whereami` / `drive status` echo it too, DESIGN-WORKTREE §4.2).
      if (!input.detached) {
        process.stderr.write(`vean preview ready on ${handle.url}\n`);
      }
      // Detached mode (tests/CI): return the handle's URL and a stop hook so the
      // caller can probe endpoints and shut it down. Default mode keeps the server
      // alive (the CLI command awaits an unresolved promise) and opens a browser.
      if (input.detached) {
        return {
          ok: true,
          detached: true,
          url: handle.url,
          port: handle.port,
          repo,
          _stop: handle.stop,
        };
      }
      if (input.open !== false) {
        try {
          const opener =
            process.platform === "darwin"
              ? "open"
              : process.platform === "win32"
                ? "explorer"
                : "xdg-open";
          Bun.spawn([opener, handle.url], { stdout: "ignore", stderr: "ignore" });
        } catch {
          // best-effort: a failed browser open is not fatal
        }
      }
      // Keep the process alive until interrupted (Ctrl-C). The CLI prints the URL.
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          handle.stop();
          resolve();
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      });
      return { ok: true, url: handle.url, port: handle.port, repo, stopped: true };
    },
  }),
  action({
    id: "remotion.render",
    title: "Render Remotion Composition",
    description:
      "Render a Remotion composition to an alpha ProRes 4444 clip for compositing onto an upper MLT track. Drives the remotion CLI as a subprocess; caches on (composition, props, range, profile).",
    relatedDiscovery: ["timeline.addGraphic"],
    input: z.object({
      composition: z.string().min(1),
      props: z.record(z.string(), z.unknown()).default({}),
      frameRange: z.tuple([frame, frame]).optional(),
      out: z.string().optional(),
      profile: z
        .enum(["vertical", "square", "landscape", "landscape-2997", "landscape-23976"])
        .default("vertical"),
      repo: z.string().optional(),
      force: z.boolean().default(false),
    }),
    output: z.unknown(),
    scopes: [
      "render:execute",
      "process:execute",
      "fs:read",
      "fs:write",
      "state:read",
      "state:write",
    ],
    effect: {
      kind: "render",
      mutates: ["filesystem", "process"],
      openWorld: false,
      destructive: false,
      idempotency: "idempotent",
      reversibility: "manual",
      dryRun: "none",
      approval: "ask",
      audit: "metadata",
      job: { mode: "inline", cancellable: true, retrySafe: true },
    },
    surfaces: { cli: { command: "remotion render" }, mcp: { name: "remotion-render" } },
    async execute(ctx, input) {
      const { PROFILES } = await import("../ir/profile");
      const profileName = input.profile ?? "vertical";
      const props = input.props ?? {};
      const profile = PROFILES[profileName];
      // Move 5 is restricted to integer-fps profiles — Remotion takes an integer
      // fps. Reject a non-integer-fps target with a typed error (the fps-mismatch
      // diagnostic + non-integer support is deferred to a later Move).
      if (profile.fps[1] !== 1) {
        return {
          ok: false,
          kind: "unsupported-fps",
          detail: `remotion.render is restricted to integer-fps profiles; "${profileName}" is ${profile.fps[0]}/${profile.fps[1]}`,
        };
      }
      const { remotionWorkspaceForRepo, renderComposition, RemotionError } = await import(
        "../driver/remotion"
      );
      const cacheMod = await import("../state/remotionCache");
      const repo = repoFor(ctx, input.repo);
      // Per-project workspace: a project's own remotion/ (its compositions + brand
      // tokens) wins; falls back to vean's bundled workspace.
      const { entry, bin } = remotionWorkspaceForRepo(repo);
      const profileFingerprint = `${profile.width}x${profile.height}@${profile.fps[0]}/${profile.fps[1]}`;
      const entryFingerprint = cacheMod.entryFingerprint(entry);
      const frameRange = input.frameRange ?? null;
      const key = cacheMod.cacheKey({
        compositionId: input.composition,
        props,
        frameRange,
        profileFingerprint,
        entryFingerprint,
      });

      if (!input.force) {
        const hit = cacheMod.lookup(repo, key);
        if (hit) {
          return {
            ok: true,
            composition: input.composition,
            outPath: hit.outPath,
            cached: true,
            pixFmt: hit.pixFmt,
            hasAlpha: hit.hasAlpha,
            frameRange: hit.frameRange,
            cacheKey: key,
            touchedUris: [hit.outPath],
          };
        }
      }

      const outPath = input.out ?? cacheMod.pathFor(repo, key);
      const { mkdirSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      mkdirSync(dirname(outPath), { recursive: true });

      try {
        const result = await renderComposition(input.composition, outPath, {
          entry,
          ...(bin ? { bin } : {}),
          props,
          ...(input.frameRange ? { frameRange: input.frameRange } : {}),
        });
        if (!result.hasAlpha) {
          // A yuv422p… pix_fmt means the alpha plane was lost — the overlay would
          // not composite. Hard failure, returned (not thrown) for a uniform envelope.
          return {
            ok: false,
            kind: "no-alpha",
            detail: `rendered clip has no alpha plane (pix_fmt=${result.pixFmt}); expected a yuva format`,
            pixFmt: result.pixFmt,
            outPath: result.outPath,
          };
        }
        cacheMod.record(repo, {
          key,
          compositionId: input.composition,
          props,
          frameRange,
          outPath: result.outPath,
          pixFmt: result.pixFmt,
          hasAlpha: result.hasAlpha,
          createdAt: ctx.clock.nowIso(),
        });
        return {
          ok: true,
          composition: input.composition,
          outPath: result.outPath,
          cached: false,
          pixFmt: result.pixFmt,
          hasAlpha: result.hasAlpha,
          frameRange,
          cacheKey: key,
          touchedUris: [result.outPath],
        };
      } catch (error) {
        const detail =
          error instanceof RemotionError
            ? error.message
            : String((error as Error)?.message ?? error);
        return { ok: false, kind: "render", detail };
      }
    },
  }),
  action({
    id: "timeline.addGraphic",
    title: "Add Graphic Overlay",
    description:
      "Composite a pre-rendered alpha graphic clip over the footage: ensures an upper video track, overwrites the clip at a position, and adds a qtblend field transition so it composites over the footage track.",
    relatedDiscovery: ["remotion.render", "timeline.ops.describe"],
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
      clipPath: z.string().min(1),
      position: frame,
      durationFrames: z.number().int().positive(),
      newTrack: z.boolean().default(false),
      blendService: z.string().default("qtblend"),
      label: z.string().optional(),
      // Remotion-overlay identity for a NEW baked overlay — flows onto
      // Clip.composition so the viewer recognizes it (and round-trips through the
      // `vean:composition` producer property). Omit for plain alpha overlays.
      composition: z
        .object({
          id: z.string().min(1),
          props: z.record(z.string(), z.unknown()).optional(),
        })
        .optional(),
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
    surfaces: { cli: { command: "timeline add-graphic" }, mcp: { name: "add-graphic" } },
    async execute(ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const { addGraphic } = await import("./graphic");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const state = parseDoc(await ctx.documents.read(timeline.uri));
      const result = addGraphic(state, {
        clipPath: input.clipPath,
        position: input.position,
        durationFrames: input.durationFrames ?? 0,
        newTrack: input.newTrack ?? false,
        blendService: input.blendService ?? "qtblend",
        ...(input.label ? { label: input.label } : {}),
        ...(input.composition ? { composition: input.composition } : {}),
      });
      if (!("state" in result)) {
        return { ok: false, kind: result.kind, detail: editErrorMsg(result), uri: timeline.uri };
      }
      await ctx.documents.write(timeline.uri, serializeDoc(result.state));
      return {
        ok: true,
        consequences: result.consequences,
        inverse: result.inverse,
        aTrack: result.aTrack,
        bTrack: result.bTrack,
        gfxTrackId: result.gfxTrackId,
        createdTrack: result.createdTrack,
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        touchedUris: [timeline.uri],
        project: timeline.project,
      };
    },
  }),
  action({
    id: "graphic.rebake",
    title: "Re-bake Remotion Overlay",
    description:
      "Re-render a Remotion overlay's alpha .mov from its composition + props, refreshing the render cache. Identify the overlay either directly by composition id (+ props) or by an in-timeline clip uuid whose vean:composition metadata is read back. Drives the remotion CLI as a subprocess; always re-renders (force) and re-records the cache entry.",
    relatedDiscovery: ["remotion.render", "timeline.addGraphic"],
    input: z
      .object({
        // Direct identity: name the composition and the props it was baked with.
        composition: z.string().min(1).optional(),
        props: z.record(z.string(), z.unknown()).default({}),
        // In-timeline identity: resolve the overlay clip by uuid on a timeline and
        // read its `vean:composition` metadata as the bake inputs.
        uri: z.string().optional(),
        timeline: z.string().optional(),
        clipUuid: z.string().min(1).optional(),
        frameRange: z.tuple([frame, frame]).optional(),
        out: z.string().optional(),
        profile: z
          .enum(["vertical", "square", "landscape", "landscape-2997", "landscape-23976"])
          .default("vertical"),
        repo: z.string().optional(),
      })
      // Exactly one identification mode: a composition id OR a clip uuid.
      .refine((v) => Boolean(v.composition) !== Boolean(v.clipUuid), {
        message: "provide exactly one of `composition` or `clipUuid`",
      }),
    output: z.unknown(),
    scopes: [
      "timeline:read",
      "render:execute",
      "process:execute",
      "fs:read",
      "fs:write",
      "state:read",
      "state:write",
    ],
    effect: {
      kind: "render",
      mutates: ["filesystem", "process"],
      openWorld: false,
      destructive: false,
      // A re-bake re-runs the same deterministic render and overwrites the same
      // cache entry → idempotent (the prior bake of identical inputs is replaced
      // by a byte-equivalent one). It always shells out (force), so retry-safe.
      idempotency: "idempotent",
      reversibility: "manual",
      dryRun: "none",
      approval: "ask",
      audit: "metadata",
      job: { mode: "inline", cancellable: true, retrySafe: true },
    },
    surfaces: { cli: { command: "remotion rebake" }, mcp: { name: "rebake-graphic" } },
    async execute(ctx, input) {
      // Resolve the bake identity. Direct mode uses the input composition + props.
      // Clip mode reads the overlay clip's `vean:composition` metadata off the
      // timeline (the same shape `timeline.addGraphic` stamps + the parser reads
      // back), so editing the timeline clip and re-baking stay in lockstep.
      let composition = input.composition;
      let props = input.props ?? {};
      if (input.clipUuid) {
        const { parseDoc } = await import("../bridge/tools/core");
        const { resolveTimelineTarget } = await import("../state/timeline");
        const project = projectFor(ctx, input.repo);
        const timeline = resolveTimelineTarget(
          project.rootPath,
          project,
          input.timeline ?? input.uri,
        );
        if ("ok" in timeline) return timeline;
        const state = parseDoc(await readDoc(timeline.uri));
        const clip = [...state.tracks.video, ...state.tracks.audio]
          .flatMap((track) => track.items)
          .find((item) => item.kind === "clip" && item.id === input.clipUuid);
        if (!clip || clip.kind !== "clip") {
          return {
            ok: false,
            kind: "clip-not-found",
            detail: `no clip ${input.clipUuid} on ${timeline.uri}`,
            uri: timeline.uri,
          };
        }
        if (!clip.composition) {
          return {
            ok: false,
            kind: "not-a-remotion-overlay",
            detail: `clip ${input.clipUuid} has no vean:composition metadata; it is not a Remotion overlay`,
            uri: timeline.uri,
          };
        }
        composition = clip.composition.id;
        // The clip's baked props are the bake inputs; a non-empty `props` input
        // still overrides them when the caller re-bakes with edited inputs.
        props = Object.keys(props).length > 0 ? props : (clip.composition.props ?? {});
      }
      if (!composition) {
        return {
          ok: false,
          kind: "invalid-args",
          detail: "graphic.rebake could not resolve a composition id",
        };
      }
      // Delegate the actual render + cache refresh to remotion.render with
      // force:true — identical render flags, alpha check, and cache record, so a
      // re-bake is exactly a forced bake of the resolved identity (DRY, not a
      // second copy of the render block).
      const envelope = await executeAction(
        "remotion.render",
        {
          composition,
          props,
          ...(input.frameRange ? { frameRange: input.frameRange } : {}),
          ...(input.out ? { out: input.out } : {}),
          profile: input.profile ?? "vertical",
          ...(input.repo ? { repo: input.repo } : {}),
          force: true,
        },
        ctx,
      );
      if (!envelope.ok) {
        return { ok: false, kind: envelope.kind, detail: envelope.detail };
      }
      return { ...(envelope.output as Record<string, unknown>), rebaked: true, composition, props };
    },
  }),
  action({
    id: "timeline.new",
    title: "New Timeline",
    description:
      "Create a blank .mlt timeline from a profile preset and write it to disk (optionally set timeline:main).",
    input: z.object({
      out: z.string().min(1),
      profile: z
        .enum(["vertical", "square", "landscape", "landscape-2997", "landscape-23976"])
        .default("vertical"),
      title: z.string().default("vean timeline"),
      videoTracks: z.number().int().positive().default(1),
      audioTracks: z.number().int().nonnegative().default(1),
      use: z.boolean().default(true),
      repo: z.string().optional(),
    }),
    output: z.unknown(),
    scopes: ["timeline:write", "fs:write", "state:read", "state:write"],
    effect: {
      ...baseEffects.stateWrite,
      kind: "create",
      mutates: ["filesystem", "projectState"],
    },
    surfaces: { cli: { command: "timeline new" }, mcp: { name: "timeline-new" } },
    async execute(ctx, input) {
      const { newTimeline } = await import("./timelineBuild");
      const { serializeDoc } = await import("../bridge/tools/core");
      const { resolve } = await import("node:path");
      const project = projectFor(ctx, input.repo);
      const outPath = resolve(project.rootPath, input.out);
      const tl = newTimeline({
        profile: input.profile ?? "vertical",
        title: input.title ?? "vean timeline",
        videoTracks: input.videoTracks ?? 1,
        audioTracks: input.audioTracks ?? 1,
      });
      await ctx.documents.write(outPath, serializeDoc(tl));
      let set = false;
      if (input.use !== false) {
        const { useTimeline } = await import("../state/timeline");
        const used = useTimeline(project.rootPath, project, outPath);
        set = !("ok" in used);
      }
      return {
        ok: true,
        path: outPath,
        profile: input.profile,
        set,
        touchedUris: [outPath],
        project,
      };
    },
  }),
  action({
    id: "timeline.addAudio",
    title: "Add Audio Clip",
    description:
      "Append an audio clip (music/voiceover) to an audio track, with optional gain (dB) and fades.",
    aliases: ["add-music"],
    relatedDiscovery: ["timeline.ops.describe"],
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
      resource: z.string().min(1),
      durationFrames: z.number().int().positive(),
      inFrame: frame.default(0),
      track: trackAddrInput.optional(),
      gainDb: z.number().optional(),
      fadeIn: z.number().int().nonnegative().optional(),
      fadeOut: z.number().int().nonnegative().optional(),
      createTrackIfMissing: z.boolean().default(true),
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
    surfaces: { cli: { command: "timeline add-audio" }, mcp: { name: "add-audio" } },
    async execute(ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const { addAudio } = await import("./timelineBuild");
      const { isEditError } = await import("../ops/types");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const state = parseDoc(await ctx.documents.read(timeline.uri));
      // Resolve a (kind,index) track address to its id (addAudio takes a trackId).
      let trackId: string | undefined;
      if (input.track) {
        if ("trackId" in input.track) trackId = input.track.trackId;
        else {
          const list = state.tracks[input.track.kind];
          const t = list[input.track.index];
          if (!t) {
            return {
              ok: false,
              kind: "track-not-found",
              detail: `no ${input.track.kind} track at index ${input.track.index}`,
              uri: timeline.uri,
            };
          }
          trackId = t.id;
        }
      }
      const result = addAudio(state, {
        resource: input.resource,
        durationFrames: input.durationFrames ?? 0,
        inFrame: input.inFrame ?? 0,
        ...(trackId ? { trackId } : {}),
        ...(input.gainDb != null ? { gainDb: input.gainDb } : {}),
        ...(input.fadeIn != null ? { fadeIn: input.fadeIn } : {}),
        ...(input.fadeOut != null ? { fadeOut: input.fadeOut } : {}),
        createTrackIfMissing: input.createTrackIfMissing ?? true,
      });
      if (!("state" in result)) {
        return { ok: false, kind: result.kind, detail: editErrorMsg(result), uri: timeline.uri };
      }
      await ctx.documents.write(timeline.uri, serializeDoc(result.state));
      return {
        ok: true,
        consequences: result.consequences,
        inverse: result.inverse,
        trackId: result.trackId,
        createdTrack: result.createdTrack,
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        touchedUris: [timeline.uri],
        project: timeline.project,
      };
    },
  }),
  action({
    id: "timeline.addFootage",
    title: "Add Footage Clip",
    description:
      "Append a footage (video) clip — e.g. a phone capture — to a video track. Duration is auto-probed from the file when omitted; footage lands on the first/bottom video track by default, below any graphics.",
    aliases: ["add-clip", "add-video"],
    relatedDiscovery: ["timeline.ops.describe"],
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
      resource: z.string().min(1),
      durationFrames: z.number().int().positive().optional(),
      inFrame: frame.default(0),
      track: trackAddrInput.optional(),
      label: z.string().optional(),
      createTrackIfMissing: z.boolean().default(true),
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
    surfaces: { cli: { command: "timeline add-footage" }, mcp: { name: "add-footage" } },
    async execute(ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const { addFootage } = await import("./timelineBuild");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const state = parseDoc(await ctx.documents.read(timeline.uri));
      // Resolve a (kind,index) track address to its id (addFootage takes a trackId).
      let trackId: string | undefined;
      if (input.track) {
        if ("trackId" in input.track) trackId = input.track.trackId;
        else {
          const list = state.tracks[input.track.kind];
          const t = list[input.track.index];
          if (!t) {
            return {
              ok: false,
              kind: "track-not-found",
              detail: `no ${input.track.kind} track at index ${input.track.index}`,
              uri: timeline.uri,
            };
          }
          trackId = t.id;
        }
      }
      // Auto-probe the clip length from the file when the caller didn't pass one.
      let durationFrames = input.durationFrames;
      if (durationFrames == null) {
        const { probeMediaFrames } = await import("../driver/melt");
        try {
          durationFrames = await probeMediaFrames(input.resource, state.profile.fps);
        } catch (e) {
          return {
            ok: false,
            kind: "probe-failed",
            detail: `could not auto-probe duration for ${input.resource}: ${
              e instanceof Error ? e.message : String(e)
            }. Pass --duration <frames>.`,
            uri: timeline.uri,
          };
        }
      }
      const result = addFootage(state, {
        resource: input.resource,
        durationFrames,
        inFrame: input.inFrame ?? 0,
        ...(trackId ? { trackId } : {}),
        ...(input.label ? { label: input.label } : {}),
        createTrackIfMissing: input.createTrackIfMissing ?? true,
      });
      if (!("state" in result)) {
        return { ok: false, kind: result.kind, detail: editErrorMsg(result), uri: timeline.uri };
      }
      await ctx.documents.write(timeline.uri, serializeDoc(result.state));
      return {
        ok: true,
        consequences: result.consequences,
        inverse: result.inverse,
        trackId: result.trackId,
        createdTrack: result.createdTrack,
        durationFrames,
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        touchedUris: [timeline.uri],
        project: timeline.project,
      };
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
    id: "media.probe",
    title: "Probe Media",
    description:
      "ffprobe a media file (duration, fps, resolution, audio streams) and cache the result on its catalog row. Probe one asset by id, an arbitrary path, or every un-probed asset with --all.",
    relatedDiscovery: ["media.list", "media.scan", "media.find"],
    input: z.object({
      repo: z.string().optional(),
      id: z.string().optional(),
      path: z.string().optional(),
      all: z.boolean().default(false),
    }),
    output: z.unknown(),
    scopes: ["media:read", "media:write", "process:execute", "fs:read"],
    effect: {
      kind: "update",
      mutates: ["projectState", "process"],
      openWorld: false,
      destructive: false,
      idempotency: "idempotent",
      reversibility: "none-needed",
      dryRun: "none",
      approval: "auto",
      audit: "metadata",
      job: { mode: "inline", cancellable: true, retrySafe: true },
    },
    surfaces: { cli: { command: "media probe" }, mcp: { name: "media-probe" } },
    async execute(ctx, input) {
      const { probeMedia } = await import("../driver/melt");
      const { getMediaAsset, listMediaAssets, setMediaProbe } = await import("../state/media");
      const repo = input.repo ?? ctx.project?.rootPath ?? ctx.cwd;

      // Ad-hoc path probe (not cataloged) → just return the probe.
      if (input.path) {
        return { path: input.path, probe: await probeMedia(uriToPath(input.path)) };
      }
      // Every un-probed cataloged asset.
      if (input.all) {
        const pending = listMediaAssets(repo).filter(
          (a) => !a.probeJson || a.probeJson === "{}" || a.probeJson === "[]",
        );
        const probed: Array<{ id: string; relativePath: string }> = [];
        for (const asset of pending) {
          try {
            setMediaProbe(repo, asset.id, await probeMedia(asset.path));
            probed.push({ id: asset.id, relativePath: asset.relativePath });
          } catch {
            // skip un-probable files (non-media, missing) — leave probeJson as-is
          }
        }
        return { probed: probed.length, of: pending.length, assets: probed };
      }
      // One cataloged asset by id.
      if (input.id) {
        const asset = getMediaAsset(repo, input.id);
        if (!asset) return { ok: false, kind: "not-found", detail: `no media asset ${input.id}` };
        const probe = await probeMedia(asset.path);
        return { asset: setMediaProbe(repo, input.id, probe), probe };
      }
      return {
        ok: false,
        kind: "invalid-args",
        detail: "media.probe needs one of: id, path, or --all",
      };
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
    id: "worktree.whereami",
    title: "Where Am I",
    description:
      "Report this checkout's worktree identity: slug, branch, primary/linked, its state DB path, the live drive session (if any), and where the on-PATH `vean` resolves. The read-only answer to 'which version am I looking at?' across concurrent worktrees.",
    relatedDiscovery: ["setup.doctor", "project.current"],
    input: repoInput,
    output: z.unknown(),
    scopes: ["state:read"],
    effect: baseEffects.stateRead,
    surfaces: { cli: { command: "whereami" }, mcp: { name: "whereami" } },
    async execute(ctx, input) {
      const { readOrInitWorktreeState } = await import("../state/worktree");
      const { stateDbPath } = await import("../state/db");
      const { resolveVeanBin } = await import("../cli/doctor");
      // Anchor to the CHECKOUT you are standing in (cwd), NOT repoFor's resolved
      // project. A fresh worktree has no `.vean/vean.db`, so project resolution
      // falls back to the GLOBAL active-project pointer (~/.vean/projects.json)
      // and would report a different tree (e.g. projects/retire) — the exact
      // failure whereami exists to prevent. An explicit `--repo` still wins.
      const repo = input.repo ?? ctx.cwd;
      // Persist the slug on first whereami so it stays stable across the session
      // (the same place doctor points to for stamping .vean/worktree.json).
      const identity = readOrInitWorktreeState(repo);
      // Read the drive session keyed by THIS worktree's slug directly off disk —
      // the drive script (scripts/drive.ts) owns the file; we never import it.
      let driveSession: { name: string; url: string; port: number; status: string } | null = null;
      try {
        const { readFileSync, existsSync } = await import("node:fs");
        const { join } = await import("node:path");
        const sessionPath = join(repo, ".vean", "drive", `${identity.slug}.json`);
        if (existsSync(sessionPath)) {
          const s = JSON.parse(readFileSync(sessionPath, "utf8")) as {
            name?: string;
            url?: string;
            port?: number;
            status?: string;
          };
          driveSession = {
            name: s.name ?? identity.slug,
            url: s.url ?? "",
            port: s.port ?? 0,
            status: s.status ?? "unknown",
          };
        }
      } catch {
        // A missing/malformed drive session is simply "no live session".
        driveSession = null;
      }
      const bin = resolveVeanBin(repo);
      return {
        worktreePath: repo,
        slug: identity.slug,
        branch: identity.branch,
        isPrimary: identity.isPrimary,
        source: identity.source,
        stateDbPath: stateDbPath(repo),
        driveSession,
        veanBinResolvesTo: bin.onPath,
        veanBinMatchesCheckout: bin.matchesCheckout,
      };
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
  // ════════════════════════════════════════════════════════════════════════════
  // STREAM S3 — EDITORIAL MACROS + inspect-timeline (roadmap T6 / a.4).
  // FLAG (integration): this block is the ONLY edit S3 makes to this shared file.
  // It registers 6 actions (timeline.applyLayout, timeline.addBrollOverRange,
  // timeline.duckMusic, timeline.tightenCut, timeline.removeDeadAir, and the
  // inspect-timeline read tool). Each editorial macro lives in `./editorial.ts`
  // (a pure helper composing existing ops, exactly like `./graphic.ts`); the
  // inspect-timeline tool lives in `../bridge/tools/read.ts`. No new op kinds.
  // Merge order: independent of every other stream's registry block — append-only.
  // ════════════════════════════════════════════════════════════════════════════
  action({
    id: "timeline.applyLayout",
    title: "Apply Talking-Head + B-roll Layout",
    description:
      "Lay out a talking-head + b-roll relationship over a range: a straight intercut (full-frame cutaway), a stacked split-screen, or a floating PiP overlay — WITH the correct crop so the subject fills its slot without stretching. Prefer THIS over low-level clip-property edits whenever a layout expresses the intent.",
    relatedDiscovery: [
      "timeline.addBrollOverRange",
      "timeline.addGraphic",
      "timeline.ops.describe",
    ],
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
      brollResource: z.string().min(1),
      mode: z.enum(["intercut", "split", "overlay"]).default("intercut"),
      position: frame,
      durationFrames: z.number().int().positive(),
      inFrame: frame.default(0),
      insetSlot: z
        .object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          w: z.number().min(0).max(1),
          h: z.number().min(0).max(1),
        })
        .optional(),
      newTrack: z.boolean().default(false),
      blendService: z.string().default("qtblend"),
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
    surfaces: { cli: { command: "timeline apply-layout" }, mcp: { name: "apply-layout" } },
    async execute(ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const { applyLayout } = await import("./editorial");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const state = parseDoc(await readDoc(timeline.uri));
      const result = applyLayout(state, {
        brollResource: input.brollResource,
        mode: input.mode ?? "intercut",
        position: input.position,
        durationFrames: input.durationFrames,
        inFrame: input.inFrame ?? 0,
        ...(input.insetSlot ? { insetSlot: input.insetSlot } : {}),
        newTrack: input.newTrack ?? false,
        blendService: input.blendService ?? "qtblend",
      });
      if (!("state" in result)) {
        return { ok: false, kind: result.kind, detail: editErrorMsg(result), uri: timeline.uri };
      }
      await writeDoc(timeline.uri, serializeDoc(result.state));
      return {
        ok: true,
        mode: result.mode,
        consequences: result.consequences,
        inverse: result.inverse,
        overlayTrackId: result.overlayTrackId,
        createdTrack: result.createdTrack,
        aTrack: result.aTrack,
        bTrack: result.bTrack,
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        touchedUris: [timeline.uri],
        project: timeline.project,
      };
    },
  }),
  action({
    id: "timeline.addBrollOverRange",
    title: "Add B-roll Over a Range",
    description:
      "Cover a [startFrame, endFrame] range with b-roll — a full-frame cutaway by default (intercut), or a split/overlay layout. Addresses the cut by endpoints (the way an agent thinks about a VO line). Thin sugar over apply-layout.",
    relatedDiscovery: ["timeline.applyLayout"],
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
      brollResource: z.string().min(1),
      startFrame: frame,
      endFrame: frame,
      inFrame: frame.default(0),
      mode: z.enum(["intercut", "split", "overlay"]).default("intercut"),
      insetSlot: z
        .object({
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          w: z.number().min(0).max(1),
          h: z.number().min(0).max(1),
        })
        .optional(),
      newTrack: z.boolean().default(false),
      blendService: z.string().default("qtblend"),
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
    surfaces: { cli: { command: "timeline add-broll" }, mcp: { name: "add-broll" } },
    async execute(ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const { addBrollOverRange } = await import("./editorial");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const state = parseDoc(await readDoc(timeline.uri));
      const result = addBrollOverRange(state, {
        brollResource: input.brollResource,
        startFrame: input.startFrame,
        endFrame: input.endFrame,
        inFrame: input.inFrame ?? 0,
        mode: input.mode ?? "intercut",
        ...(input.insetSlot ? { insetSlot: input.insetSlot } : {}),
        newTrack: input.newTrack ?? false,
        blendService: input.blendService ?? "qtblend",
      });
      if (!("state" in result)) {
        return { ok: false, kind: result.kind, detail: editErrorMsg(result), uri: timeline.uri };
      }
      await writeDoc(timeline.uri, serializeDoc(result.state));
      return {
        ok: true,
        mode: result.mode,
        consequences: result.consequences,
        inverse: result.inverse,
        overlayTrackId: result.overlayTrackId,
        createdTrack: result.createdTrack,
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        touchedUris: [timeline.uri],
        project: timeline.project,
      };
    },
  }),
  action({
    id: "timeline.duckMusic",
    title: "Duck Music Under Speech",
    description:
      "Duck a music bed under speech by lowering the music clip(s) gain (default -12 dB, relative to their current level). Target by clip ids, or let the macro duck every clip on the music track (the first audio track that isn't the speech track).",
    aliases: ["duck-music-under-speech"],
    relatedDiscovery: ["timeline.ops.describe"],
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
      musicClipIds: z.array(z.string().min(1)).optional(),
      musicTrackId: z.string().optional(),
      speechTrackId: z.string().optional(),
      duckDb: z.number().default(-12),
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
    surfaces: { cli: { command: "timeline duck-music" }, mcp: { name: "duck-music" } },
    async execute(ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const { duckMusicUnderSpeech } = await import("./editorial");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const state = parseDoc(await readDoc(timeline.uri));
      const result = duckMusicUnderSpeech(state, {
        ...(input.musicClipIds ? { musicClipIds: input.musicClipIds } : {}),
        ...(input.musicTrackId ? { musicTrackId: input.musicTrackId } : {}),
        ...(input.speechTrackId ? { speechTrackId: input.speechTrackId } : {}),
        duckDb: input.duckDb ?? -12,
      });
      if (!("state" in result)) {
        return { ok: false, kind: result.kind, detail: editErrorMsg(result), uri: timeline.uri };
      }
      await writeDoc(timeline.uri, serializeDoc(result.state));
      return {
        ok: true,
        consequences: result.consequences,
        inverse: result.inverse,
        duckedClipIds: result.duckedClipIds,
        duckDb: result.duckDb,
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        touchedUris: [timeline.uri],
        project: timeline.project,
      };
    },
  }),
  action({
    id: "timeline.tightenCut",
    title: "Tighten Cut",
    description:
      "Tighten a cut by trimming dead frames off a clip's head and/or tail (lose the slack before/after a line). Non-ripple by default (grows the neighbouring gap); ripple pulls downstream content in.",
    aliases: ["tighten-cut"],
    relatedDiscovery: ["timeline.removeDeadAir", "timeline.ops.describe"],
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
      uuid: z.string().min(1),
      headFrames: z.number().int().nonnegative().default(0),
      tailFrames: z.number().int().nonnegative().default(0),
      ripple: z.boolean().default(false),
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
    surfaces: { cli: { command: "timeline tighten-cut" }, mcp: { name: "tighten-cut" } },
    async execute(ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const { tightenCut } = await import("./editorial");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const state = parseDoc(await readDoc(timeline.uri));
      const result = tightenCut(state, {
        uuid: input.uuid,
        headFrames: input.headFrames ?? 0,
        tailFrames: input.tailFrames ?? 0,
        ripple: input.ripple ?? false,
      });
      if (!("state" in result)) {
        return { ok: false, kind: result.kind, detail: editErrorMsg(result), uri: timeline.uri };
      }
      await writeDoc(timeline.uri, serializeDoc(result.state));
      return {
        ok: true,
        consequences: result.consequences,
        inverse: result.inverse,
        uuid: result.uuid,
        headFrames: result.headFrames,
        tailFrames: result.tailFrames,
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        touchedUris: [timeline.uri],
        project: timeline.project,
      };
    },
  }),
  action({
    id: "timeline.removeDeadAir",
    title: "Remove Dead Air",
    description:
      "Remove dead air (gaps) on a track by ripple-closing every literal blank gap >= minGapFrames (a pause, a lifted clip's hole). Operates on gaps the track already carries — no silence detection. Defaults to the first video track.",
    aliases: ["remove-dead-air"],
    relatedDiscovery: ["timeline.tightenCut", "timeline.ops.describe"],
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
      trackId: z.string().optional(),
      minGapFrames: z.number().int().positive().default(1),
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
    surfaces: { cli: { command: "timeline remove-dead-air" }, mcp: { name: "remove-dead-air" } },
    async execute(ctx, input) {
      const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
      const { resolveTimelineTarget } = await import("../state/timeline");
      const { removeDeadAir } = await import("./editorial");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const state = parseDoc(await readDoc(timeline.uri));
      const result = removeDeadAir(state, {
        ...(input.trackId ? { trackId: input.trackId } : {}),
        minGapFrames: input.minGapFrames ?? 1,
      });
      if (!("state" in result)) {
        return { ok: false, kind: result.kind, detail: editErrorMsg(result), uri: timeline.uri };
      }
      await writeDoc(timeline.uri, serializeDoc(result.state));
      return {
        ok: true,
        consequences: result.consequences,
        inverse: result.inverse,
        gapsClosed: result.gapsClosed,
        framesRemoved: result.framesRemoved,
        trackId: result.trackId,
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        touchedUris: [timeline.uri],
        project: timeline.project,
      };
    },
  }),
  action({
    id: "inspect.timeline",
    title: "Inspect Timeline (Still-Strip)",
    description:
      "Render a STILL-STRIP across [startFrame, endFrame] (evenly spaced, capped at maxFrames) via melt so the agent SEES its edit — a cut, a fade, a layout — in one call. Returns the produced PNGs in touchedUris (the frames to read next).",
    relatedDiscovery: ["render.still", "timeline.applyLayout"],
    input: z.object({
      uri: z.string().optional(),
      timeline: z.string().optional(),
      startFrame: frame,
      endFrame: frame,
      maxFrames: z.number().int().positive().max(64).default(8),
      outDir: z.string().optional(),
    }),
    output: z.unknown(),
    scopes: ["timeline:read", "render:execute", "process:execute", "fs:read", "fs:write"],
    effect: {
      kind: "render",
      mutates: ["filesystem", "process"],
      openWorld: false,
      destructive: false,
      idempotency: "idempotent",
      reversibility: "manual",
      dryRun: "none",
      approval: "ask",
      audit: "metadata",
      job: { mode: "inline", cancellable: true, retrySafe: true },
    },
    surfaces: { cli: { command: "inspect timeline" }, mcp: { name: "inspect-timeline" } },
    async execute(ctx, input) {
      const { resolveTimelineTarget } = await import("../state/timeline");
      const { inspectTimelineTool } = await import("../bridge/tools/read");
      const project = projectFor(ctx);
      const timeline = resolveTimelineTarget(
        project.rootPath,
        project,
        input.timeline ?? input.uri,
      );
      if ("ok" in timeline) return timeline;
      const result = await inspectTimelineTool(
        uriToPath(timeline.uri),
        {
          startFrame: input.startFrame,
          endFrame: input.endFrame,
          maxFrames: input.maxFrames ?? 8,
        },
        input.outDir ? uriToPath(input.outDir) : undefined,
      );
      return {
        ...result,
        uri: timeline.uri,
        resolvedPath: timeline.resolvedPath,
        project: timeline.project,
      };
    },
  }),
  // ── S4 generative provenance import (T7) — wired at integration ──
  importWithProvenanceAction,
  // ── S5 skills catalog (T8) — wired at integration ──
  ...skillActions,
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
    inputSummary: summarizeSchema(action.input),
    outputSummary: summarizeSchema(action.output),
    aliases: action.aliases ?? [],
    examples: action.examples ?? [],
    relatedDiscovery: action.relatedDiscovery,
    surfaces: action.surfaces,
    policy: defaultPolicyLevel(action),
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
  // Thread the concrete policy decision through the context so an action (and the
  // surfaces projecting from it) can read what level THIS invocation was gated at.
  // Additive only — the deny gate above is unchanged, so behavior is identical.
  const execCtx: ActionContext = {
    ...ctx,
    policy: ctx.policy ?? evaluatePolicy(definition, ctx, parsed.data),
  };
  try {
    const output = await definition.execute(execCtx, parsed.data);
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
