import { existsSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import type { ResolvedProject } from "../project/context";
import {
  type RouteAliasRecord,
  listMediaAssets,
  listRouteAliases,
  resolveRouteAlias,
  setRouteAlias,
} from "./media";
import { initializeProject } from "./project";

export const ACTIVE_TIMELINE_ALIAS = "timeline:main";

export type TimelineFailureKind =
  | "missing-active-timeline"
  | "unknown-route"
  | "route-chain"
  | "stale-route"
  | "not-timeline"
  | "directory";

export type TimelineFailure = {
  ok: false;
  kind: TimelineFailureKind;
  detail: string;
  suggestions?: string[];
};

export type ResolvedTimeline = {
  alias?: string;
  routeChain: string[];
  uri: string;
  resolvedPath: string;
  outsideProject: boolean;
  project: ResolvedProject;
};

export type TimelineListEntry = {
  path: string;
  uri: string;
  source: "catalog" | "route" | "both";
  aliases: string[];
  stale: boolean;
  outsideProject: boolean;
};

function isRouteAlias(value: string): boolean {
  return /^[a-z][a-z0-9-]*:[^\s]+$/i.test(value) && !value.startsWith("file://");
}

function pathFromTarget(projectRoot: string, target: string): string {
  if (target.startsWith("file://")) return decodeURIComponent(target.slice("file://".length));
  return isAbsolute(target) ? target : resolve(projectRoot, target);
}

function isOutsideProject(projectRoot: string, path: string): boolean {
  const rel = relative(projectRoot, path);
  return rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel);
}

function validateTimelinePath(path: string): TimelineFailure | undefined {
  if (!existsSync(path)) {
    return { ok: false, kind: "stale-route", detail: `timeline path does not exist: ${path}` };
  }
  const stat = statSync(path);
  if (stat.isDirectory()) {
    return { ok: false, kind: "directory", detail: `timeline target is a directory: ${path}` };
  }
  if (!stat.isFile()) {
    return { ok: false, kind: "not-timeline", detail: `timeline target is not a file: ${path}` };
  }
  if (extname(path).toLowerCase() !== ".mlt") {
    return {
      ok: false,
      kind: "not-timeline",
      detail: `timeline target is not a .mlt file: ${path}`,
    };
  }
}

function resolveRouteChain(
  repo: string,
  target: string,
): { target: string; chain: string[] } | TimelineFailure {
  if (!isRouteAlias(target)) return { target, chain: [] };

  const first = resolveRouteAlias(repo, target);
  if (!first) {
    return { ok: false, kind: "unknown-route", detail: `unknown route alias: ${target}` };
  }
  const chain = [first.alias];
  if (!isRouteAlias(first.target)) return { target: first.target, chain };

  if (first.target === first.alias) {
    return { ok: false, kind: "route-chain", detail: `circular route alias: ${first.alias}` };
  }
  const second = resolveRouteAlias(repo, first.target);
  if (!second) {
    return { ok: false, kind: "unknown-route", detail: `unknown route alias: ${first.target}` };
  }
  chain.push(second.alias);
  if (second.target === first.alias || isRouteAlias(second.target)) {
    return {
      ok: false,
      kind: "route-chain",
      detail: `route alias chain is deeper than one indirection: ${chain.join(" -> ")}`,
    };
  }
  return { target: second.target, chain };
}

export function timelineFailure(
  kind: TimelineFailureKind,
  detail: string,
  suggestions: string[] = ["vean timeline list --json", "vean timeline use <path> --json"],
): TimelineFailure {
  return { ok: false, kind, detail, suggestions };
}

export function resolveTimelineTarget(
  repo: string,
  project: ResolvedProject,
  target?: string,
): ResolvedTimeline | TimelineFailure {
  const requested = target ?? ACTIVE_TIMELINE_ALIAS;
  const chain = resolveRouteChain(repo, requested);
  if (
    !target &&
    "ok" in chain &&
    chain.kind === "unknown-route" &&
    requested === ACTIVE_TIMELINE_ALIAS
  ) {
    return timelineFailure("missing-active-timeline", "no active timeline is configured");
  }
  if ("ok" in chain) return chain;
  const resolvedPath = resolve(pathFromTarget(project.rootPath, chain.target));
  const invalid = validateTimelinePath(resolvedPath);
  if (invalid) return invalid;
  return {
    alias: chain.chain[0],
    routeChain: chain.chain,
    uri: resolvedPath,
    resolvedPath,
    outsideProject: isOutsideProject(project.rootPath, resolvedPath),
    project,
  };
}

export function useTimeline(
  repo: string,
  project: ResolvedProject,
  target: string,
):
  | {
      canonicalRoute: typeof ACTIVE_TIMELINE_ALIAS;
      route: RouteAliasRecord;
      activeTimeline: ResolvedTimeline;
    }
  | TimelineFailure {
  const resolved = resolveTimelineTarget(repo, project, target);
  if ("ok" in resolved) return resolved;
  const route = setRouteAlias(repo, ACTIVE_TIMELINE_ALIAS, resolved.resolvedPath);
  return { canonicalRoute: ACTIVE_TIMELINE_ALIAS, route, activeTimeline: resolved };
}

export function currentTimeline(
  repo: string,
  project: ResolvedProject,
): { activeTimeline: ResolvedTimeline | null; next?: string[] } | TimelineFailure {
  const route = resolveRouteAlias(repo, ACTIVE_TIMELINE_ALIAS);
  if (!route) {
    return {
      activeTimeline: null,
      next: ["vean timeline list --json", "vean timeline use <path> --json"],
    };
  }
  const resolved = resolveTimelineTarget(repo, project, ACTIVE_TIMELINE_ALIAS);
  if ("ok" in resolved) return resolved;
  return { activeTimeline: resolved };
}

export function listTimelines(repo: string, project: ResolvedProject): TimelineListEntry[] {
  initializeProject(repo);
  const rows = new Map<string, TimelineListEntry>();
  const upsert = (path: string, source: TimelineListEntry["source"], alias?: string): void => {
    const resolvedPath = resolve(path);
    const existing = rows.get(resolvedPath);
    const stale = !existsSync(resolvedPath);
    if (existing) {
      existing.source = existing.source === source ? source : "both";
      if (alias && !existing.aliases.includes(alias)) existing.aliases.push(alias);
      existing.stale = existing.stale && stale;
      return;
    }
    rows.set(resolvedPath, {
      path: resolvedPath,
      uri: resolvedPath,
      source,
      aliases: alias ? [alias] : [],
      stale,
      outsideProject: isOutsideProject(project.rootPath, resolvedPath),
    });
  };

  for (const asset of listMediaAssets(repo, "timeline")) upsert(asset.path, "catalog");
  for (const route of listRouteAliases(repo).filter((entry) =>
    entry.alias.startsWith("timeline:"),
  )) {
    const resolved = resolveRouteChain(repo, route.alias);
    if ("ok" in resolved) {
      upsert(route.target, "route", route.alias);
      continue;
    }
    upsert(pathFromTarget(project.rootPath, resolved.target), "route", route.alias);
  }
  return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
}
