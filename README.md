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

vean is **not** a renderer, a motion-graphics engine, or a GUI. It delegates:

- **Render** → `melt` (MLT/FFmpeg), driven as a separate process.
- **Motion graphics** → [Remotion](https://www.remotion.dev/), as a *producer*
  (pre-rendered alpha clips for export; `@remotion/player` for live preview).
- **UI** → a reference visualization layer built on this core (planned).

It is inherently **stateless**: files in, files out. No database, no network, no
secrets.

## Architecture

Three layers:

1. **Core** (headless) — the typed document + serialize/parse + keyframes +
   edit algebra + diagnostics + the `melt`/ffmpeg driver.
2. **Agent bridge** — a CLI/MCP surface (`apply-op`, `diagnose`,
   `resolve-value-at-frame`, `find-references`, `render`, `still`) + skills.
3. **Visualization layer** — a Conductor-style web app (project list, timeline,
   live preview, agent orchestration with git-worktree exploration).

Human gestures and agent actions are the *same* operations — both get
diagnostics, both get undo.

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
agent-editing loop by Move 2, and a UI you'd choose over Shotcut by Move 3.

## Requirements

- [Bun](https://bun.sh)
- `mlt` (provides `melt`) and `ffmpeg` — `brew install mlt ffmpeg` /
  `apt install melt ffmpeg`

## License

[AGPL-3.0](LICENSE). Contributions are accepted under a CLA — see
[CONTRIBUTING.md](CONTRIBUTING.md) and the rationale in [LICENSING.md](LICENSING.md).
