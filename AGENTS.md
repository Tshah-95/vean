# vean — the agent-native video editing core

> **vean studio** — Video Editor, Agent Native · vean.studio

vean is the **typed document, edit algebra, and diagnostics layer** for video
editing on top of MLT. Think of it as a *language server for video*: a
frame-exact, rationally-timed model of a timeline that an agent (or a UI, or a
human) mutates through a closed set of operations, each of which reports its
consequences **before a single frame renders**.

vean is **not an app.** It is the headless core an app sits on. Files in, files
out. No state, no network, no secrets. The render is delegated to `melt`
(MLT/FFmpeg) as a separate process; the motion-graphics are delegated to
Remotion as a producer. vean owns the part nobody else does: a *typed,
validated, diagnosable, agent-authorable* representation of an edit.

This file is the **resolver** — it doesn't hold the knowledge, it routes to it.
It is the single canonical brain; `CLAUDE.md` is a one-line `@AGENTS.md` shim so
Claude and Codex read the same bytes.

## What it is / isn't (read first)

- **IS:** a typed IR for an MLT timeline (multi-track, audio, keyframes,
  filters, transitions); a deterministic serializer + parser (IR ⇄ `.mlt` XML);
  a pure edit algebra (`op(state) → {state', consequences, inverse}`); a
  diagnostics engine (the LSP); a render/inspect driver that shells out to
  `melt` and `ffmpeg`.
- **ISN'T:** a renderer (MLT/FFmpeg do that), a motion-graphics engine (Remotion
  does that), a GUI (the visualization layer does that), or anything stateful.

## The seam: depend / mine / build

The whole strategy in one table. We **fork the engine** (depend on MLT, which we
already drive), **mine Shotcut's source as the spec** (its edit algebra and dial
schemas are the answer key — we lift the semantics, drop the Qt), and **build**
the typed/diagnosable layer nobody else has.

