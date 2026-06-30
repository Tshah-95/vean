---
name: drive
description: Drive the vean app to PROVE a UI change works — open the real editor in a headless (or headed) browser, click/inspect the thing you changed, record a screenshot/video clip into the temp dir, and reference it back in chat as proof. Use whenever you make a material UI change to viewer/ or the preview server and want to demonstrate the effect (not just assert it), confirm a feature behaves as imagined, or show before/after. Headless vs headed is indifferent — pick whichever proves it.
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

## The one fact that makes this work

The Mac app is a **thin Tauri shell**. On launch it spawns `vean preview` (a Bun
HTTP server) on a loopback port and just **navigates its WKWebView to
`http://127.0.0.1:<port>/`** (see `app/src-tauri/src/lib.rs`). That server serves
the real `viewer/` app **and** the whole API (`/api/action`, `/api/apply-op`,
`/api/undo`, `/api/still`, `/api/render`, …). The viewer talks to the backend over
**same-origin HTTP** (`viewer/src/api.ts`) — **not** `window.__TAURI__.invoke`.

Consequence:

- You **cannot** attach a CDP/Chromium agent to the **native WKWebView window** —
  WKWebView speaks Apple's Web Inspector protocol, not CDP, and macOS ships no
  WebDriver for embedded WKWebView. (Don't waste time trying.)
- You **don't need to.** Point `agent-browser` (Playwright/Chromium) at the **same
  loopback URL** and you drive the byte-identical frontend + backend the WKWebView
  renders — headless, DOM-aware, scriptable, and **recordable**. Because vean's UI
  is HTTP-not-`invoke`, there is **zero Tauri-IPC mocking** to do (unusual; most
  Tauri apps must mock `window.__TAURI__`).

So "drive the app" == "drive `vean preview` in a real browser." Headful only buys
you a visible window; the proof is identical.

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

## The harness (three commands)

```bash
# 1. Bring up a driveable instance against a project (free port, health-gated).
#    Idempotent: a second `up` reuses a healthy session. Defaults to cwd as project.
URL=$(bun run drive up --project /path/to/project)      # or: --timeline timeline:main

# 2. Drive the REAL UI headless. Note: plain http:// (NOT https — vean's preview
#    is loopback http; this contradicts the generic agent-browser skill's warning).
agent-browser --session vean open "$URL"
agent-browser --session vean snapshot -i            # interactive elements → @refs
agent-browser --session vean find text "Render" click
agent-browser --session vean screenshot "$TMPDIR/drive-render-panel.png"

# 3. Tear down (kills the sidecar, clears the session). ALWAYS do this.
agent-browser --session vean close      # close the browser session
bun run drive down                      # stop the preview sidecar
```

`bun run drive` is `scripts/drive.ts` — it owns only the server lifecycle
(`up`/`down`/`url`/`status`) so you never hand-roll free-port + wait-for-health +
teardown. The session (pid/port/url) lives in the repo's gitignored
`.vean/drive/<name>.json`; `--name` (default `vean`) maps 1:1 to
`agent-browser --session <name>`. Run several at once with distinct `--name`s.

Everything else is raw `agent-browser` (see the `agent-browser` skill for the full
command set: `snapshot`, `find`, `click`, `fill`, `get`, `is`, `diff`, `wait`,
`network`, `set viewport`, …).

## Recording video proof → reference it in chat

`agent-browser` records real `.webm` (it launches its own Chromium, so Playwright's
`recordVideo` works — the "Claude in Chrome" *extension* can only make GIFs):

```bash
agent-browser --session vean record start "$TMPDIR/feat-blade.webm"
# … drive the feature: click, edit, observe …
agent-browser --session vean record stop
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
- To smoke-test the **native shell itself** (the window actually opens, the menu
  fires, the sidecar boots and navigates), that's the heavier `app:doctor --native`
  / `tauri:dev` path, or an OS-level pixel tier (computer-use / `screencapture`).
  Reach for it only when the native wrapper — not the UI — is what changed.

## When to escalate past this skill

This loopback-web-frontend path is the **default** because it's the lightest, is
DOM-aware, records video, and needs no app changes. Escalate only when the target
isn't the web UI:

| Need | Use | Notes |
|---|---|---|
| Prove a `viewer/` or preview-server UI change (the 95% case) | **this skill** (`drive` + `agent-browser`) | headless, video, DOM + `/api/*` assertions, zero IPC mocking |
| CI E2E that exercises the **native shell** incl. macOS | WebdriverIO `@wdio/tauri-service`, **embedded** provider (`tauri-plugin-wdio-webdriver`) | macOS WebDriver is supported *only* via the embedded server — `tauri-driver`/Selenium direct is Windows/Linux only (Apple ships no WKWebView driver) |
| Real Playwright over the native webview | community `srsholmes/tauri-playwright` (in-app socket bridge) | not official; genuine CDP path is Windows/WebView2 only |
| Native window / menu / dialog smoke test | computer-use (pixel) or `screencapture -v` | engine-independent; slow, no DOM, pixel-fragile — last resort |

The reason the cheap path wins: vean deliberately keeps the app a thin HTTP
consumer, so the thing worth testing (the editing UI) is a plain web app. Lean on
that.

## Discipline

- Always `bun run drive down` when finished — don't leak sidecars. (`drive status`
  shows what's live; `pgrep -f "cli.ts preview"` finds strays.)
- Clips live in `$TMPDIR` / the session scratchpad, never committed.
- One change → one focused proof. Don't record a five-minute tour; record the ten
  seconds that show the diff working.
