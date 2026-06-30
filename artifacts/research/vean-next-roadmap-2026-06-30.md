# vean — next roadmap (post-Palmier synthesis)

Date: 2026-06-30
Inputs: [palmier-pro-vs-vean-2026-06-30.md](./palmier-pro-vs-vean-2026-06-30.md) (the committed
comparison), [ROADMAP.md](../../ROADMAP.md), a full code-level substrate map, a Palmier UI/tool/business
deep-dive, and a 5-angle research sweep on generative-vs-programmatic motion graphics (mid-2026).

This doc is a **proposal that drives the next phase**, not yet the plan of record. The agreed pieces get
promoted into [ROADMAP.md](../../ROADMAP.md) as proper Moves with gates once the two product forks (§7) are
called.

---

## 1. Positioning verdict

Palmier and vean chase the same thesis — *the agent edits the real timeline, not a sidebar* — and took
**opposite architectural bets**:

- **Palmier** = product-first. Native Swift/AVFoundation macOS-26-only app, proprietary `.palmier` JSON
  package, gen-AI credit business, MCP from the running app. Nailed the **UX and distribution**; built on a
  **structurally weak core** — non-deterministic (regenerated clips come back a different length and desync
  the timeline), no version control, lossy export (NLE-XML drops all AI metadata), hard platform + format
  lock-in, imperative op layer riddled with footguns (index-shift on word cuts, sync-locks, phantom clips).
- **vean** = core-first. `.mlt`-as-spine, rational time, pure edit algebra with consequences/inverses,
  ambient LSP diagnostics, action registry with effect metadata, melt/FFmpeg at arm's length, headless +
  cross-platform.

**We are further along than the comparison doc implies.** Moves 0/1/2/5 are complete and gated green; live
preview ships all tiers (0/1/2a/2b); we have 18 public ops (22 in catalog), a 44-action registry, MCP
generated from the registry, an ambient LSP, a Tauri shell whose direct-manipulation gestures already commit
ops through the action runtime. The "product gap" Palmier appears to have on us is **narrower than it looks**:
it is almost entirely *media intelligence + task-shaped actions + UI polish*, and every one of those is a
**new action family over a solid core**, not a re-architecture.

**The wedge:** determinism + ambient diagnostics + a git-native open format are precisely the three things
Palmier **cannot follow us onto without a rewrite**. Strategy in one line: **steal Palmier's interaction
patterns; make the moat the things their architecture forecloses.**

---

## 2. The Remotion-vs-generative decision (settled)

**Question:** is it useful to author motion graphics in Remotion (deterministic, re-editable) or should we
lean on AI-generative models to make motion graphics and edit them into footage?

**Answer: keep Remotion — and it isn't "also fine," it's the *correct and differentiated* choice for exactly
the content that matters most.** The mid-2026 evidence is airtight and the whole industry has converged on
the same split:

- **Generative video physically cannot hold text, numbers, logos, UI, or charts stable frame-to-frame.** No
  model (Veo 3.1, Kling 3.0, Seedance 2.5, Runway Gen-4.5 — and OpenAI *discontinued Sora*: app gone Apr 2026,
  API sunsets Sep 2026) reliably renders exact strings/data/brand marks; all degrade past ~3 words. A
  generative "edit" (Sora Remix, Runway Aleph) is **whole-clip regeneration that tries to preserve
  structure** — not element isolation — and is non-deterministic even with a fixed seed (GPU/FP
  nondeterminism + temporal-layer drift). The named failure mode is "a slot machine with a subscription fee."
- **Programmatic (Remotion/Lottie/AE-data) is the inverse on every axis:** deterministic by construction
  (`useCurrentFrame`, `Math.random` banned), parametric (props/JSON — change one field, re-render, nothing
  else moves), git-diffable (source *is* the artifact), and alpha-compositable (ProRes 4444 `yuva444p10le` +
  `frameRange` partial renders). Every load-bearing property of our Remotion seam is real and documented in
  Remotion 4.0.x.
