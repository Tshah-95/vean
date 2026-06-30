#!/usr/bin/env bun
// The worktree-init primitive (DESIGN-WORKTREE.md §4.4 / §4.4a / §4.7 item 5).
//
// Modeled on conductor.build's "run a script on new worktree creation to copy the
// files git won't track" hook — but vean's needs are far lighter: no secrets, no
// env files, no per-worktree DB. A freshly born worktree (Claude task chip,
// Conductor, or a manual `git worktree add`) runs this once, via the committed
// `.githooks/post-checkout` hook, to become immediately drivable + diagnosable.
//
// What it does (every step is CHECK-THEN-ACT, so it is safe to run twice):
//   1. Resolves + persists this checkout's slug to `.vean/worktree.json`
//      (the §4.1 identity primitive — the default drive `--name` / agent-browser
//      `--session`, replacing the hardcoded "vean").
//   2. Optionally records a default `--project` pointer (from `--project <path>`)
//      to `.vean/worktree-project` so `drive up` in this tree knows which SHARED
//      project to preview — by reference, never a copy.
//   3. Copies ONLY an explicit, conservative allowlist of gitignored-but-needed
//      carry-over files from the PRIMARY checkout, if they exist.
//
// What it deliberately does NOT do (DESIGN-WORKTREE.md §4.4a — load-bearing):
//   - NEVER copies `.vean/vean.db`. There is no timeline/clips/tracks table; the
//     edit that IS the project lives in `.mlt`/`.tsx` files on disk. Copying the
//     DB only drags machine-specific absolute paths + stale jobs into a tree that
//     shouldn't have them.
//   - NEVER copies media (invariant 1 — media is shared, external, referenced).
//   - NEVER copies secrets, `node_modules/`, or `projects/` deliverables.
//   - NEVER runs `bun link` / `git config` / any global-state mutation. The global
//     `vean` bin belongs to the canonical tree only (§4.3); worktrees use `bun run`.
//
// Usage:
//   bun scripts/worktree-init.ts [--project <path>] [--quiet]
//   bun run worktree:init        # the package-script alias the post-checkout hook calls

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { type WorktreeState, readOrInitWorktreeState } from "../src/state/worktree";

/** This checkout's root (the dir holding `scripts/`). */
const REPO = resolve(import.meta.dir, "..");

/** Sibling marker to `.vean/worktree.json`: a single line with the default
 *  `--project` pointer for `drive up`. Kept OUT of worktree.json so this slice
 *  never reshapes the slug primitive's persisted JSON (owned by src/state/worktree.ts). */
const PROJECT_MARKER = resolve(REPO, ".vean", "worktree-project");

/**
 * The explicit carry-over allowlist (the conductor `.env.*` analogue). Each entry
 * is copied from the PRIMARY checkout into this worktree IFF it exists in the
 * primary AND is absent here — gitignored-but-needed local config that is NOT
 * secret and NOT regenerable from project + media.
 *
 * Intentionally conservative: vean has no secrets and `.vean/` is per-worktree
 * regenerable cache (invariant 3), so the only real candidates are local,
 * non-secret editor/agent config a worktree should inherit. Extend this list as
 * concrete needs appear — but NEVER add `.vean/`, `node_modules/`, media, or any
 * secret-bearing path (see the §4.4a "never copy" table).
 */
const CARRY_OVER_ALLOWLIST: readonly string[] = [".claude/settings.local.json"];

type InitResult = {
  slug: string;
  source: WorktreeState["source"];
  isPrimary: boolean;
  worktreeStateWritten: boolean;
  projectPointer: string | null;
  copied: string[];
  skipped: string[];
};

/** Run a git command in `repo`, returning trimmed stdout or null on any failure. */
function git(repo: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0 || result.error) return null;
  const out = result.stdout.trim();
  return out.length > 0 ? out : null;
}

