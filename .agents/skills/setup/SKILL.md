---
name: setup
description: Set up or verify a fresh vean clone for local development and agent use. Use when the user asks to bootstrap, install, doctor, verify, configure Claude Code, configure Codex, enable the vean LSP/MCP plugin, hoist skills, or make a new consumer machine/repo checkout ready to edit .mlt timelines.
---

# Set up vean

Use this skill to bring a fresh clone to a working state for humans and agents.
Keep host setup here; keep timeline editing behavior in the `editing` skill.

## First pass

1. Read `AGENTS.md`, `README.md`, and `package.json`.
2. Run:

   ```bash
   bun install
   bun run project:init
   bun run doctor
   ```

3. Treat `doctor` as the source of truth for setup state. It checks system deps,
   repo deps, local `.vean/vean.db` state, Claude Code plugin files, Codex
   resolver wiring, skill shims, and, depending on `--surface`, `vean` CLI
   registration, `vean-lsp` startup, and/or `vean-mcp` startup.
4. Fix every concrete failed check that is repo-local. Ask before host/user-level
   changes, global installs, package manager installs, or shell profile edits.
5. Re-run `bun run doctor` after changes.

For a consumer project outside the VEAN checkout, pass it explicitly:
`vean doctor --repo /path/to/project`. Doctor audits `.vean` state and project
routes at that path while resolving the CLI, LSP/MCP servers, skills, package
metadata, and frontend runtimes from the installed VEAN checkout. A consumer is
not expected to contain VEAN's own `src/`, `viewer/`, or skills.

## Preference survey

When the host supports structured user questions (`askuserquestion` in Claude
Code, `request_user_input` in Codex plan mode), ask a short setup survey before
making preference-dependent changes. Otherwise ask the same questions plainly.

- **Claude Code plugin**: enable/use this checkout via
  `claude --plugin-dir /path/to/vean`?
- **Primary tool surface**: CLI+LSP, CLI only, MCP+LSP, or all? CLI+LSP is the
  preferred setup: CLI is the feature-complete command surface, LSP is ambient
  diagnostics/navigation, and MCP is an optional adapter for hosts that benefit
  from callable tools.
- **Codex access**: keep repo-local resolver only, or also hoist skills into the
  user's shared skill directory?
- **System deps**: install missing `melt`/`ffmpeg` automatically when a supported
  package manager is present, or only report commands?
- **Local state**: initialize repo-local `.vean/vean.db` now? Default yes; it is
  gitignored and holds setup choices, jobs, project metadata, and future UI
  coordination state.
- **Native Mac app**: verify scaffold only, or also build the native `.app`?
  Native build requires Rust/Cargo and takes longer; scaffold verification is
  enough unless the user is working on the app.
- **Media routing**: register a media root now? Default no unless the user
  names a folder. If yes, prefer role `raw` first and let the setup flow create
  the `media:raw` route alias.

Default choices when the user does not answer and continuing is safe:

- Set up repo-local Claude Code plugin files and verify them.
- Use CLI+LSP as the primary tool surface, but ask before registering the CLI on
  the user's PATH.
- Initialize `.vean/vean.db` with `bun run project:init`.
- Keep skills repo-local unless the user asks for user-level hoisting.
- Report system install commands instead of running global package-manager writes.

## Host setup map

- **Local state**: run `bun run project:init` to create `.vean/vean.db`, apply
  Drizzle migrations, and register the repo root in the `projects` table. Use
  `vean state status` to inspect without mutating after CLI registration.
  `.vean/` must stay gitignored.
- **Media routing**: after local state exists, add a media root with
  `vean media root add <path> --role raw --json`, scan it with
  `vean media scan --json`, and verify the generated route with
  `vean route resolve media:raw --json`. This only catalogs lightweight
  path/kind/size/mtime metadata; transcription, labels, proxies, and
  model-backed inference are later action families.
- **LSP only**: verify with `bun run doctor --surface lsp`. This starts
  `vean-lsp` unless `--no-probe` is passed. This is the safe first-pass check
  before CLI PATH registration.
- **CLI+LSP primary**: ask before registering a user PATH entry, then run
  `bun run setup:cli` from the repo root. That delegates to `bun link`, using the
  package `bin.vean` entry so future calls can use `vean ...` instead of an
  absolute path. Ensure `~/.bun/bin` is on PATH for login shells, then verify
  with `vean doctor --surface cli-lsp`, `vean discover --json`, and
  `vean timeline ops list --json`.
- **CLI only**: same CLI registration branch, then verify with
  `bun run doctor --surface cli`.
- **MCP+LSP**: verify with `bun run doctor --surface mcp-lsp`. Use this when the
  chosen host should call vean through MCP tools in addition to receiving ambient
  LSP diagnostics.
