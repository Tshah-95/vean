---
name: drive
description: Prove a vean UI change in the real loopback editor without taking over the desktop. Use the packaged H04 Playwright/Chromium runner for completion evidence; use the optional agent-browser path only for ad-hoc headless inspection. Native shell UI is outside this unattended local harness.
---

# Drive the vean app (prove your UI changes)

The completion bar for a UI change is not "the code looks right" or "vitest passes"
— it is **you drove the running app, saw the change happen, and have a clip to
prove it.** This skill is that harness. Make a change → drive it → record proof →
reference the clip in chat. It should be near-trivial.

This is the visual sibling of the `editing` skill: `editing` mutates a `.mlt`
through the bridge tools and trusts the ambient LSP; `drive` opens the **product
UI** and verifies the change with eyes (screenshot/video) **and** structure
(DOM + `/api/diagnostics`).

## Canonical completion oracle

Run this for every material `viewer/` or preview-server change:

```bash
bun run drive verify
```

`drive verify` is the `bun run verify:browser` H04 oracle. It uses the
repository's pinned Playwright/Chromium dependency, always headless, and does not
depend on `agent-browser`. It creates an H02-isolated project, drives both the
Vite/HMR and freshly built production-dist paths, executes the six approved
browser scenarios, and rejects UI-only success unless the action envelope,
touched URI, independently reparsed persisted `.mlt`, diagnostics, and DOM all
agree. Structured evidence is written under `.vean/harness/browser-runs/`.

The manual `drive up` path below is for focused exploration and screenshots. It
does not replace `drive verify` in a completion claim.

## The one fact that makes this work

The Mac app is a **thin Tauri shell**. On launch it spawns `vean preview` (a Bun
HTTP server) on a loopback port and just **navigates its WKWebView to
`http://127.0.0.1:<port>/`** (see `app/src-tauri/src/lib.rs`). That server serves
the real `viewer/` app **and** the whole API (`/api/action`, `/api/apply-op`,
`/api/undo`, `/api/still`, `/api/render`, …). The viewer talks to the backend over
**same-origin HTTP** (`viewer/src/api.ts`) — **not** `window.__TAURI__.invoke`.

**Dev is the default — `drive up` serves your CURRENT viewer code, live.** `vean
preview` (and therefore `drive up`) now defaults to a **live Vite dev server with
HMR**, auto-started for you (no second terminal): edits under `viewer/` hot-reload
into the open page. This is exactly what you want when proving a UI change — the
proof reflects the code you just wrote, not a stale build. Pass **`--prod`** (`bun
run drive up --prod`) to instead serve the pre-built `viewer/dist` snapshot — the
same static viewer the production-mode Mac app renders (the WKWebView always runs
`--prod`). So the one nuance: `drive` shows your *latest* UI by default; the native
app window shows the *built* snapshot. Reach for `--prod` only when you need to
reproduce exactly what the production-mode app draws.

Consequence:

