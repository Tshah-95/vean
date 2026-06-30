import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const STATE_DIR_NAME = ".vean";
const STATE_DB_NAME = "vean.db";
const CONFIG_FILE_NAME = "projects.json";

export type KnownProject = {
  id: string;
  rootPath: string;
  title: string | null;
  lastUsedAt: string;
};

export type ProjectConfig = {
  activeProjectRoot?: string;
  knownProjects: KnownProject[];
};

export type ProjectResolutionSource = "explicit" | "env" | "nearest" | "active" | "unresolved";

export type ResolvedProject = {
  rootPath: string;
  source: ProjectResolutionSource;
  id?: string;
  title?: string | null;
  stateDbPath: string;
};

export type ResolveProjectOptions = {
  project?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function userConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.VEAN_CONFIG_HOME ?? join(homedir(), ".vean"));
}

export function projectConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(userConfigDir(env), CONFIG_FILE_NAME);
}

export function stateDbPathForProject(rootPath: string): string {
  return join(rootPath, STATE_DIR_NAME, STATE_DB_NAME);
}

export function readProjectConfig(env: NodeJS.ProcessEnv = process.env): ProjectConfig {
  const path = projectConfigPath(env);
  if (!existsSync(path)) return { knownProjects: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ProjectConfig>;
  const config: ProjectConfig = {
    activeProjectRoot: parsed.activeProjectRoot,
    knownProjects: Array.isArray(parsed.knownProjects) ? parsed.knownProjects : [],
  };
  return gcProjectConfig(config, env);
}

// GC-on-read (DESIGN-WORKTREE §4.6): a removed worktree leaves no machine-global
// trace except a stale `~/.vean/projects.json` entry. Prune `knownProjects` whose
// `rootPath` no longer exists on disk, and clear `activeProjectRoot` if it points
// at a now-missing path, so the implicit "active project" fallback never resolves
// to a deleted tree. Conservative: the sweep is bounded to `knownProjects` (small)
// and the precedence in `resolveProject` (--project > VEAN_PROJECT > cwd walk-up >
// active fallback) is untouched. We only rewrite the file when something was
// actually pruned, so the common read path stays a pure read.
function gcProjectConfig(config: ProjectConfig, env: NodeJS.ProcessEnv): ProjectConfig {
  const livingProjects = config.knownProjects.filter((p) => existsSync(p.rootPath));
  const activeMissing =
    config.activeProjectRoot !== undefined &&
    !existsSync(resolveActiveRoot(config.activeProjectRoot));
  if (livingProjects.length === config.knownProjects.length && !activeMissing) {
    return config; // nothing dead — leave the file untouched.
  }
  const pruned: ProjectConfig = {
    activeProjectRoot: activeMissing ? undefined : config.activeProjectRoot,
    knownProjects: livingProjects,
  };
  writeProjectConfig(pruned, env);
  return pruned;
}

function resolveActiveRoot(activeProjectRoot: string): string {
  return isAbsolute(activeProjectRoot) ? activeProjectRoot : resolve(activeProjectRoot);
}

export function writeProjectConfig(
  config: ProjectConfig,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = projectConfigPath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function rememberProject(
  project: { id: string; rootPath: string; title: string | null },
  env: NodeJS.ProcessEnv = process.env,
): KnownProject {
  const config = readProjectConfig(env);
  const rootPath = resolve(project.rootPath);
  const known: KnownProject = {
    id: project.id,
    rootPath,
    title: project.title,
    lastUsedAt: nowIso(),
  };
  config.knownProjects = [known, ...config.knownProjects.filter((p) => p.rootPath !== rootPath)];
  writeProjectConfig(config, env);
  return known;
}

export function setActiveProject(
  project: { id: string; rootPath: string; title: string | null },
  env: NodeJS.ProcessEnv = process.env,
): KnownProject {
  const config = readProjectConfig(env);
  const rootPath = resolve(project.rootPath);
  const known: KnownProject = {
    id: project.id,
    rootPath,
    title: project.title,
    lastUsedAt: nowIso(),
  };
  config.activeProjectRoot = rootPath;
  config.knownProjects = [known, ...config.knownProjects.filter((p) => p.rootPath !== rootPath)];
  writeProjectConfig(config, env);
  return known;
}

export function listKnownProjects(env: NodeJS.ProcessEnv = process.env): KnownProject[] {
  return readProjectConfig(env).knownProjects;
}

export function resolveProjectReference(
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  // Match a known project by id, exact rootPath, or TITLE (so `vean open retire`
  // resolves the project named "retire", not a cwd-relative `./retire`). Exact
  // id/path wins over title (checked first per project).
  const known =
    listKnownProjects(env).find((p) => p.id === value || p.rootPath === value) ??
    listKnownProjects(env).find((p) => p.title === value);
  if (known) return known.rootPath;
  return resolve(value);
}

export function findNearestProjectRoot(cwd = process.cwd()): string | undefined {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(stateDbPathForProject(current))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function resolveProject(options: ResolveProjectOptions = {}): ResolvedProject | undefined {
  const env = options.env ?? process.env;
  const cwd = resolve(options.cwd ?? process.cwd());
  const config = readProjectConfig(env);

  if (options.project) {
    const rootPath = resolveProjectReference(options.project, env);
    const known = config.knownProjects.find((p) => p.rootPath === rootPath);
    return {
      rootPath,
      source: "explicit",
      id: known?.id,
      title: known?.title,
      stateDbPath: stateDbPathForProject(rootPath),
    };
  }

  if (env.VEAN_PROJECT) {
    const rootPath = resolveProjectReference(env.VEAN_PROJECT, env);
    const known = config.knownProjects.find((p) => p.rootPath === rootPath);
    return {
      rootPath,
      source: "env",
      id: known?.id,
      title: known?.title,
      stateDbPath: stateDbPathForProject(rootPath),
    };
  }

  const nearest = findNearestProjectRoot(cwd);
  if (nearest) {
    const known = config.knownProjects.find((p) => p.rootPath === nearest);
    return {
      rootPath: nearest,
      source: "nearest",
      id: known?.id,
      title: known?.title,
      stateDbPath: stateDbPathForProject(nearest),
    };
  }

  if (config.activeProjectRoot) {
    const rootPath = resolveActiveRoot(config.activeProjectRoot);
    const known = config.knownProjects.find((p) => p.rootPath === rootPath);
    return {
      rootPath,
      source: "active",
      id: known?.id,
      title: known?.title,
      stateDbPath: stateDbPathForProject(rootPath),
    };
  }

  return undefined;
}