- **All surfaces**: run the CLI, LSP, and MCP setup branches, then verify with
  `bun run doctor --surface all`.
- **Claude Code**: plugin root is the repo itself. `.lsp.json` registers
  `vean-lsp`; `.mcp.json` registers `vean-mcp`; `skills/setup` and
  `skills/editing` are plugin skills. Verify the chosen surface, e.g. `bun run
  doctor --host claude-code --surface cli-lsp` for CLI+LSP or `bun run doctor
  --host claude-code --surface mcp-lsp` when MCP is enabled. `claude plugin
  validate` may warn that root `CLAUDE.md` is not loaded as plugin context; that
  is expected because plugin context is shipped via `skills/*`, while `CLAUDE.md`
  remains the normal repo/project shim.
- **Codex**: `AGENTS.md` is the resolver. It points to
  `.agents/skills/setup/SKILL.md` and `.agents/skills/editing/SKILL.md`. Verify
  with `bun run doctor --host codex --surface cli-lsp` after CLI registration, or
  `bun run doctor --host codex --surface lsp` before CLI registration. Use
  `--no-probe` only when you want a fast resolver/symlink check without starting
  stdio servers.
- **Shared skills**: `.agents/skills/*` is the repo-local source of truth.
  `.claude/skills/*` and `skills/*` should be symlinks back to `.agents/skills/*`.
- **Native Mac app**: `bun run app:doctor` verifies the scaffold. If Rust/Cargo
  is installed and the user wants the app build gate, run
  `bun run app:doctor -- --native`; it builds the local macOS `.app` bundle.

## Worktree-native setup

vean is checked out many times at once (Claude task chips spin off a `git
worktree` per task; humans run parallel feature branches). One setup step makes
every present and future worktree self-initializing. See `DESIGN-WORKTREE.md`
§4.3–§4.4 for the full design.

- **Activate the on-create hook once per machine.** From the canonical checkout,
  run this single command:

  ```bash
  git config core.hooksPath .githooks
  ```

  All worktrees share the common `.git`, so `core.hooksPath` is set **once** and
  covers every worktree created afterward. The committed `.githooks/post-checkout`
  hook fires whenever `git worktree add` creates a tree (and on branch checkouts),
  and runs `bun run worktree:init` best-effort — it never fails a checkout.

- **What `worktree:init` does** (idempotent — safe to run twice):
  1. resolves + persists this checkout's slug to `.vean/worktree.json` (the
     identity used as the default drive `--name` / agent-browser `--session`);
  2. optionally records a default `--project` pointer (`bun run worktree:init
     --project <path>`) to `.vean/worktree-project` so `drive up` in this tree
     knows which **shared** project to preview — by reference, never a copy;
  3. copies only a small, explicit allowlist of gitignored-but-needed local
     config from the primary checkout (the conductor `.env.*` analogue).

- **What `worktree:init` does NOT do** (DESIGN-WORKTREE.md §4.4a, load-bearing):
  it **never** copies `.vean/vean.db` (there is no timeline/clips table — the edit
  lives in `.mlt`/`.tsx` files; copying the DB only drags absolute paths and stale
  jobs across trees), **never** copies media (shared/external/referenced), and
  **never** copies secrets, `node_modules/`, or `projects/` deliverables. It also
  never runs `bun link` or `git config` — no global-state mutation.

- **The `vean` bin belongs to the canonical checkout only.** Do not `bun link`
  inside a worktree. The canonical tree owns `~/.bun/bin/vean`; inside a worktree,
  agents and scripts invoke through `bun run <script>` (already worktree-relative)
  or `bun src/cli.ts …`. Running `worktree:init` manually is the fallback when the
  hook did not fire: `bun run worktree:init`.

## CLI provenance

The main CLI is `src/cli.ts` and uses Commander for subcommands, help, and
argument parsing. Keep new first-class commands there. Legacy one-command scripts
may remain as thin compatibility wrappers while the CLI matures.

## Verification

Minimum setup gate:

```bash
bun run project:init
bun run doctor
bun run typecheck
bun run lint
bun run test
```

State gate:

```bash
bun run project:init
vean state status
vean jobs list
vean discover --json
vean timeline ops list --json
```

Surface-specific gates:

```bash
bun run doctor --surface mcp
bun run doctor --surface lsp
bun run doctor --surface cli-lsp
bun run doctor --surface mcp-lsp
bun run doctor --surface cli
bun run doctor --surface all
```

Render-capable machines should also pass:

```bash
bun run move2:e2e
```

Native-app machines should also pass:

```bash
bun run app:doctor -- --native
```
