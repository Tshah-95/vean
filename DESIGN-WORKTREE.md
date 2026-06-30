# Worktree-native vean — design

vean should be **comfortable being checked out many times at once.** Today that
already happens — Claude Code task chips spin off a fresh `git worktree` per
spun-off task (there are usually a couple live under `.claude/worktrees/`), and
the human runs parallel feature branches by hand. This document pins down what
"natively worktree-oriented" means, what shared resources need care, and the
minimal set of changes that make a fresh worktree immediately usable — without
the heavyweight per-worktree provisioning a web app (env files, a dedicated DB,
allocated service ports, auth sandboxes) would need.

The headline: **vean is already ~80% worktree-safe by accident of its own
constraints.** The core is file-in/file-out, no network, no secrets (Hard
boundary #3); `.vean/` is gitignored and cwd-anchored so every worktree gets its
own state automatically; and the drive harness already allocates ephemeral
ports. What's left is a small, enumerable set of shared singletons and one
genuine product decision.

## §1 — Two layers of "worktree" (scope this doc)

Two different concepts wear the same word. They have different owners, different
shared resources, and very different difficulty.

| | Layer A — **codebase worktrees** | Layer B — **document/variant worktrees** |
|---|---|---|
| What is branched | the **vean source** | a **project** (one edit, many variants) |
| Why | develop isolated features in parallel; task chips | try a tighter cut / alternate grade, diff, keep or discard |
| Unit of change | TypeScript / config commits | edit-algebra ops on a `.mlt` / `.tsx` document |
| Shared resources | the `vean` bin, ports, browser-session identity, `~/.vean/` | media pool, render/proxy cache, the project's own history |
| Difficulty | small, enumerable (this doc, §4) | a research problem — "git for video" (this doc, §5) |
| Status | **design + build now** | **sketch now, build later** (orthogonal; ROADMAP Move 4) |

This document **specifies Layer A** and **sketches Layer B**. Layer B is
explicitly deferred — but §3's invariants are written to serve both, so Layer A
doesn't paint Layer B into a corner.

## §2 — The shared-resource ledger

Every resource a second concurrent checkout could touch, classified. Grounded in
the current source so the design tracks reality, not intention.

### Already isolated (no work needed — keep it this way)

| Resource | Why it's safe | Anchor |
|---|---|---|
| `.vean/vean.db` | gitignored + `process.cwd()`-anchored → one DB per worktree | `src/state/db.ts` `stateDir(repo = process.cwd())` |
| SQLite concurrency | WAL + `busy_timeout=5000` — safe even under accidental sharing on a local FS | `src/state/db.ts` `openStateDb` |
| Preview/viewer port | OS-assigned ephemeral (`listen(0)`) | `scripts/drive.ts` `freePort()` |
| Drive session state | `.vean/drive/<name>.json` anchored to the script's own checkout, exclusive spawn-lock + reap log | `scripts/drive.ts` |
| LSP / MCP | stdio, launched from `${CLAUDE_PLUGIN_ROOT}`, one process per session, no ports | `.lsp.json`, `.mcp.json` |
| Settings | project-scoped `app_meta` rows in `.vean/vean.db` | `src/state/settingsStore.ts` |
| `.vean/cache/*` (render, proxy, remotion) | per-worktree; proxy is content-addressed so a shared source renders once | `src/preview/server.ts`, `src/preview/proxy.ts` |

### Sharp edges (Layer A fixes these — §4)

| Resource | Problem | Anchor |
|---|---|---|
| The `vean` bin | `setup:cli` = `bun link` → one global symlink, last-writer-wins. Silent **version skew**: bare `vean` runs the canonical tree's code against another worktree's cwd. | `package.json` `"setup:cli": "bun link"` |
| Driver identity | `agent-browser --session` and drive `--name` both default to the literal `"vean"`. agent-browser runs one global daemon with per-session profiles → two worktrees driving `--session vean` share the **same browser tab**; the second `open` navigates away from the first. This is the "which version am I viewing?" problem. | `scripts/drive.ts` (`name = flags.name ?? "vean"`); `.agents/skills/drive/SKILL.md` |
| Fixed default ports | `preview.serve` defaults to **5174**; viewer Vite dev 5173; Remotion studio 3000. Only bite when run *directly* (the drive path is already ephemeral), but a collision reads as a confusing "address in use". | `src/actions/registry.ts` `port: …default(5174)`; `src/cli.ts` |
| `~/.vean/projects.json` | A **global** mutable singleton in `$HOME`: the active-project pointer. Resolution prefers `--project` → `VEAN_PROJECT` → cwd walk-up → this fallback, so it only bites when you rely on the implicit "current project," but it is last-writer-wins across every worktree. | project context resolver |
| Hardcoded repo path | `/Users/tejas/Github/vean` is baked into `tests/policy.test.ts` (will **fail** from a worktree) and README/AGENTS (cosmetic). | `tests/policy.test.ts` |

### Needs policy, not a quick fix (§3 invariants + §5)

| Resource | Note |
|---|---|
| Absolute paths in the DB (`media_roots.path`, `media_assets.path`, `route_aliases.target`) | Harmless while each worktree has its own DB. Becomes load-bearing the moment a project (or its DB) is **copied** across worktrees, or a shared catalog is introduced. The DB is therefore **never copied** (§4.4a); §3 invariant 1 keeps it safe by construction (media roots must point at a stable external location, never inside a project); the committed-config Layer B foundation (§5) removes the absolute paths from copyable state entirely. |
| Job lease `locked_by` | Caller-supplied, no built-in per-process identity. A non-issue with per-worktree DBs; becomes real only if a **shared** job queue is ever introduced. Then `locked_by` must encode worktree + pid. |

## §3 — Invariants (load-bearing for both layers)

These are the rules that keep both worktree layers tractable. They mostly
encode how every professional NLE already works.

1. **Media is shared, immutable, external, and referenced — never copied, never
   transformed.** This is non-destructive editing, the universal NLE model
   (Premiere, DaVinci Resolve, Final Cut, Avid): source media is never mutated;
   the project holds *references* (path or content-hash) plus edit decisions
   (in/out, effects, keyframes) — the lineage of the tape-era EDL. Proxies and
   transcodes are *derived cache*, never replacements. Consequence: media lives
   **outside** any project (vean's convention is `~/Github/media`), is addressed
   by a stable root or `media:` route alias, and is **safe to share across every
   worktree** with zero copying. A media root must therefore **never** point
   inside a project/worktree directory; that is the single rule that makes the
   absolute-path storage in `.vean/vean.db` safe.

2. **A project is copyable text.** The `.mlt` placement spine, Remotion `.tsx`
   producers, and asset *references* are all text. A project can be copied (or
   git-worktree'd, Layer B) into an isolated tree and edited freely, because the
   bytes that define the edit carry no machine-specific absolute state beyond
   media references — which resolve against the shared external pool (invariant
   1).

3. **`.vean/` is per-worktree, regenerable, and never carried.** It is cache and
   coordination (DB, drive sessions, render/proxy cache), rebuildable from
   project + media. A fresh worktree starts with no `.vean/` and initializes its
   own. Copying `.vean/vean.db` between worktrees is forbidden — it would drag an
   absolute-path media catalog into a tree that may not share it.

4. **Identity is a per-worktree slug; ports are always ephemeral.** Each worktree
   resolves a stable slug once (§4.1). Servers bind `:0` and advertise the chosen
   port through a session file — never a fixed port the agent or human has to
   remember. "Which version am I viewing?" is answered by the slug + the session
   file, not by port arithmetic.

5. **The global `vean` bin belongs to the canonical tree only.** Inside a
   worktree, invoke through `bun run …` / `bun src/cli.ts …`, which is always
   package-relative and therefore worktree-correct. `bun link` is a one-time
   convenience for the primary checkout, not a per-worktree step.

## §4 — Layer A design: codebase worktrees (build now)

Goal: a freshly created worktree (task chip or manual) is **immediately
drivable and diagnosable**, with an identity that lets a human and an
agent-browser session each know exactly which tree they are looking at, and with
no risk of clobbering the canonical install.

### §4.1 Worktree identity (the slug)

Resolve a stable, filesystem-safe slug for the current checkout, in order:

1. explicit `VEAN_WORKTREE` env override, else
2. the worktree's directory basename (`busy-moore-4604ba`) when inside
   `.../.claude/worktrees/<name>` or any non-primary worktree, else
3. the current branch (`git branch --show-current`, sanitized), else
4. `"main"` / `"primary"` for the canonical checkout.

Persist it to `.vean/worktree.json` (`{ slug, createdAt, source }`) so it is
cheap and deterministic to read, and so the human-facing name is stable across a
session. The slug becomes the **default** `--name` for drive and the default
`--session` for agent-browser, replacing the hardcoded `"vean"`.

### §4.2 Ports — ephemeral by default everywhere

The drive path is already ephemeral. Close the remaining gaps so a *direct*
invocation can't collide either:

- `preview.serve` default port becomes **0** (OS-assigned) instead of `5174`,
  with `--port` / `VEAN_PREVIEW_PORT` honored when a stable port is wanted (the
  Tauri shell can keep requesting a fixed one for its WKWebView if it prefers).
- `vean whereami` / `drive status` echo the resolved port so it's discoverable.

### §4.3 The bin — canonical-only

No per-worktree `bun link`. Document (and enforce via doctor, §4.5) that:

- the canonical checkout owns `~/.bun/bin/vean`;
- inside a worktree, agents and scripts use `bun run <script>` (already
  worktree-relative) or `bun src/cli.ts …`;
- `vean doctor` reports **which checkout** the on-PATH `vean` resolves to, and
  warns (not fails) when run from a worktree whose code differs from the linked
  one — turning silent version skew into a visible, expected condition.

### §4.4 `worktree-init` — the Conductor-style on-create hook

The piece modeled on conductor.build's "run a script on new worktree creation to
copy over the files git won't" (e.g. `.env.*`). vean's needs are lighter
(no secrets, no env), but the mechanism is the same.

**The primitive:** an idempotent `scripts/worktree-init.ts` (exposed as
`bun run worktree:init`) that, when run in a checkout:

1. resolves and writes the slug (§4.1);
2. copies the small set of **gitignored-but-needed carry-over files** from the
   primary checkout — the explicit allowlist, not a blanket copy. Candidates:
   local agent/editor config that isn't secret, and (when Layer B lands) the
   selected project documents. **Never** `.vean/vean.db` (invariant 3),
   **never** media (invariant 1), **never** secrets;
3. ensures `.vean/` is initialized fresh (`state:init`) and, if a project is
   designated, registers its media roots **by reference** at the shared external
   location rather than copying the catalog;
4. **bootstraps dependencies** — `git worktree add` does not carry `node_modules`
   (gitignored), and any command that loads the action registry (whereami,
   `drive up`, diagnose) throws without it (observed: a depless worktree fails on
   `z.ZodNativeEnum` instanceof). So when `node_modules` is absent, run
   `bun install` (the conductor "install on create" step). Gated on absence — a
   plain branch switch is a no-op — opt out with `VEAN_WORKTREE_INIT_INSTALL=0`,
   best-effort (a failure is reported, never thrown);
5. is safe to run twice (every step checks-then-acts).

**The trigger** — tool-agnostic, so it fires for Claude chips, Conductor, *and*
manual `git worktree add`:

- Primary: a committed `.githooks/post-checkout` that calls
  `bun run worktree:init`, activated once by setup via
  `git config core.hooksPath .githooks`. `git worktree add` runs `post-checkout`
  in the new tree, so the hook fires exactly when a worktree is born. Because
  worktrees share the common `.git`, `core.hooksPath` is set once and covers all
  future worktrees.
- Optional belt-and-suspenders for the Claude-heavy workflow: a `SessionStart`
  hook in `.claude/settings.json` that runs the same idempotent script — harmless
  if `post-checkout` already ran.
- Manual fallback: `bun run worktree:init`, and `vean doctor` offers to run it
  when it detects an uninitialized worktree.

### §4.4a — The `.vean/vean.db` question: never copy

The single most important clarification for `worktree-init`. There is **no
`timeline` / `clips` / `tracks` / `keyframes` table** — the edit that *is* the
project lives entirely in the `.mlt`/`.tsx` files on disk. The DB is cache +
coordination only (the Local state contract in `AGENTS.md`), so copying it never
preserves "the project"; it only drags machine-specific absolute paths and stale
jobs into a tree that shouldn't have them. Per-table verdict:

| Table | Holds | Copy on worktree create? |
|---|---|---|
| `projects` | id, `root_path` (absolute), title | **No — wrong.** `root_path` points at the source tree (unique-indexed); re-derive via `project init` → the new tree's own path. |
| `jobs` | queued/running jobs + leases | **Never.** Ephemeral; copying = phantom running jobs leased by a dead worker. |
| `media_assets` | `path` (absolute), `relative_path`, probe cache | **No — regenerate** via `media scan`; copied mtimes are instantly stale. |
| `media_roots` | `path` (absolute), role, policy | **No verbatim.** Config, but absolute + `project_id`-bound; reconstruct (Layer B). |
| `route_aliases` | `alias` → `target` | **No verbatim.** Genuine config; the one thing worth reconstructing (Layer B). |
| `app_meta` / `setup_choices` | settings overrides, schema version, setup answers | **No.** Small config; defaults suffice or reconstruct. No edit data. |

**Therefore `worktree-init` copies no DB and seeds no catalog for Layer A.** The
two real sub-cases:

1. **Codebase worktree, no project** (IR/ops/diagnostics/test work — most chips):
   needs no DB. `state:init` lazily creates an empty `.vean` only if an action
   touches it. Nothing to seed.
2. **Codebase worktree that drives the app:** point `drive up --project <shared
   canonical project>`. Drive spawns the preview with `cwd: project` +
   `--repo project`, so it reads the *project's own* (shared, WAL, read-mostly)
   `vean.db` and `.mlt`, while the code worktree contributes only the code under
   test and its per-worktree `.vean/drive/<slug>.json`. The DB is shared by
   reference, never copied. (Two worktrees previewing the same project may both
   write `<project>/.vean/cache/render/…`; renders are input-addressed, so a
   double-write is wasteful, not corrupting. Full per-variant isolation is
   Layer B.)

So `worktree-init`'s only DB-adjacent jobs are: stamp the slug, and optionally
record a default `--project` pointer so `drive up` in this tree knows which
shared project to preview. The heavyweight seed — reconstruct `media_roots` /
`route_aliases`, regenerate the catalog, drop `jobs` — is **Layer B**, and the
clean enabler there is to move durable config (roots, aliases, settings) into a
small **committed** project-config file, making the DB 100% regenerable cache and
dissolving the absolute-path problem (§5).

### §4.5 `whereami` / doctor surfacing

A single command answers "where am I, and what am I driving?":

```
vean whereami            # human
vean whereami --json     # agents / agent-browser drivers
```

emitting `{ worktreePath, slug, branch, isPrimary, stateDbPath, driveSession?:
{ name, url, port, status }, veanBinResolvesTo }`. Fold the worktree facts into
`vean doctor` so the existing readiness gate also reports worktree health (slug
present, not accidentally sharing the canonical bin, `.vean/` initialized).

### §4.6 Cleanup

`drive down --all` already reaps every sidecar. Add: removing a worktree should
leave nothing behind on the machine — since all state is inside the worktree's
own `.vean/` and ports are ephemeral, `git worktree remove` is sufficient; the
only global touch-point is `~/.vean/projects.json`, which should prune entries
whose `rootPath` no longer exists (a cheap GC on read).

### §4.7 The minimal change set

1. `src/state/worktree.ts` — slug resolution + `.vean/worktree.json` (§4.1).
2. drive + the `drive` skill default `--name`/`--session` to the slug (§4.1).
3. `preview.serve` default port → 0; honor `VEAN_PREVIEW_PORT` (§4.2).
4. `vean whereami` action + `doctor` worktree section (§4.5).
5. `scripts/worktree-init.ts` + `.githooks/post-checkout` + `core.hooksPath`
   wiring in setup (§4.4). Copies **no** DB and seeds no catalog (§4.4a); stamps
   the slug and an optional default `--project` pointer so `drive up` knows which
   shared project to preview.
6. De-hardcode `/Users/tejas/Github/vean` in `tests/policy.test.ts` (derive from
   the test's own location); leave docs as a follow-up sweep.
7. `~/.vean/projects.json` GC-on-read for dead `rootPath`s (§4.6).
8. **Gate hygiene** — nested task-chip worktrees live under `.claude/worktrees/`
   (gitignored) and carry a full copy of `tests/` + `src/`. The primary checkout's
   `vitest` and `biome` glob into them by default (vitest collected ~3.5k tests
   from sibling branches; biome checked 606 files and failed on their drift). Root
   `vitest.config.ts` excludes `**/.claude/worktrees/**`; `biome.json` `files.ignore`
   adds `.claude/worktrees`. (`tsc` is already safe — its `include` is the explicit
   `src`/`tests`/`scripts`, which doesn't recurse into `.claude`.) Without this a
   sibling worktree's unrelated state fails the parent's gate.

None of these require a Layer B decision; all are unambiguous.

## §5 — Layer B sketch: document/variant worktrees (future, orthogonal)

The eventual prize: branch a *project*, let an agent (or the human) explore a
tighter cut / alternate grade / different music bed in isolation, render, diff,
and keep or discard — the same way code branches work. §3's invariants already
make the cheap version possible: because media is shared/external (1) and a
project is copyable text (2), a variant is just a copy (or worktree) of the
project documents pointing at the same media pool, with its own `.vean/` cache.

What makes this a research problem, not a §4-style change, is **versioning the
edit itself** — "git for video":

- **Granularity.** Code diffs over lines; an edit diffs over *operations on a
  timeline* (ripple-trim clip X by 6 frames; retime keyframe group Y). A
  line-diff of `.mlt` XML is technically possible but semantically poor — it
  won't say "these two variants disagree about where the dissolve starts." The
  edit algebra (`src/ops`) is the natural diff/merge unit, not the serialized
  bytes.
- **Merge / rebase / conflict.** Two variants that both trim the same clip
  conflict in a way a textual 3-way merge can't reconcile sensibly. The open
  question — and the likely reason no NLE ships this — is whether *operation*
  conflicts are tractable: detect that variant A and variant B both mutated clip
  `uuid` in overlapping ways, and surface it as a structured conflict an agent
  can resolve the same way agents already resolve code-merge conflicts. That may
  be more approachable than it first looks precisely because vean has a typed op
  log and stable producer UUIDs (the identity invariant), not just XML.
- **History as first-class.** "Akin to git for every transformation" implies an
  op-log/event-sourced project history that variants fork from and that diff/
  merge operate over — distinct from, and richer than, the codebase's git.

This is deliberately **not** designed here. It is orthogonal to Layer A, it lands
no earlier than the local app's exploration UI (ROADMAP Move 4 already lists a
"Git-worktree-per-exploration model wired into project view"), and its core
question (op-level diff/merge/conflict) deserves its own design pass. What Layer A
must do for it: **don't foreclose it** — keep media external/shared, keep the op
log the source of truth, keep projects copyable text. Layer A honors all three.

## §6 — Non-goals (now)

- Op-level diff / merge / conflict resolution for project variants (§5).
- A shared cross-worktree job queue or catalog (would activate the §2 "needs
  policy" rows; not needed while DBs are per-worktree).
- Per-worktree `bun link` / multiple `vean` binaries on PATH (invariant 5).
- Any provisioning resembling a web app's per-worktree env/DB/service setup — the
  whole point is that vean's constraints make that unnecessary.

## §7 — Verification

- Two worktrees run `drive up` concurrently → distinct slugs, distinct ephemeral
  ports, distinct `agent-browser --session`s; each `whereami --json` reports its
  own tree and URL; driving one never navigates the other's tab.
- A freshly `git worktree add`ed tree is drivable with zero manual setup
  (post-checkout → `worktree:init` ran), and `vean doctor` is green from inside
  it without a `bun link`.
- `bun run test` passes from a non-primary worktree (the de-hardcoded
  `policy.test.ts`).
- `git worktree remove` leaves no live sidecars and no dangling
  `~/.vean/projects.json` entry.
