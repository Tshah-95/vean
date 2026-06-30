import type { z } from "zod";
import type { ResolveProjectOptions, ResolvedProject } from "../project/context";
import type { StateDbHandle } from "../state/db";
import type { PolicyDecision } from "./policy";
import type { SchemaSummary } from "./schema-summary";

export type ActionScope =
  | "timeline:read"
  | "timeline:write"
  | "media:read"
  | "media:write"
  | "render:execute"
  | "state:read"
  | "state:write"
  | "jobs:read"
  | "jobs:write"
  | "fs:read"
  | "fs:write"
  | "process:execute"
  | "external:open";

export type ActionEffect = {
  kind: "read" | "compute" | "preview" | "create" | "update" | "delete" | "render" | "execute";
  mutates: Array<"timeline" | "projectState" | "jobState" | "filesystem" | "process" | "external">;
  openWorld: boolean;
  destructive: boolean;
  idempotency: "pure" | "idempotent" | "non-idempotent";
  reversibility: "none-needed" | "inverse-op" | "snapshot" | "manual" | "irreversible";
  dryRun: "none" | "supported" | "required";
  approval: "auto" | "ask" | "ask-strong" | "deny";
  audit: "none" | "metadata" | "full-input";
  job?: { mode: "inline" | "queued"; cancellable: boolean; retrySafe: boolean };
};

/** The permission level the default policy assigns an action (see `./policy`). */
export type PolicyLevel = "auto" | "ask" | "ask-strong" | "deny";

export type ActionSurfaces = {
  cli?:
    | {
        command?: string;
        hidden?: false;
      }
    | {
        hidden: true;
        reason: string;
      };
  mcp?: { name?: string; hidden?: boolean };
  lsp?: { codeActionKind: string; onlyWhenDiagnostic?: string };
  tauri?: { command?: string; windows?: string[] };
};

/** The surface an action is executing on (which adapter invoked it). */
export type ActionSurface = "cli" | "mcp" | "lsp" | "tauri" | "test";

// ─── Injected capabilities ─────────────────────────────────────────────────
// An action's side-effecting dependencies, threaded through `ActionContext`
// instead of reached via ambient module imports. The defaults (see
// `createActionContext`) reproduce today's behavior exactly, so the migration is
// mechanical and behavior-preserving; the seam is what lets a test or a future
// surface (S3 editorial macros, S4 generative producer) inject a fake document
// store, a frozen clock, or a deterministic id factory.

/** Read/write timeline documents by URI (`file://…` or a bare path). Defaults to
 *  the filesystem; a test can inject an in-memory store. */
export type DocumentStore = {
  read(uri: string): Promise<string>;
  write(uri: string, text: string): Promise<void>;
};

/** The wall clock, injected so time-stamped output (cache rows, job timings) is
 *  deterministic under test. Defaults to the real system clock. */
export type Clock = {
  now(): Date;
  nowIso(): string;
};

/** Mints stable ids for runtime-created entities. Defaults to `crypto.randomUUID`;
 *  a test can inject a deterministic counter. */
export type IdFactory = {
  uuid(): string;
};

/** A minimal structured logger. Defaults to a console-backed sink (quiet at
 *  `debug`); a surface can route these to its own diagnostics channel. */
export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
};

/** Lazily open the repo-local state DB (`./db` `openStateDb`). Async so merely
 *  CONSTRUCTING a context never eagerly pulls in `bun:sqlite` — the heavy module
 *  loads only when an action actually touches state. The caller owns closing the
 *  returned handle's `sqlite`, exactly as today. */
export type StateAccess = {
  open(repo?: string): Promise<StateDbHandle>;
};

/** Resolve a project reference against this context's cwd/env. Bound at context
 *  construction so an action doesn't re-thread cwd/env to resolve. */
export type ProjectResolver = (options?: ResolveProjectOptions) => ResolvedProject | undefined;

export type ActionContext = {
  cwd: string;
  surface: ActionSurface;
  project?: ResolvedProject;
  env: NodeJS.ProcessEnv;
  // ── Injected capabilities (defaulted by `createActionContext`) ──
  /** Read/write timeline documents (defaults to the filesystem). */
  documents: DocumentStore;
  /** The wall clock (defaults to the system clock). */
  clock: Clock;
  /** Stable id factory (defaults to `crypto.randomUUID`). */
  ids: IdFactory;
  /** Structured logger (defaults to a console-backed sink). */
  logger: Logger;
  /** Project resolver bound to this context's cwd/env. */
  resolveProject: ProjectResolver;
  /** Lazy repo-local state-DB access. */
  state: StateAccess;
  /** Cooperative cancellation for long-running actions (render, jobs). When the
   *  invoking surface supports it (e.g. a Tauri cancel button), it's threaded
   *  here; absent for one-shot CLI calls. */
  signal?: AbortSignal;
  /** The policy decision computed for this invocation, when the caller evaluated
   *  it before dispatch (`executeAction` threads it through). Absent for direct
   *  `definition.execute` calls that bypass policy. */
  policy?: PolicyDecision;
};

export type ActionDefinition<I = unknown, O = unknown> = {
  id: string;
  title: string;
  description: string;
  aliases?: string[];
  examples?: Array<{ name: string; input: unknown; prompt?: string }>;
  relatedDiscovery?: string[];
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  scopes: ActionScope[];
  effect: ActionEffect;
  surfaces: ActionSurfaces;
  execute(ctx: ActionContext, input: I): Promise<O> | O;
};

export type ActionDescriptor = {
  id: string;
  title: string;
  description: string;
  scopes: ActionScope[];
  effect: ActionEffect;
  inputSummary: SchemaSummary;
  outputSummary: SchemaSummary;
  aliases: string[];
  examples: Array<{ name: string; input: unknown; prompt?: string }>;
  relatedDiscovery?: string[];
  surfaces: ActionSurfaces;
  /** The context-free default-policy level (see `./policy` → `defaultPolicyLevel`). */
  policy: PolicyLevel;
  mcpAnnotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
};

export type ActionEnvelope<O = unknown> =
  | {
      ok: true;
      actionId: string;
      output: O;
      project?: ResolvedProject;
    }
  | {
      ok: false;
      actionId: string;
      kind: "not-found" | "validation" | "policy" | "execution";
      detail: string;
      project?: ResolvedProject;
    };
