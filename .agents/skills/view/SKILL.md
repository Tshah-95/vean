---
name: view
description: Bring up the vean app on THIS worktree's latest code so the human can click around — launch the native Tauri dev window (or a browser tab) on the current project or one you name, live-reloading this checkout's viewer. Use when the user says /view, "open the app", "let me see it", "bring up the editor", or wants to poke at a change themselves. This is the sanctioned foreground-window path — the human-facing sibling of the headless `drive` skill (which proves a change with a clip). Takes an optional project path/name/title to open something specific.
---

# view — bring up the app so the human can click around

The user invoked `/view` because they want a **window on their screen, now**,
running **this worktree's latest code**, so they can drive it themselves. Your job
is to launch it, tell them exactly what they're looking at (which branch, which
project), and then **step back** — you don't screenshot it, you don't drive it,
you hand them the app.

This is the deliberate opposite of `drive`:

| | `/view` (this skill) | `drive` |
|---|---|---|
| Audience | the **human** — they click | the **agent** — proof for chat |
| Surface | a real **foreground window** (native app or browser tab) | headless browser, no visible window |
| Output | "it's up, go poke at it" | a screenshot/`.webm` clip referenced back in chat |
| Screen takeover | **yes, on purpose** — that's the whole point | never |

`/view` **is** the explicit ask that the "no screen takeover" rule carves out an
exception for. Bringing the window forward is exactly what was requested.

## The one fact that makes this correct

`vean open` is worktree-sensitive **only if you run it from this checkout's
source**, not the global `vean` bin. `setup:cli` (`bun link`) points the bare
`vean` symlink at whichever tree linked last — so `vean open` may launch a
*different* worktree's code against this cwd (silent version skew; see
DESIGN-WORKTREE.md §"Sharp edges" / the `drive` skill). Always launch via:

```bash
bun src/cli.ts open …        # import.meta.dir → THIS worktree's src/ and app/
```

Two more traps this skill exists to avoid:

- **Bare `vean open` (no flags) opens the *installed* `/Applications/vean.app`** —
  a stale, already-shipped snapshot that ignores your uncommitted `viewer/`
  changes and isn't tied to this worktree. Wrong for "see my latest changes."
- The `--dev` path serves the **live HMR viewer from this checkout**; the shipped
  app always serves the built `viewer/dist`. For "the change I just made," you
  want `--dev` (native) or `--view browser` (the default browser path is also live
  HMR).

## Launch it (default: native Tauri dev window)

Resolve the project first (optional arg), then launch the native dev window on it.
**Run it backgrounded** — `tauri:dev` is a long-running process (dev server + the
window); backgrounding keeps its parent alive so the window persists, and frees
you to report back.

```bash
# Optional: which project? Bare = this worktree's current/active project.
#   Accepts a project id, its title (e.g. `open retire`), or a filesystem path.
bun src/cli.ts open [project] --dev
```

- Launch this with the harness running it **in the background** (`run_in_background:
  true`). It stays live as long as the app window is open.
- **First launch in a fresh worktree is slow** — `tauri:dev` compiles the Rust
  shell once (needs Rust/Cargo; `bun run app:doctor -- --native` verifies it).
  Subsequent launches are fast, and the viewer hot-reloads without a relaunch. Say
  so when you report, so the wait isn't a surprise.

### The instant alternative — a browser tab (identical UI, no Rust compile)

When they just want to *see the UI change* fast, or Rust/native isn't set up, the
browser view renders the **byte-identical viewer + backend** the native window
does, with live HMR, and comes up in seconds:

```bash
bun src/cli.ts open [project] --view browser   # opens the default browser at 127.0.0.1
```

The only thing the native window buys over this is a real app frame + the native
menus (File → Open Project…, Add Media Root…). If the user said "the app" /
"Tauri," default to `--dev`; if they said "just let me see it" or you know native
isn't built, offer/use `--view browser`.

## Report what they're looking at

The user needs to know the window reflects the **right** worktree and project —
that's the whole value of launching from this checkout. After launching, tell them:

```bash
git branch --show-current                 # which branch this worktree is on
bun scripts/drive.ts name                 # the worktree slug (same one drive uses)
bun src/cli.ts project current --json     # the resolved active project
```

Report a one-liner like: *"vean dev app coming up on branch `<branch>`
(worktree `<slug>`), project **<title>** — native window, first compile ~1–2 min,
then it's live. Poke around; the viewer hot-reloads as I push more changes."*

## "Something specific"

`open` selects a **project**; it does not deep-link to a clip or frame. So:

- A project **path / id / title** → pass it as `[project]`; the app boots straight
  at it.
- A **timeline / route reference** (`timeline:main`, a `.mlt`, `media:raw`) → open
  the project that *contains* it, then tell the user to navigate there in the UI
  (there's no frame-level deep-link arg yet — if that keeps coming up, that's a
  real feature request for the `open` action, not a workaround to hide here).

## Discipline

- **Launch, report, step back.** Don't drive, click, or screenshot the window you
  brought up for the human — that's `drive`'s job, and doing it would fight them
  for focus.
- **Run from this worktree via `bun src/cli.ts open`** — never the bare `vean`
  bin. The point of `/view` is "*this* checkout's code."
- **Background the launch** so the window survives and chat isn't blocked. It stays
  up until the user closes the app (native) or you stop the background task
  (browser: `bun run drive down --all` reaps preview sidecars, or kill the task).
- **Don't rebuild anything.** `/view` reflects your working tree live via HMR; no
  `app:build` / `viewer:build` needed to see a `viewer/` change.
