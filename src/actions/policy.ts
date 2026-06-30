// Default permission policy — the decision layer over the native effect metadata.
// Every action declares scopes + effects; this turns those (plus runtime context)
// into a single approval level the surfaces project down: CLI confirmations, MCP
// hints, and Tauri capabilities. Policy is computed HERE once, never re-decided per
// surface, so a "destructive" or "outside-project" action is gated consistently
// whether it is reached from the CLI, an MCP tool, or an app button.
import { resolve } from "node:path";
import type { ActionContext, ActionDefinition, PolicyLevel } from "./types";

export type { PolicyLevel } from "./types";

export type PolicyDecision = {
  level: PolicyLevel;
  reason: string;
};

const RANK: Record<PolicyLevel, number> = { auto: 0, ask: 1, "ask-strong": 2, deny: 3 };

/** The stronger of two levels (the policy never weakens a declared requirement). */
function strongest(a: PolicyLevel, b: PolicyLevel): PolicyLevel {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Input keys that name a filesystem destination, scanned to detect writes that
 *  would land outside the selected project. */
const PATH_KEYS = ["path", "out", "outPath", "dest", "destination", "target", "file"];

function writesOutsideProject(ctx: ActionContext, input: unknown): boolean {
  const root = ctx.project?.rootPath;
  if (!root || typeof input !== "object" || input === null) return false;
  const rootAbs = resolve(root);
  for (const key of PATH_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value.length > 0) {
      const abs = resolve(ctx.cwd, value.replace(/^file:\/\//, ""));
      if (abs !== rootAbs && !abs.startsWith(`${rootAbs}/`)) return true;
    }
  }
  return false;
}

/** The context-free baseline level an action requires — the value descriptors and
 *  capability projections carry (no runtime input considered). */
export function defaultPolicyLevel(definition: ActionDefinition): PolicyLevel {
  const eff = definition.effect;
  if (eff.approval === "deny") return "deny";
  if (eff.openWorld) return "deny";
  if (eff.destructive || eff.reversibility === "irreversible") return "ask-strong";
  if (eff.kind === "read" || eff.kind === "compute" || eff.kind === "preview") {
    return strongest(eff.approval, "auto");
  }
  // Any other mutating kind asks at least once.
  return strongest(eff.approval, "ask");
}

/** Evaluate the policy for a concrete invocation. Default policy:
 *  - **auto** — closed-world reads / compute / previews;
 *  - **ask** — timeline/state writes, render, process execution, queued jobs;
 *  - **ask-strong** — destructive, irreversible, or any filesystem write that
 *    resolves OUTSIDE the selected project;
 *  - **deny** — an explicit deny, or an open-world / network effect in a core
 *    action. */
export function evaluatePolicy(
  definition: ActionDefinition,
  ctx: ActionContext,
  input: unknown,
): PolicyDecision {
  const eff = definition.effect;
  if (eff.approval === "deny") return { level: "deny", reason: "denied by action policy" };
  if (eff.openWorld) {
    return { level: "deny", reason: "open-world/network effect denied by default policy" };
  }
  if (eff.mutates.includes("filesystem") && writesOutsideProject(ctx, input)) {
    return { level: "ask-strong", reason: "writes a path outside the selected project" };
  }
  if (eff.destructive) return { level: "ask-strong", reason: "destructive action" };
  if (eff.reversibility === "irreversible") {
    return { level: "ask-strong", reason: "irreversible action" };
  }
  if (eff.kind === "read" || eff.kind === "compute" || eff.kind === "preview") {
    return { level: strongest(eff.approval, "auto"), reason: "closed-world read/compute/preview" };
  }
  return {
    level: strongest(eff.approval, "ask"),
    reason: `${eff.kind} mutates ${eff.mutates.join("/") || "project state"}`,
  };
}