/**
 * Locate the PRIMARY checkout's toplevel — the source for carry-over files.
 * `git worktree list --porcelain` lists every linked tree; the FIRST `worktree`
 * entry is always the primary (the dir whose `.git` is a real directory). Returns
 * null outside a git repo, in which case there is nothing to carry over.
 */
function primaryToplevel(repo: string): string | null {
  const listing = git(repo, ["worktree", "list", "--porcelain"]);
  if (!listing) return null;
  for (const line of listing.split("\n")) {
    if (line.startsWith("worktree ")) return line.slice("worktree ".length).trim();
  }
  return null;
}

/** Parse `--project <path>` / `--quiet` with the same shape drive.ts uses. */
function parseFlags(argv: string[]): { project?: string; quiet: boolean } {
  const out: { project?: string; quiet: boolean } = { quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--quiet") {
      out.quiet = true;
    } else if (a === "--project") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out.project = next;
        i++;
      }
    }
  }
  return out;
}

function run(argv: string[]): InitResult {
  const flags = parseFlags(argv);

  // Step 1 — resolve + persist the slug. readOrInitWorktreeState reuses an existing
  // well-formed `.vean/worktree.json` verbatim (stable across a session) and only
  // writes when absent, so this is idempotent by construction.
  const stateExisted = existsSync(resolve(REPO, ".vean", "worktree.json"));
  const state = readOrInitWorktreeState(REPO);

  // Step 2 — optionally record the default `--project` pointer (check-then-act:
  // only (re)write when a project was passed; an existing marker is left alone
  // otherwise so re-runs don't clobber a previously chosen project).
  let projectPointer: string | null = null;
  if (flags.project) {
    const abs = isAbsolute(flags.project) ? flags.project : resolve(process.cwd(), flags.project);
    mkdirSync(dirname(PROJECT_MARKER), { recursive: true });
    writeFileSync(PROJECT_MARKER, `${abs}\n`);
    projectPointer = abs;
  }

  // Step 3 — copy the carry-over allowlist from the PRIMARY checkout, if any.
  // Skipped entirely when this IS the primary, or when no primary is found.
  const copied: string[] = [];
  const skipped: string[] = [];
  const primary = state.isPrimary ? null : primaryToplevel(REPO);
  if (primary && resolve(primary) !== REPO) {
    for (const rel of CARRY_OVER_ALLOWLIST) {
      const src = resolve(primary, rel);
      const dest = resolve(REPO, rel);
      if (!existsSync(src)) {
        skipped.push(`${rel} (absent in primary)`);
        continue;
      }
      if (existsSync(dest)) {
        skipped.push(`${rel} (already present)`);
        continue;
      }
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, dest);
      copied.push(rel);
    }
  }

  return {
    slug: state.slug,
    source: state.source,
    isPrimary: state.isPrimary,
    worktreeStateWritten: !stateExisted,
    projectPointer,
    copied,
    skipped,
  };
}

function report(result: InitResult): void {
  const lines: string[] = [];
  lines.push(
    `worktree-init: slug "${result.slug}" (${result.source})${result.isPrimary ? " — primary checkout" : ""}`,
  );
  lines.push(
    result.worktreeStateWritten
      ? "  wrote .vean/worktree.json"
      : "  .vean/worktree.json already present (reused)",
  );
  if (result.projectPointer) {
    lines.push(`  default --project → ${result.projectPointer}`);
  }
  if (result.copied.length > 0) {
    lines.push(`  carried over: ${result.copied.join(", ")}`);
  }
  if (result.copied.length === 0 && !result.isPrimary) {
    lines.push("  carried over: nothing (allowlist empty or files absent)");
  }
  lines.push("  (no DB, no media, no secrets copied — §4.4a)");
  process.stderr.write(`${lines.join("\n")}\n`);
}

const result = run(process.argv.slice(2));
if (!process.argv.includes("--quiet")) report(result);
// JSON on stdout for chainability / scripted callers (drive, doctor).
process.stdout.write(`${JSON.stringify(result)}\n`);