- You **cannot** attach a CDP/Chromium agent to the **native WKWebView window** —
  WKWebView speaks Apple's Web Inspector protocol, not CDP, and macOS ships no
  WebDriver for embedded WKWebView. (Don't waste time trying.)
- For ad-hoc inspection, point `agent-browser` (Playwright/Chromium) at the **same
  loopback URL** and you drive the byte-identical frontend + backend the WKWebView
  renders — headless, DOM-aware, scriptable, and **recordable**. Because vean's UI
  is HTTP-not-`invoke`, there is **zero Tauri-IPC mocking** to do (unusual; most
  Tauri apps must mock `window.__TAURI__`).

So "drive the app" == "drive `vean preview` in a real browser." A visible window
adds no authority and is forbidden for agent-driven verification.

## ⛔ HEADLESS IS NON-NEGOTIABLE — never open a visible window

A headed browser on macOS **steals the user's focus on every command** ("takes
over the computer every half-second"). This is a hard rule:

- **Never pass `--headed`.** Not for "debugging", not "just this once". If a
  screenshot/snapshot isn't enough to see what's wrong, take a `--full` screenshot
  or `get html`/`get styles` — do not open a window.
- Headless is enforced by config: this repo ships `agent-browser.json`
  (`{"headed": false}`) and there's a global `~/.agent-browser/config.json` too. Do
  not remove or override them.
- **The footgun that bit us:** `agent-browser` runs a **persistent daemon** that
  survives across invocations. If a *prior* session (in any repo) left the daemon
  running **headed**, your next `open` reattaches to that visible window and every
  command re-raises it. If you ever see a window, kill the daemon and restart:
  ```bash
  pkill -9 -f agent-browser            # nuke the daemon (and its browser)
  # then re-run; the config forces the fresh daemon headless
  ```
- The only legitimate `--headed` use anywhere is a human-driven OAuth login — which
  does not apply to vean's loopback viewer (no auth). So here: **never.**

## Optional ad-hoc harness (three commands)

The drive `--name` and the `agent-browser --session` **default to this
checkout's worktree slug** (e.g. `main` on the canonical tree,
`busy-moore-4604ba` in a `.claude/worktrees/<name>` chip). That's the one move
that lets two worktrees drive concurrently without colliding on one browser tab.
So capture the name once and pass it to every `agent-browser` call — never
hardcode `vean`:

```bash
# 1. Bring up a driveable instance against a project (free port, health-gated).
#    Idempotent: a second `up` reuses a healthy session. Project defaults to a
#    recorded pointer (worktree-init) if present, else cwd. DEV by default: a live
#    Vite/HMR viewer is auto-started (first-ever boot pre-bundles deps, so the
#    health wait is generous). Add `--prod` to serve the viewer/dist snapshot.
URL=$(bun run drive up --project /path/to/project)      # or: --timeline timeline:main ; or: --prod
SESSION=$(bun scripts/drive.ts name)   # = the worktree slug, unless you passed --name

# 2. Drive the REAL UI headless. Note: plain http:// (NOT https — vean's preview
#    is loopback http; this contradicts the generic agent-browser skill's warning).
agent-browser --headed false --session "$SESSION" open "$URL"   # --headed false: NEVER seize the screen
agent-browser --session "$SESSION" snapshot -i            # interactive elements → @refs
agent-browser --session "$SESSION" find text "Render" click
agent-browser --session "$SESSION" screenshot "$TMPDIR/drive-render-panel.png"

# 3. Tear down (kills the sidecar, clears the session). ALWAYS do this.
agent-browser --session "$SESSION" close   # close the browser session
bun run drive down                         # stop this session's preview sidecar
# bun run drive down --all                 # safety net: reap EVERY drive sidecar at once
```

`bun run drive` is `scripts/drive.ts` — it owns only the server lifecycle
(`up`/`down`/`url`/`status`/`name`) so you never hand-roll free-port +
wait-for-health + teardown. The session (pid/port/url) lives in the repo's
gitignored `.vean/drive/<name>.json`; the `--name` defaults to the **worktree
slug** (resolved from `VEAN_WORKTREE` / the linked-worktree dir / the branch /
`main`) and maps 1:1 to `agent-browser --session <name>`. `bun scripts/drive.ts
name` echoes the resolved name so the `--session` you drive with always matches
the one `up` created — that's why two worktrees don't fight over one tab. Pass an
explicit `--name` to override (it wins everywhere), and run several at once with
distinct `--name`s. `bun scripts/drive.ts status` reports which tree+session
you're looking at (`slug`, `name`, `port`, `url`).

Everything after `up` in this optional path is raw `agent-browser` (see its skill
for `snapshot`, `find`, `click`, `fill`, `get`, `is`, `diff`, `wait`, `network`,
and viewport commands). If it is not installed, skip ad-hoc driving and use the
packaged `drive verify` oracle; H04 loses no coverage.

## Recording video proof → reference it in chat

`agent-browser` records real `.webm` (it launches its own Chromium, so Playwright's
`recordVideo` works — the "Claude in Chrome" *extension* can only make GIFs):

