import type { z } from "zod";
import type { ResolvedProject } from "../project/context";
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

export type ActionContext = {
  cwd: string;
  surface: "cli" | "mcp" | "lsp" | "tauri" | "test";
  project?: ResolvedProject;
  env: NodeJS.ProcessEnv;
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