- **The 2026 product-demo / data-viz consensus**: precise UI/data/charts/brand are **captured (screen
  recording) or code-rendered (Remotion/Shotstack)**; generative is confined to **organic b-roll**
  (establishing shots, atmosphere, texture, human-free cutaways); **audio is a separate deterministic track**
  (AI-TTS/music/SFX render to stable files — the determinism problem is video-only). "Code controls
  precision; AI controls creative polish."

**Architectural implication — three roles, clean seams (do not blur them):**

| Role | Owns | In vean |
|---|---|---|
| **Spine** (source of truth for placement) | frame-exact timeline | `.mlt` IR — already the core |
| **Producer** (deterministic graphics) | product UI, charts, lower-thirds, kinetic type, brand frames | Remotion (Move 5, shipped) — keep and extend |
| **Source** (organic footage) | b-roll, establishing, atmosphere, **AI-generated clips** | import as footage with **provenance metadata** — new |

The key reframe: **generative is a *media source*, not an engine.** vean's core stays no-network; generation
lives behind a pluggable producer/import boundary. We do *not* try to be a generative-media engine. We *do*
steal Palmier's best idea — **provenance pinned to the clip** (prompt/model/refs → regenerate in place) — and
do it one better: put it in the **typed IR so it survives export**, which Palmier's lossy `.palmier`→XML path
cannot. For our own dogfood (a product demo): product views + data + charts = Remotion; thin b-roll layer =
generative-or-stock import; VO/music/captions = separate audio tracks. This maps *with* the real 2026
workflow, not against it.

---

## 3. The build backlog

Pooled from the Palmier "steal" list, the comparison doc's recommendations, and the substrate map's open
items. Bucketed exactly as requested: **(a) obvious substrate wins**, **(b) dependency-ordered features**,
**(c) parallel worktree streams**.

### (a) Obvious substrate wins — drop straight into what we have

Low-risk, well-specified, high-leverage. These should land now (per the no-deferral rule), most are
mechanical, and several *unlock* the feature tracks for free.

1. **Wire `ffprobe` into the media catalog.** `src/driver/probe.ts` exists; catalog rows in `src/state/media.ts`
   have placeholder `probe_json`/`labels_json` columns. Populate duration, fps, resolution, audio streams,
   colorspace, content hash. *Unlocks #2 and the transcript/sync feature tracks.*