| | What | Why |
|---|---|---|
| **Depend on** (reuse as-is) | MLT + `melt` + FFmpeg; Remotion's renderer + `@remotion/player` | Solved problems — engine semantics, codecs, the React-in-Chrome render. Never reimplement. Driven at arm's length (see Hard boundaries #1). |
| **Mine** (source as spec, don't run) | Shotcut `src/commands/` (edit algebra + undo mechanics); `src/qml/filters/*/meta.qml` (dial schemas); the nested-tractor-dissolve + blanks-as-gaps XML shapes | Debugged knowledge, but Qt-coupled. Lift the semantics, drop the framework. |
| **Build** (own, greenfield) | the typed IR; serialize + parse; the keyframe model; the dials schema (from `melt -query` + overrides); the edit algebra as pure ops; the diagnostics LSP; the agent bridge + skills; the reference viz app | This is the project. The LSP especially is net-new — no NLE exposes consequences. |

## The layer model

Three layers. The agent-vs-UI ownership split falls out of them cleanly.

1. **The core (this repo's heart, headless, no UI).** The typed video *document*
   and everything that reasons over it: IR, serialize+parse, keyframe model,
   dials schema, edit algebra, diagnostics, the `melt`/ffmpeg driver. The video
   equivalent of a language server + the engine driver. ~Agent-buildable,
   because it's well-specified (the spec is Shotcut's source).
2. **The agent bridge.** Two coordinated surfaces over the same core:
   **`vean-lsp`** for ambient feedback (push diagnostics, code actions,
   definitions/references/hover over the timeline document) and **MCP/CLI tools**
   for domain actions (`apply-op`, `preview-op`, `undo`, `render`, `still`).
   `diagnose` exists for CI/debug/manual inspection, but it is **not** the normal
   agent loop. Agents should see adverse effects the same way they do in code:
   edit/change happens, diagnostics are pushed without a separate "remember to
   call diagnose" step.
3. **The visualization layer.** A Conductor-style web app: project list,
   timeline drawn from the IR, the preview surface (`@remotion/player` slaved to
   a master clock + footage video), and the agent-orchestration UI (sessions,
   diffs, git worktrees for exploration). This is **taste**, and it is mostly
   *read + light nudge* at first.

The payoff of the split: **human gestures and agent actions become the same
operations** — both call the edit algebra, both get undo, and both update the
same document that `vean-lsp` watches. That unification is only possible because
we did not fork Shotcut's Qt-welded gestures/undo. Build the editing logic once.

## Agent feedback contract

This is load-bearing. Do not regress it into manual lint/tool polling.

- **Diagnostics engine is shared core.** `src/diagnostics/` owns domain rules
  once: timeline validity, keyframe bounds, transition overlap, asset refs,
  dial ranges, A/V hazards, and related locations. LSP, MCP, CLI, tests, and the
  future UI all call this engine; none reimplement the rules.
- **LSP is ambient truth.** `vean-lsp` publishes the current complete diagnostic
  set for each open/project document after document changes. Like TypeScript,
  Pyright, and rust-analyzer, it does not make agents ask for `diagnose` after
  every edit. An empty diagnostic set clears prior diagnostics.
- **MCP tools are domain actions, not the diagnostics source of truth.** Mutating
  tools return `consequences`, `inverse`, touched URIs, and a compact health
  summary (`errors`, `warnings`, and only new/blocking diagnostic details). They
  do **not** dump the whole diagnostic set on every call; that is noisy and
  belongs to the ambient LSP stream or explicit debug/CI commands.
- **`diagnose` is a debug/CI verb.** It is allowed for gates, tests, one-off
  inspection, and non-LSP clients. It must not be the required step that makes a
  Claude Code edit loop safe.
- **Code actions are fixes.** Diagnostics that have deterministic repairs should
  expose LSP code actions and/or MCP safe-edit actions: shorten a transition,
  relink/remove a dangling asset, remove an orphaned filter, or make a ripple
  choice explicit.

Because the entire edit state is **text** (IR/XML + Remotion `.tsx` + asset
refs), `git worktrees` give parallel exploration for free — branch a project,
let an agent try a tighter cut, render + diff + preview, keep or discard.

## The Remotion seam

**MLT XML is the spine / single source of truth for placement. Remotion is a
producer.** They are two runtimes with no shared frame buffer; you cannot put
them on one *engine* track, but you can put them on one *editor* track:

- **Export:** pre-render each composition to an alpha clip (ProRes 4444,
  `yuva444p10le`, scoped with `frameRange`) and drop it onto an upper MLT track.
- **Live preview:** embed `@remotion/player` slaved to the editor's master
  playhead, composited over the footage `<video>` in the browser.
- **Accept two compositing paths** (live preview ≠ bit-exact export). That's the
  real cost, and it's manageable.

Do **not** rebuild Remotion. Its value is the React-in-Chrome render; what it
lacks (a data document) is exactly the thing we build on the MLT side.

## Load-bearing invariants (don't violate these)

- **Frame-exact rational time everywhere.** fps is `[num, den]` (29.97 is
  `30000/1001`, never `29.97`); positions/in/out/length are **integer frames**.
  A float fps anywhere makes the diagnostics subtly, permanently wrong.
- **Identity = stable producer UUIDs, not indices.** Indices are ephemeral;
  refer to a clip by stable id across a session. (This is how Shotcut's undo
  works, and it's why undo can be "store the inverse op".)
- **Keyframes live inside property strings** — `"0=100;50~=0"` (`|`=hold,
  `~`=smooth, etc.). A property is animated iff its string contains `=`. The
  typed keyframe model round-trips these byte-faithfully.
- **Determinism.** Same IR → byte-identical XML. Golden tests guard it.

## Status: scaffolded, building in phases

This is **infrastructure stood up early**, building behind verification gates —
see [ROADMAP.md](ROADMAP.md). Nothing stacks on an unverified phase. The Move-0
seed is studio's `src/mlt` toolkit, ported here with the `@/brand` coupling
stripped (colors become plain hex/named — vean is standalone).

## Conventions

- **Work on `main`.** Solo, fast-moving repo — commit directly to `main`.
- **Bun** runtime, `type: module`, ESM, `.ts`, `@/*` → `src/*`.
- **Zod** schemas on the IR and every op input — typed, validated before `melt`
  runs.
- **Biome** lint+format. **Vitest** for pure units — serializer, parser,
  op-inverse, diagnostics, keyframe round-trip are all **golden-tested**. Frame
  rendering is verified by an actual `melt` render + still-frame compare, never
  in vitest.
- **No coupling to any in-house brand or app.** vean is a standalone OSS
  project; it must never import from `carlo`, `studio`, etc. This is a feature,
  not a constraint — it's why the repo is public.

## Hard boundaries

1. **Never link GPL code.** We drive `melt` (GPLv2) as a **separate process**
   via the public `.mlt` file format + CLI — arm's-length per the FSF GPL FAQ —
   so vean stays AGPL-by-choice, not GPL-by-force (see [LICENSING.md](LICENSING.md)).
   Never statically or dynamically link `libmlt` or `libavcodec` into vean.
2. **Never bundle codecs or the `melt`/`ffmpeg` binaries.** They are system deps
   the user installs. vean's distributed artifact is pure TypeScript.
3. **Stateless.** No DB, no network calls, no secrets. Files in, files out.
4. **License discipline.** AGPL-3.0; contributions only under the CLA (see
   [CONTRIBUTING.md](CONTRIBUTING.md)). Never merge un-CLA'd code — it forecloses
   dual-licensing, which is the monetization escape hatch.

## The resolver (capability × work axis)

Capabilities (the *how*) live in `.claude/skills/<skill>/`; work (the *what*)
lives in `src/`. Shallow today — skills get written *from real experience* as
each Move lands, not guessed ahead. Until a skill exists, the method is in
[ROADMAP.md](ROADMAP.md).

| When you want to… | Load skill | Work in |
|---|---|---|
| extend the timeline model (tracks, audio, keyframes, filters) | _(none yet — see ROADMAP Move 0)_ | `src/ir/` |
| serialize/parse `.mlt` | _(none yet — Move 0)_ | `src/ir/`, `tests/`, `corpus/` |
| add/verify an edit operation | _(none yet — Move 1)_ | `src/ops/`, `tests/` |
| add a diagnostic / lint | _(none yet — Move 1)_ | `src/diagnostics/` |
| wire the agent bridge / a skill | _(none yet — Move 2; monitor with `BUILD-MONITOR.md`)_ | `src/lsp/`, `src/bridge/`, `.claude/skills/` |
| edit a timeline as an agent (apply an op, fix a diagnostic, tighten a cut) | `editing` | a `.mlt` doc via the bridge tools (`apply-op`/`preview-op`/`undo`/`render`/`still`) |
| build the viz layer | _(none yet — Move 3)_ | `app/` (TBD) |

### Keeping the resolver healthy

When a pattern repeats or a correction lands, **promote it** — write or update a
skill in `.claude/skills/`, then fix the row above. The bar for a skill is
judgment/method; pure mechanics stay scripts. Write skills from what actually
happened in a Move, not a hypothesis.

## Layout

```
src/
  ir/          ← the typed document: IR types, serialize, parse, keyframes (Move 0)
  ops/         ← the edit algebra: pure op(state) → {state', consequences, inverse} (Move 1)
  diagnostics/ ← the LSP: static checks, resolve-value-at-frame, find-references (Move 1)
  bridge/      ← the agent surface: CLI / MCP verbs (Move 2)
  driver/      ← the melt/ffmpeg subprocess driver + inspect (render, still, contact)
  index.ts     ← barrel
tests/         ← vitest: golden round-trips, op-inverse invariants, diagnostics fixtures
corpus/        ← real .mlt files for round-trip + render-faithfulness gates (Move 0)
.claude/skills/← CAPABILITY axis: methods, versioned (written as Moves land)
app/           ← the reference visualization layer (Move 3, TBD)
ROADMAP.md     ← the phases + their verification gates (the plan of record)
BUILD-MONITOR.md ← 15-minute checkpoint/review protocol for active agent builds
LICENSING.md   ← why AGPL-3.0 + CLA, and the no-linking nuance
```

## Quick reference

Mostly **planned** — implemented per Move. See [ROADMAP.md](ROADMAP.md).

| Task | Command | Lands in |
|---|---|---|
| Install | `bun install` | — |
| Test / typecheck / lint | `bun run test` · `bun run typecheck` · `bun run lint` | now |
| Round-trip a `.mlt` (parse→IR→serialize) | `bun run roundtrip <file.mlt>` | Move 0 |
| Render-faithfulness gate over the corpus | `bun run verify:corpus` | Move 0 |
| Apply an edit op | `bun run edit <op> …` | Move 1 |
| Diagnose a timeline | `bun run diagnose <file>` | Move 1 |
| Resolve a param's value at a frame | `bun run resolve <param> <frame>` | Move 1 |
| Render headless / inspect a frame | `bun run render <file>` · `bun run still <file> <frame>` | Move 0–1 |

## System deps (not bun packages)

`mlt` (provides `melt`) and `ffmpeg`. Mac: `brew install mlt ffmpeg`. Linux:
`apt install melt ffmpeg`. Optional, for the Remotion producer: a Node/Bun
Remotion install (peer, user-provided).
