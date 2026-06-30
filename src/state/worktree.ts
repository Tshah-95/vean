import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

// Mirror `STATE_DIR_NAME` from ./db without importing it — db.ts pulls in
// `bun:sqlite`, which vitest can't resolve, and this primitive must stay
// unit-testable (same pattern as src/state/settings.ts).
const STATE_DIR_NAME = ".vean";

export const WORKTREE_STATE_NAME = "worktree.json";

/** How the slug was resolved — surfaced so `whereami`/doctor can explain it. */
export type WorktreeSource = "env" | "worktree" | "branch" | "fallback";

/** The stable identity of a single checkout (primary or linked worktree). */
export type WorktreeIdentity = {
  /** Filesystem/agent-browser-safe slug; the default drive `--name` / agent-browser `--session`. */
  slug: string;
  /** Current branch name, or null when detached / outside a repo. */
  branch: string | null;
  /** True for the canonical checkout (or a non-git dir); false for a linked worktree. */
  isPrimary: boolean;
  /** Which precedence rule produced the slug. */
  source: WorktreeSource;
};

/** Persisted shape of `.vean/worktree.json`. */
export type WorktreeState = WorktreeIdentity & {
  /** ISO timestamp stamped on first init; stable across the session. */
  createdAt: string;
};

/**
 * Reduce an arbitrary string to a filesystem/agent-browser-safe slug:
 * lowercase, keep `[a-z0-9._-]`, collapse every other run to a single `-`,
 * and trim leading/trailing `-`. e.g. "claude/Busy Moore #4" → "claude-busy-moore-4".
 */
export function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The git facts the pure slug logic needs, gathered once by {@link resolveWorktreeSlug}. */
export type SlugInput = {
  /** Sanitized `VEAN_WORKTREE` override, if set. */
  envOverride?: string;
  /** False only for a linked (non-primary) git worktree. */
  isPrimary: boolean;
  /** Current branch (raw), or null when detached / outside a repo. */
  branch: string | null;
  /** Basename of the worktree toplevel — used as the slug for linked worktrees. */
  toplevelBasename: string;
};

/**
 * Pure slug precedence (no git, no I/O — unit-testable):
 *   1. `VEAN_WORKTREE` env override (source:"env");
 *   2. linked worktree → toplevel basename (source:"worktree");
 *   3. current branch, sanitized (source:"branch");
 *   4. "primary" (source:"fallback").
 */
export function computeSlug(input: SlugInput): { slug: string; source: WorktreeSource } {
  const env = input.envOverride ? sanitizeSlug(input.envOverride) : "";
  if (env) return { slug: env, source: "env" };

  if (!input.isPrimary) {
    const fromWorktree = sanitizeSlug(input.toplevelBasename);
    if (fromWorktree) return { slug: fromWorktree, source: "worktree" };
  }

  const fromBranch = input.branch ? sanitizeSlug(input.branch) : "";
  if (fromBranch) return { slug: fromBranch, source: "branch" };

  return { slug: "primary", source: "fallback" };
}

/** Run a git command in `repo`, returning trimmed stdout or null on any failure. */
function git(repo: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0 || result.error) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

/** Resolve a path to its canonical real form, tolerating non-existent paths. */
function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Gather git facts for `repo` and apply {@link computeSlug}. A linked worktree is
 * detected by `git rev-parse --git-dir` (resolves under `.../.git/worktrees/<name>`)
 * differing from `--git-common-dir` (the shared `.../.git`), compared by realpath.
 * Outside a git repo, the checkout is treated as primary with a slug from its basename.
 */
export function resolveWorktreeSlug(repo: string = process.cwd()): WorktreeIdentity {
  const envOverride = process.env.VEAN_WORKTREE?.trim() || undefined;

  const gitDir = git(repo, ["rev-parse", "--git-dir"]);
  const inRepo = gitDir !== null;

  let isPrimary = true;
  let branch: string | null = null;
  let toplevelBasename = basename(realpathOrSelf(repo));

  if (inRepo) {
    const commonDir = git(repo, ["rev-parse", "--git-common-dir"]);
    if (gitDir && commonDir) {
      // git may emit either dir relative to cwd; resolve against repo before comparing.
      isPrimary =
        realpathOrSelf(resolve(repo, gitDir)) === realpathOrSelf(resolve(repo, commonDir));
    }
    // `--show-current` is empty when detached; keep branch null in that case.
    branch = git(repo, ["branch", "--show-current"]);
    const toplevel = git(repo, ["rev-parse", "--show-toplevel"]);
    if (toplevel) toplevelBasename = basename(toplevel);
  }

  const { slug, source } = computeSlug({ envOverride, isPrimary, branch, toplevelBasename });
  return { slug, branch, isPrimary, source };
}

/** Path to the persisted identity file: `<repo>/.vean/worktree.json`. */
export function worktreeStatePath(repo: string = process.cwd()): string {
  return resolve(repo, STATE_DIR_NAME, WORKTREE_STATE_NAME);
}

/** Parse `.vean/worktree.json`, returning null if absent or malformed. */
function readWorktreeState(path: string): WorktreeState | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<WorktreeState>;
    if (typeof parsed.slug === "string" && typeof parsed.createdAt === "string") {
      return {
        slug: parsed.slug,
        branch: parsed.branch ?? null,
        isPrimary: parsed.isPrimary ?? true,
        source: parsed.source ?? "fallback",
        createdAt: parsed.createdAt,
      };
    }
  } catch {
    // fall through to re-init on malformed state
  }
  return null;
}

/**
 * Read `.vean/worktree.json`, computing + persisting the identity if it is absent
 * (creating `.vean/` if needed, like {@link openStateDb}). A present, well-formed
 * file is reused verbatim so the human-facing slug stays stable across a session.
 */
export function readOrInitWorktreeState(repo: string = process.cwd()): WorktreeState {
  const path = worktreeStatePath(repo);
  const existing = readWorktreeState(path);
  if (existing) return existing;

  const identity = resolveWorktreeSlug(repo);
  const state: WorktreeState = { ...identity, createdAt: new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}