2. **Activate the 5 I/O diagnostic stubs** (`src/diagnostics/checks/{media,sync}.ts` — finalized signatures
   today): `dangling-file-ref` (fs stat), `upscaling-over-100pct`, `colorspace-mismatch`,
   `framerate-mismatch-jitter` (all from probe #1), `asymmetric-av-trim`. Net-new diagnostics over the
   existing engine, held to the zero-false-positive bar. *Free correctness wins the moment #1 lands.*
3. **Verify Remotion ProRes-4444 alpha is composited as *premultiplied* by MLT.** Both Premiere and Resolve
   assume premultiplied; a straight/premultiplied mismatch is the classic cause of edge halos on overlay
   graphics. Add a render golden over the demo overlay. (`src/driver/remotion.ts` + a corpus fixture.)
4. **`inspect-timeline` as a structured agent tool.** We already have `render still`; wrap a still-strip
   across a frame range (`{startFrame,endFrame,maxFrames}`) so the agent *sees* its edit. This is Palmier's
   single most distinctive primitive and we're one thin adapter away.
5. **Make every path-bearing action report resolved + touched URIs** (generalize what render/still already
   do) and **promote project-navigation actions** (`project.list/current/use/new`, `timeline.new/addFootage/
   addAudio`) into first-class MCP discovery. Removes the friction that makes agents guess.
6. **Close the 5 latent keyframe-engine gaps** (`src/ir/keyframes.ts`: timecode `:FF`, empty value `0=`,
   quoted-value throw, ms drift, edge-anchored 2-keyframe fade misclassification). They become live the moment
   an edit op parses a keyframe model on the document path; fix now, guarded by `tests/keyframes.test.ts`.
7. **Tool/action descriptions encode editorial taste, not just schema** (Palmier's `AgentInstructions` lesson):
   when to use a layout vs a property edit, when to inspect, how to cut by transcript. Pure prose over the
   existing 44 descriptors.

### (b) Dependency-ordered feature tracks

The genuinely new capability. Arrows = hard dependencies.

```
                    ┌─────────────────────────────────────────────┐
   probe→catalog ──►│ T1  MEDIA INTELLIGENCE SUBSTRATE             │
   (a.1) ───────────│  catalog enrichment + jobs-for-slow-work +   │
                    │  transcription job  [FORK: backend §7]       │
                    └───────┬───────────────────────┬─────────────┘
                            │                       │
              ┌─────────────▼──────────┐   ┌────────▼─────────────┐
              │ T2 TRANSCRIPT MODEL     │   │ T5 AUDIO ANALYSIS    │
              │ transcript↔frame map,   │   │ waveform → syncAudio,│
              │ post-edit timeline txt  │   │ silence detection    │
              └───┬─────────────┬───────┘   └────────┬─────────────┘
                  │             │                    │
        ┌─────────▼───┐  ┌──────▼────────┐  ┌────────▼──────────────┐
        │ T3 WORD-CUT │  │ T4 CAPTIONS   │  │ T6 TASK-SHAPED ACTIONS│
        │ removeWords │  │ caption track │  │ applyLayout, duckMusic│
        │ op (stable  │  │ + update_text │  │ addBroll, tightenCut, │
        │ IDs, no     │  └───────────────┘  │ removeDeadAir         │
        │ index-shift)│                     └───────────────────────┘
        └─────────────┘

   INDEPENDENT (no dep on T1):
   T7 GENERATIVE PROVENANCE + pluggable producer  [IR field first; FORK: posture §7]
   T8 PRODUCTIZED SKILLS CATALOG (catalog.json + schema + install flow)
   T9 AGENT-SCOPED UNDO / authorship boundary (session layer)
   T10 GIT-WORKTREE EXPLORATION + agent-session panel (DESIGN-WORKTREE Layer B)
   T11 MOVE-3 RUNTIME COMPLETION (ActionContext DI, projections, CLI polish)
   T12 MOVE-6 BREADTH (filter/dial catalog → color tools → speed/time-remap → format long-tail)

   INTEGRATION:
   T13 THE DOGFOOD DEMO  ← needs T2,T3,T4,T6 + Remotion lower-third (have)
       open → import → transcript → remove dead air → lower-third → render → before/after
       (this is also vean's own product demo — built with vean)
```

Notes on the load-bearing edges:
- **T1 is the gate for the whole left half.** Probe enrichment is plain wiring; transcription is a *job* and a
  *product fork* (§7) — define the job interface first so T2–T6 can be built against it in parallel.
- **T3 is where we beat Palmier by construction.** Their `remove_words` has a documented index-shift footgun
  ("indices shift after each cut"). Model word ranges as **stable IDs** through the pure edit algebra and the
  bug class is impossible.
- **T6 `applyLayout`** likely needs a small **transform/crop helper** (an affine/qtcrop filter via the
  existing `addFilter` op) — a minor addition, not a blocker. Palmier's rule "*never drop to
  `set_clip_properties` when `apply_layout` works*" is the design north star: the macro does the correct crop
  so the subject fills the slot without stretching.
- **T7 IR field is a tiny shared-scope change** — land the `provenance` field on the clip type first, then the
  producer adapter is disjoint.

### (c) Parallel code-worktree streams (disjoint write scopes)

Multiple agents can run in tandem in isolated **code** worktrees if their write scopes don't overlap. Land
the three small **shared-scope heads first** (sequencing gates), then fan out.

**Land first (shared scope — sequence these, they unblock the rest):**
- **H1 — `ActionContext` DI** (`src/actions/types.ts`): the cross-cutting refactor at the head of T11. Do it
  before T6/T7 add new actions, or they'll be reworked.
- **H2 — IR `provenance` field** (`src/ir/types.ts` + serialize/parse round-trip + golden): tiny, but core IR
  that everyone reads. Land then leave alone.
- **H3 — transcription job interface** (`src/state/jobs.ts` + a typed contract): define the shape so T2–T6
  build against it while the backend (§7) is still being chosen.

**Then run in parallel (disjoint scopes):**

| Stream | Scope (write surface) | Tracks | Overlaps? |
|---|---|---|---|
| **S1 Media intelligence** | `src/driver/probe.ts`, `src/state/{media,schema}.ts` + migration, `src/diagnostics/checks/{media,sync}.ts` | a.1, a.2, T1 | none |
| **S2 Transcript + word-cut** | new `src/transcript/`, `src/ops/removeWords.ts`, `src/query/` txt-map | T2, T3, T4 | reads H3 |
| **S3 Editorial macros** | new `src/actions/editorial.ts` (+ one transform-filter helper in `src/ops/`) | T6 | reads H1 |
| **S4 Generative producer** | new `src/actions/generate.ts` + a job | T7 body | reads H1, H2 |
| **S5 Skills catalog** | `.agents/skills/`, `catalog.json`, `skill.schema.json`, `src/actions/skills.ts` | T8 | none |
| **S6 App: worktree + session panel** | `app/`, `viewer/src/components/` | T10, T9-UI | none (app layer) |
| **S7 Remotion seam hardening** | `src/driver/remotion.ts` + corpus fixture | a.3 | none |
| **S8 Dials/filter catalog** | new `src/ir/dials/` (from `melt -query` + overrides), dial-range check | T12 head | none |

PM (lead thread) integrates, re-runs the gates (`bun run test` · `typecheck` · `lint` · `verify:corpus` ·
`lint:xml`), and resolves conflicts. Every stream follows the parallel-session safety rules (capture HEAD,
absolute SHAs, private worktree for exact content).

---

## 4. UI — copy / don't-copy / the surfaces only we can build

Palmier's UI is genuinely strong (strict `AppTheme` design-system discipline, "Premiere as north star"
familiar layout, `inspect_timeline` visual verification, metadata-on-clip regeneration, frictionless
onboarding). vean already has the *hard* part — a real IR-drawn timeline, an all-tiers live compositor, and
direct-manipulation gestures that commit ops. The gap is polish + convention + the agent/diff surface.

**Copy:**
- **The familiar pro-NLE layout language** as the default — left media/assets, center monitor, bottom
  multi-track. Lowers the learning curve; our viewer should adopt these conventions.
- **A design-token system for the viewer** (spacing/type/color/shadow constants, no hardcoded values). We
  correctly stripped the `@/brand` coupling to stay standalone — the lesson is "own a token system," not
  "import a brand."
- **Visual verification as a first-class affordance** — the still-strip / before-after from a.4, tied to the
  timeline and to worktree exploration (render+diff+still compare is already a Move-4 gate item).
- **Frictionless onboarding** — match Palmier's one-liner `mcp add` + one-click install activation energy.

**Don't copy:**
- **Don't weld the UI to a native render engine.** WKWebView + viewer + melt/Remotion is the right
  cross-platform/headless-friendly choice. (Already correct — reinforce it.)
- **Don't let the app become the source of truth.** Every mutating surface stays an adapter over an action id.
  (Already correct.)

**The differentiated surfaces Palmier structurally cannot build — lean in hard:**
- **Inline ambient diagnostics on the timeline** — "type errors for video": red/yellow squiggles on a clip
  whose in/out exceeds source, a transition with no overlap, an upscaled clip. Palmier has no diagnostics
  engine; this is the visible face of our biggest moat.
- **Consequences-before-render** — show `preview-op` consequences + the inverse before a frame is committed.
  Palmier's agent edits blind and verifies after; ours can show the effect *first*.
- **Branch / worktree / diff surface** — because our entire state is text, the app can show project branches,
  agent-session diffs, and side-by-side renders. Palmier's live-app-+-binary-package state has no such story.
- **Provenance + op-history inspector** — surface generative provenance *and* the typed op trail with undo,
  which Palmier can't (their metadata dies on export; they have no inverse algebra).

---

## 5. Bug & gap triage

The headless gates are green (`bun run test` 778 passing/0 skipped, `typecheck` clean, `verify:corpus`
10/10 SSIM 1.0, `lint:xml` 12/12). So the "quite a few bugs in tandem" almost certainly live in the **UI/app
interaction layer**, which vitest does not cover (`viewer/` is biome-excluded, gated only by `tsc` +
`vite build`). Concrete triage:

| Item | Type | Severity | Action |
|---|---|---|---|
| Git-worktree exploration model + agent-session panel | Missing Move-4 feature | High | T10 / S6 — the big remaining product feature |
| Premultiplied-alpha mismatch on Remotion overlay | Latent correctness | Med | a.3 / S7 — verify + golden **now** |
| 5 latent keyframe-engine gaps | Low/latent | Low | a.6 — fix now, don't defer |
| Root lint vs viewer lint — conflicting signal in the map (root reported pre-existing failures in `src/{cli,conform,state}`, but `bun run lint` reported clean) | Unknown | Med | **Verify** which is true; if real, fix |
| UI/app interaction bugs (the ones you're seeing) | Unknown — not in the headless inventory | ? | Need your list (§7) + a `drive`-skill bug-hunt pass |
| Move-0 Shotcut GUI spot-check; Move-4 "prefer to Shotcut" gate | Manual | — | Needs you at the GUI |
| Palmier's bug *classes* (index-shift, sync-locks, phantom clips) | Design lesson | — | Make impossible by construction in T3/T6 |

The unprobed I/O diagnostics (a.2) aren't bugs — they're correctness we get for free once probe is wired.

---

## 6. Recommended immediate next actions

1. **Land the three heads (H1, H2, H3)** + **all of bucket (a)** in one focused pass — they're small, mostly
   mechanical, unblock everything, and clear the latent bugs.
2. **Then fan out S1–S8** across worktrees per the table, with media-intelligence (S1→T1) as the critical path
   per the comparison doc's "close the media gap first."
3. **Drive toward T13 (the dogfood demo)** as the integration gate — it's both the "first successful edit"
   proof *and* vean's own product demo, built with vean.
4. **Resolve the two product forks (§7)** before S4 (generative posture) and the transcription half of S1/H3
   (backend) lock in a design.

---

## 7. The genuine decisions (need Tejas)

Everything above is actionable without you **except** these real forks — they change *what* gets built, not
just *when*:

1. **Transcription / media-intelligence backend & privacy shape.** Local sidecar (whisper.cpp — on-thesis:
   no-network, bundled like melt) vs hosted API (faster, but breaks the "core has no network/secrets"
   boundary and needs an install/privacy story). Per the standing note, media intelligence is *deliberately
   not first-party until this is decided.* **Recommendation: local whisper.cpp sidecar** — it preserves the
   no-network core boundary and the cross-platform/headless story, and it's the differentiated posture.
2. **Generative posture.** (a) *Import-with-provenance only* — vean never generates; you bring a clip you
   made elsewhere and we pin/round-trip its provenance (minimal, fully on-thesis, zero network in core). (b)
   *Pluggable in-app generation* behind an explicitly-opted job/network adapter (Palmier-parity, more
   magical, more surface). **Recommendation: ship (a) now, design (b) as an opt-in adapter** so the core
   stays clean and we still get regenerate-in-place that *survives export*.
3. **Sequencing priority.** Media-intelligence-first (comparison doc's call) vs UI-polish-first vs
   dogfood-demo-first. **Recommendation: media-intelligence-first**, because it unblocks the most and is the
   widest gap vs Palmier — but the dogfood demo (T13) should be the visible target the whole time.