```bash
# $SESSION = $(bun scripts/drive.ts name) — the worktree slug, as above.
agent-browser --session "$SESSION" record start "$TMPDIR/feat-blade.webm"
# … drive the feature: click, edit, observe …
agent-browser --session "$SESSION" record stop
```

Then surface it: use **SendUserFile** to deliver the `.webm` / `.png` with a caption
that says what changed and what the clip shows ("before/after the blade fix —
splitting the V1 clip at the playhead now updates the timeline strip live"). Save
clips to the session scratchpad / `$TMPDIR`, **not** into the repo — they're
ephemeral proof, not deliverables. Keep clips short and focused on the one change.

## Verify the change — eyes AND structure

Don't stop at "the screenshot looks right." A vision pass can miss a broken edit.
Cross-check the visual against the document:

- **Visual:** `screenshot` (or `--full`), `record`, or `diff screenshot --baseline`
  for before/after.
- **Structural (DOM):** `snapshot -i` / `get text @e` / `is visible @e` — assert the
  element actually changed (button enabled, value updated, row appeared).
- **Structural (document):** the preview server exposes the truth the UI is drawing
  from. Hit it directly to confirm the edit landed in the IR:
  ```bash
  curl -s "$URL/api/diagnostics" | python3 -m json.tool     # health + diagnostics
  curl -s "$URL/api/timeline"    | python3 -m json.tool     # parsed IR + fps/frames
  # or the CLI, project-rooted:  vean timeline diagnose --json
  ```
  If you drove an edit (apply-op / undo / save) through the UI, the API response and
  the screenshot must agree. If they disagree, the UI is lying — that's a bug to fix,
  and exactly the kind of thing this harness exists to catch.

## What you can't drive this way (and the workaround)

The loopback path drives the **web UI**. It does **not** reach the **native shell**:
the macOS menu gestures (`File → Open Project Folder…`, `Add Media Root…`), the
traffic-light buttons, and native file dialogs are Rust-side (`app/src-tauri/src/lib.rs`)
and never render in the webview.

- To verify their **effect**, call the underlying action directly — those gestures
  are thin wrappers over the registry: `vean action run media.root.add --input-json
  '{"path":"…"}' --json`, `vean action run project.current --json`, or POST
  `/api/action`. Same code path, no native dialog needed.
- The **native shell itself** (window activation, menus, file panels, and focus)
  is outside this unattended local harness. `/view` may open it only after an
  explicit human request; agents must not drive that host window or claim it as
  automated evidence. `app:doctor -- --native` checks build prerequisites only.

## When to escalate past this skill

This loopback-web-frontend path is the **default** because it's the lightest, is
DOM-aware, records video, and needs no app changes. Escalate only when the target
isn't the web UI:

| Need | Use | Notes |
|---|---|---|
| Prove a `viewer/` or preview-server UI change (the 95% case) | `bun run drive verify` | packaged headless Playwright, DOM + persisted-document assertions, zero IPC mocking |
| CI E2E that exercises the **native shell** incl. macOS | WebdriverIO `@wdio/tauri-service`, **embedded** provider (`tauri-plugin-wdio-webdriver`) | macOS WebDriver is supported *only* via the embedded server — `tauri-driver`/Selenium direct is Windows/Linux only (Apple ships no WKWebView driver) |
| Real Playwright over the native webview | community `srsholmes/tauri-playwright` (in-app socket bridge) | not official; genuine CDP path is Windows/WebView2 only |
| Native window / menu / dialog smoke test | `/view`, after an explicit human request | human observation only; never unattended host computer-use or automated evidence |

The reason the cheap path wins: vean deliberately keeps the app a thin HTTP
consumer, so the thing worth testing (the editing UI) is a plain web app. Lean on
that.

## Discipline

- Always `bun run drive down` when finished — don't leak sidecars. (`drive status`
  shows what's live; `pgrep -f "cli.ts preview"` finds strays.)
- Clips live in `$TMPDIR` / the session scratchpad, never committed.
- One change → one focused proof. Don't record a five-minute tour; record the ten
  seconds that show the diff working.
