# vean

*vean studio — Video Editor, Agent Native · [vean.studio](https://vean.studio)*

**The agent-native video editing core.** A typed document, edit algebra, and
diagnostics layer for video editing on top of [MLT](https://www.mltframework.org/) —
a *language server for video*.

> Status: early. Scaffolded ahead of implementation, building behind verification
> gates. See [ROADMAP.md](ROADMAP.md).

## Why

Video editors maintain timeline validity *implicitly*, inside carefully-written
command code, and never tell anyone *why* an edit is or isn't valid. That's fine
for a human dragging clips; it's hostile to an agent — and to anyone who wants to
build a different UI on top.

vean inverts that. It is a **frame-exact, rationally-timed model of a timeline**
that an agent (or a UI, or a human) mutates through a closed set of operations,
each of which **reports its consequences before a single frame renders**:

- a **typed IR** for an MLT timeline — multi-track, audio, keyframes, filters,
  transitions — that round-trips losslessly to `.mlt` XML (the format Shotcut and
  Kdenlive read/write);
- a **pure edit algebra** — `op(state) → {state', consequences, inverse}` — so
  every edit is legible, reversible, and identical whether a human or an agent
  issues it;
- a **diagnostics layer** (the "LSP"): gaps/overlaps, out-of-bounds keyframes,
  A/V-sync hazards, dial-range violations, plus *go-to-definition* (resolve a
  param's value at a frame, through clip → track → tractor → transition) and
  *find-references* (what uses this source, what ripples if I move this).

vean's core is **not** a renderer, a motion-graphics engine, or a GUI. It
delegates:

- **Render** → `melt` (MLT/FFmpeg), driven as a separate process. The CLI/source
  install uses system deps; the future Mac app may bundle pinned renderer
  sidecars.
- **Motion graphics** → [Remotion](https://www.remotion.dev/), as a *producer*
  (pre-rendered alpha clips for export; `@remotion/player` for live preview).
- **UI** → a local Tauri Mac app built on this core (planned). The website is for
  download/docs, not a web editor.

The timeline core is **stateless**: files in, files out. Product coordination
state is local-only: CLI/LSP/MCP/future UI metadata lives in gitignored
`.vean/vean.db` and never replaces committed timeline files.

## Architecture

Four layers:

1. **Core** (headless) — the typed document + serialize/parse + keyframes +
   edit algebra + diagnostics + the `melt`/ffmpeg driver.
2. **Action runtime** — one typed registry for product behaviors, projected to
   Commander CLI, MCP tools, deterministic LSP code actions, and the future
   Tauri app. Every public action is available through ergonomic commands or
   `vean action run <id> --input-json ...`.
3. **Agent bridge** — `vean-lsp` for ambient diagnostics/navigation/code
   actions, plus CLI/MCP tools for domain actions (`apply-op`, `preview-op`,
   `undo`, `render`, `still`, `resolve-value-at-frame`, `find-references`) +
   skills. `diagnose` remains a debug/CI command, not the normal agent safety
   loop.
4. **Local Mac app** — a Tauri app for project selection, media catalog,
   timeline/preview, render/still review, jobs, and agent orchestration with
   git-worktree exploration. It uses the same action runtime and local state as
   the CLI.

Human gestures and agent actions are the *same* operations — both update the
same document, both get undo, and `vean-lsp` pushes diagnostics as ambient
feedback the way coding agents expect from TypeScript/Pyright/rust-analyzer.

## Relationship to MLT, Shotcut, and Remotion

- **MLT** is the engine — we depend on it (LGPL framework + the GPL `melt` CLI),
  driven at arm's length via the public `.mlt` format. We do **not** link it.
- **Shotcut** (GPL) is the *spec*, not a dependency — its edit-command semantics
  and per-filter dial metadata are the answer key we reimplement in a typed,
  Qt-free shape.
- **Remotion** is a producer, not a co-renderer. The MLT timeline is the spine;
  Remotion graphics are alpha clips on it.

## Status & roadmap

Building in phases, each behind a gate — see [ROADMAP.md](ROADMAP.md). Move 0 is
the document core (round-trip + render-faithfulness); the spine reaches a usable
agent-editing loop by Move 2; Move 3 hardens the action registry, Commander CLI,
and project/media ergonomics; Move 4 is the local Mac app.

## Requirements

- [Bun](https://bun.sh)
- `mlt` (provides `melt`) and `ffmpeg` — `brew install mlt ffmpeg` /
  `apt install melt ffmpeg`
- Rust/Cargo for native Tauri app builds — macOS: `brew install rust`

## Claude Code / Agent Setup

This repo is also a Claude Code plugin root:

- `.lsp.json` registers `vean-lsp` for `.mlt` files.
- `.mcp.json` registers `vean-mcp` as the domain-action tool server.
- `skills/setup/SKILL.md` points at the setup/bootstrap skill in
  `.agents/skills/setup/SKILL.md`.
- `skills/editing/SKILL.md` points at the canonical repo skill in
  `.agents/skills/editing/SKILL.md`.

Use it directly from this checkout:

```bash
claude --plugin-dir /Users/tejas/Github/vean
```

Verify the host-facing setup with:

```bash
bun run project:init
bun run doctor
```

If you want the preferred CLI+LSP setup, register this checkout's `vean` binary
first:

```bash
bun run setup:cli
vean doctor --surface cli-lsp
```

`bun run setup:cli` writes the package bins (`vean`, `vean-lsp`, `vean-mcp`) to
Bun's global bin directory. Make sure `~/.bun/bin` is on PATH for login shells;
after that, prefer `vean ...` over `bun src/cli.ts ...`.

`claude plugin validate` currently warns that root `CLAUDE.md` is not plugin
context; that is expected for this layout. Plugin-visible context lives in
`skills/*`, while `CLAUDE.md` remains the normal repo/project shim.

## Local State

vean uses a repo-local SQLite database at `.vean/vean.db` for product/app state:
projects, setup choices, job leases, media roots/catalog rows, route aliases, and
future UI coordination. It is ignored by git. The canonical timeline remains the
`.mlt` document and media files.

```bash
bun run project:init
vean state status
vean jobs list
```

The first media-routing slice is action-backed and exposed through Commander and
MCP:

```bash
vean media root add /path/to/media --role raw --json
vean media scan --json
vean media find interview --json
vean route resolve media:raw --json
```

This catalogs lightweight path/kind/size/mtime metadata only. Transcription,
labels, proxies, waveform analysis, and model-backed inference are intentionally
future action families.

## Action Runtime / App Scaffold

The Commander CLI is now backed by the seeded action registry:

```bash
vean discover --json
vean discover "duck audio" --kind op --json
vean action list
vean action describe timeline.previewOp
vean action run state.status --input-json '{}'
```

Timeline operations are discoverable before you edit:

```bash
vean timeline ops list --json
vean timeline ops describe crossfade --json
vean timeline ops examples volume --json
```

Aliases such as `crossfade`, `volume`, and `trim-out` are accepted for CLI and
search ergonomics, but durable identity stays canonical: `dissolve`, `gain`,
`trimOut`, and action ids like `timeline.applyOp`.

Set the active timeline once per project, then omit repeated file paths:

```bash
vean timeline use timelines/main.mlt --json
vean timeline current --json
vean timeline preview-op gain --args-json '{"uuid":"clip-5","db":-6}' --json
vean timeline apply-op volume --args-json '{"uuid":"clip-5","db":-6}' --json
```

For explicit routing, every path-bearing timeline command also accepts
`--timeline <path|file://uri|route-alias>` or the old
`vean timeline preview-op <file.mlt> <op>` form. `timeline:main` is stored as a
project-local route alias in `.vean/vean.db`; the `.mlt` file remains the
canonical edit document.

The local Mac app scaffold lives in `app/`. Verify the scaffold, Tauri config,
capabilities, sidecar manifest, and action-registry linkage with:

```bash
bun run app:doctor
```

Native app builds are covered by the stricter gate:

```bash
bun run app:doctor -- --native
```

That gate requires Rust/Cargo and produces the local macOS `.app` bundle. DMG
packaging is a later distribution task, not the seed harness target.

## License

[AGPL-3.0](LICENSE). Contributions are accepted under a CLA — see
[CONTRIBUTING.md](CONTRIBUTING.md) and the rationale in [LICENSING.md](LICENSING.md).
