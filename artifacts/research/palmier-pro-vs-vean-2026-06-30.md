# Palmier Pro vs vean

Date: 2026-06-30  
Subject: Palmier Pro, the YC S24 open-source "video editor built for AI", compared with vean.

## Executive Read

Palmier Pro and vean are chasing the same macro thesis: video editors should be operable by humans and agents against the same timeline. Palmier is the more complete product today. It ships a Swift-native macOS app, in-app chat, HTTP MCP, media inspection, transcript-driven edits, semantic media search, AI generation, color/effect tools, and export. Its public traction is also real: GitHub API reported 9,656 stars, 682 forks, latest push on 2026-06-30, and release `v0.4.5` published 2026-06-28.

The architectural divergence is sharp. Palmier is a product-first native editor whose internal timeline is a JSON document inside a `.palmier` NSDocument package, rendered/exported through AVFoundation plus a custom Core Image/Metal compositor. vean is a document/runtime-first system: `.mlt` is the canonical edit document, MLT/FFmpeg are subprocess renderers, operations are pure algebra with consequences and inverses, and diagnostics are designed as an ambient LSP contract. Palmier's advantage is user-facing completeness; vean's advantage is semantic rigor, file-level interoperability, deterministic round-trip, and a compiler-like correctness layer.

The biggest strategic takeaway: Palmier is proving the product shape users will expect. vean should not copy Palmier's Apple-only/internal-format renderer path, but it should copy the agent affordance layer Palmier has already made concrete: rich media inspection, transcript-as-edit-surface, timeline visual inspection, project navigation tools, generated/imported asset lifecycle, a community skill catalog, and very task-specific tool descriptions.

## Source Base

External product/docs:

- Palmier YC page: identifies Palmier as Summer 2024 and describes Palmier Pro as "where Claude and Codex can edit your timeline directly" and open-source/free at palmier.io. Source: https://www.ycombinator.com/companies/palmier
- Palmier site: positions Palmier Pro as timeline-native AI generation plus MCP agent editing, and lists multi-track video/audio/image/text, trim/split/speed/opacity/transform, export to Premiere/DaVinci, and MP4/NLE XML export. Source: https://www.palmier.io/
- Palmier GitHub README: open-source Mac editor, Swift-native, MCP endpoint at `127.0.0.1:19789/mcp`, GPLv3, macOS 26 Apple Silicon only. Source: https://github.com/palmier-io/palmier-pro
- Palmier FAQ: "video editor is the single source of truth"; without AI features, they call it a "bare-bone video editor"; missing feature parity includes transitions, masking, graphics. Source: https://github.com/palmier-io/palmier-pro/blob/main/FAQ.md
- Palmier skills repo: curated/community skills installed from Settings into `~/.palmier/skills/`. Source: https://github.com/palmier-io/palmier-skills

Code inspected:

- Palmier clone at commit `4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec` (2026-06-30 13:56:10 -0700), latest commit message `feat(mcp): project navigation tools (get/open/new project) (#238)`.
- vean checkout at commit `d4b3d3c`, branch `main`.

Key Palmier code references:

- `README.md`: product claims and MCP setup: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/README.md#L41-L102
- `Package.swift`: Swift 6.2, macOS 26 target, MCP/Sparkle/Sentry/Clerk/Convex/HuggingFace/Lottie deps: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/Package.swift#L1-L56
- `Timeline.swift`: internal JSON timeline with integer fps, tracks, clips, keyframe tracks, effects, blend mode: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/Sources/PalmierPro/Models/Timeline.swift#L9-L140
- `VideoProject.swift`: `.palmier` package loads timeline JSON, media manifest, generation log, thumbnail, chat sessions: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/Sources/PalmierPro/Project/VideoProject.swift#L27-L123
- `ToolDefinitions.swift`: MCP/tool surface, including timeline/media/mutation/generation/search/color/export/project tools: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/Sources/PalmierPro/Agent/Tools/ToolDefinitions.swift#L4-L120
- `ToolExecutor.swift`: shared executor for MCP and in-app agent, agent-scoped undo stack: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/Sources/PalmierPro/Agent/Tools/ToolExecutor.swift#L5-L150
- `MCPService.swift` and `MCPHTTPServer.swift`: HTTP MCP server on loopback: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/Sources/PalmierPro/Agent/MCP/MCPService.swift#L4-L94
- `AgentInstructions.swift`: product-specific agent operating contract: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/Sources/PalmierPro/Agent/Tools/AgentInstructions.swift#L3-L214
- `ExportService.swift`: AVAssetExportSession export path plus XML/FCPXML branch: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/Sources/PalmierPro/Export/ExportService.swift#L32-L249
- `CompositionBuilder.swift`: AVMutableComposition builder from Palmier timeline: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/Sources/PalmierPro/Preview/CompositionBuilder.swift#L26-L240
- `CustomVideoCompositor.swift`: shared preview/export Core Image compositor: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/Sources/PalmierPro/Compositing/CustomVideoCompositor.swift#L5-L85
- `SkillStore.swift`: first-party skill installation into `~/.palmier/skills` and external-agent skill directories: https://github.com/palmier-io/palmier-pro/blob/4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec/Sources/PalmierPro/Agent/Skills/SkillStore.swift#L5-L53

Key vean code references:

- [README.md](/Users/tejas/Github/vean/README.md:5): typed document, edit algebra, diagnostics layer on MLT.
- [README.md](/Users/tejas/Github/vean/README.md:49): four-layer architecture and action/runtime/LSP/app split.
- [ROADMAP.md](/Users/tejas/Github/vean/ROADMAP.md:19): Move 0 document core and MLT round-trip/render gates.
- [ROADMAP.md](/Users/tejas/Github/vean/ROADMAP.md:105): Move 1 edit algebra and diagnostics.
- [ROADMAP.md](/Users/tejas/Github/vean/ROADMAP.md:192): Move 2 ambient LSP and bridge.
- [ROADMAP.md](/Users/tejas/Github/vean/ROADMAP.md:293): Move 3 action runtime/project ergonomics.
- [ROADMAP.md](/Users/tejas/Github/vean/ROADMAP.md:532): Move 4 local Mac app status.
- [src/ir/types.ts](/Users/tejas/Github/vean/src/ir/types.ts:1): rational time, stable identity, MLT-shaped IR.
- [src/ops/catalog.ts](/Users/tejas/Github/vean/src/ops/catalog.ts:53): 22 public op descriptors currently visible in the catalog.
- [src/diagnostics/index.ts](/Users/tejas/Github/vean/src/diagnostics/index.ts:1): shared pure diagnostics engine.
- [src/actions/registry.ts](/Users/tejas/Github/vean/src/actions/registry.ts:432): timeline apply/preview/undo actions.
- [src/bridge/mcp/server.ts](/Users/tejas/Github/vean/src/bridge/mcp/server.ts:1): MCP generated from action registry.

## Where They Are Convergent

### Same product thesis

Both systems reject "AI as a sidebar that emits suggestions." The agent edits the real timeline. Palmier says the app lets Claude/Codex edit directly by trimming, reordering, and generating footage. vean says human gestures and agent actions should be the same operations, updating the same document and receiving the same undo/diagnostic path.

### Same local-first editor shape, but different center of gravity

Palmier is a local Mac editor with MCP exposed from the running app. vean is a local core/action runtime with a Mac app as one adapter. Both avoid a web editor as the primary surface.

### Same desire for agent-readable state

Palmier's `get_timeline` returns fps, resolution, tracks, clips, IDs, and generation capability. `get_media` returns project media IDs and generation status. `get_transcript`, `inspect_media`, `inspect_timeline`, and `search_media` are all explicit context APIs. vean's corresponding theory is `vean-lsp`, `diagnose`, `resolve-value-at-frame`, `find-references`, media catalog actions, and action discovery.

### Same direction on skills

Palmier has productized skills: app settings fetch a catalog and install skills into `~/.palmier/skills`, with external skill directories for Claude/Codex/Cursor. vean already has repo skills and a resolver, but Palmier is ahead on making skills a user-facing product capability.

## Core Divergences

### 1. Product-first vs compiler/runtime-first

Palmier is product-first. It has a native UI, timeline tools, media import/generation, in-app agent, and concrete workflows today. Most of its architecture is in service of making a usable Mac app.

vean is compiler/runtime-first. The central artifact is a typed `.mlt` document and operation/diagnostic runtime that multiple surfaces project. The UI must remain an adapter over action IDs, not a second implementation.

Impact:

- Palmier wins user value immediately.
- vean wins if third-party/editor/agent workflows need exact, inspectable semantics outside one app.

### 2. Canonical timeline format

Palmier stores its canonical timeline as Codable Swift structs serialized as JSON inside a `.palmier` package. It exports XML/FCPXML for NLE interchange, but the internal project is the source of truth.

vean stores canonical placement in `.mlt` XML. It parses and serializes MLT losslessly, with round-trip and render-faithfulness gates. The local SQLite DB is explicitly not canonical edit state.

Impact:

- Palmier can evolve fast without preserving external weirdness.
- vean is better positioned for git diffs, external NLE interop, Shotcut/Kdenlive compatibility, and "agent edits a text document" workflows.
- Palmier's export XML is likely a delivery bridge; vean's `.mlt` is the spine.

### 3. Time model

Palmier's `Timeline` has `fps: Int`. It supports common integer rates and has XML timecode tests, including NTSC-ish export handling, but the core type is not rational fps.

vean's IR requires `fps: [num, den]`; 29.97 is `[30000,1001]`. This is an explicit invariant because diagnostics and frame math become subtly wrong with float/int approximations.

Impact:

- Palmier is simpler and probably fine for a large share of social/AI-video workflows.
- vean is better for professional interchange, broadcast-ish timelines, and anything where exact 23.976/29.97 frame math matters.

### 4. Renderer stack

Palmier owns preview/export through AVFoundation:

- `CompositionBuilder` builds `AVMutableComposition`.
- `ExportService` uses `AVAssetExportSession`.
- `CustomVideoCompositor` uses Core Image/Metal and is shared by preview/export.

vean deliberately does not become a renderer:

- MLT/FFmpeg render as subprocess sidecars.
- Remotion is a producer: render alpha clips for export and use `@remotion/player` for live preview.

Impact:

- Palmier likely has smoother native preview/export integration and fewer subprocess edges.
- vean gets existing MLT semantics and broader format/interchange depth, but inherits sidecar packaging and MLT behavior.
- Palmier is Apple-only; vean core is TypeScript/MLT/Bun and can run headless outside the app.

### 5. Agent feedback model

Palmier's agent loop is tool-call oriented. The agent reads `get_timeline`, calls mutation tools, inspects media/timeline/transcripts, and optionally calls `undo`. The tool instructions explicitly say not to re-read between own edits unless stale.

vean's agent loop is LSP-like. The LSP publishes diagnostics after document changes. `diagnose` is not the safety loop; it is debug/CI/manual inspection. Mutating tools return consequences/inverse/touched URIs and only mutation-local blocking alerts.

Impact:

- Palmier is more immediately understandable to MCP clients and works with generic chat tools.
- vean is more like TypeScript/Pyright/rust-analyzer for video: ambient errors, navigation, references, hovers, and code actions.
- Palmier does not appear to have a standing full diagnostic set or compiler-like validity model; invalid states are mostly prevented/rejected by tool implementations or export/build validation.

### 6. Edit algebra and undo

Palmier has tool implementations that mutate an `EditorViewModel` and use the app's `UndoManager`. It tracks an `agentUndoStack` so the assistant refuses to undo user edits. That is a good product detail.

vean has explicit pure operations: `op(state) -> { state', consequences, inverse }`. The op catalog currently lists 22 public descriptors: append, split, insert, overwrite, lift, remove, replace, trim in/out, slip, slide, move, roll, dissolve, fades, gain, filters, tracks, cross-track transitions.

Impact:

- Palmier's undo is ergonomic in the native app.
- vean's undo/inverse is portable across CLI/MCP/LSP/app, testable independent of UI state, and easier for agents to reason about before rendering.

### 7. Media intelligence

Palmier is much further ahead on agent-useful media intelligence:

- `inspect_media`: frames, EXIF/dimensions, video/audio transcript, word timestamps, overview/storyboard.
- `get_transcript`: post-edit timeline transcript in project frames.
- `remove_words`: transcript-driven cut primitive.
- `search_media`: semantic visual and spoken search.
- `inspect_timeline`: composited rendered frames from the actual cut.
- `sync_audio`: waveform-based sync.

vean currently has lightweight media cataloging, routes, probing, and add-footage/add-audio actions. Its roadmap explicitly leaves transcription, semantic labels, embeddings, waveform analysis, proxies, and watching as future action families.

Impact:

- Palmier is much better for "edit this real footage" agent tasks today.
- vean has the right action/runtime substrate, but its media layer is still shallow.

### 8. Generative AI posture

Palmier makes generation central. Its site and tools cover generating video/images/audio, upscaling, model lists, references, prompt workflows, background generated asset lifecycle, and subscriptions/credits. The editor and MCP are open-source; generative processing is closed-source and paid.

vean does not currently center hosted generative media. Its "AI-native" posture is about agent-authored deterministic edits and Remotion/procedural graphics as producers. Network calls/secrets are out of core.

Impact:

- Palmier is closer to the current AI-video market pull: generate, regenerate, organize takes, edit.
- vean is more durable as an agent-native editing substrate, but may feel less magical until media generation/import workflows exist around it.

### 9. Platform and distribution

Palmier requires macOS 26 on Apple Silicon. It is Swift 6.2, SwiftUI/AppKit, AVFoundation, non-sandboxed Developer ID. Its CI runs on macOS 26.

vean's source/CLI path is TypeScript/Bun with MLT/FFmpeg system dependencies; the Mac app can bundle sidecars, but the core is not inherently Apple-only.

Impact:

- Palmier can use native Mac APIs aggressively and ship a polished app.
- vean can support headless/CLI/agent workflows on more machines and can be used in CI or server-like editing pipelines.

### 10. Licensing and commercial boundary

Palmier Pro is GPLv3, with closed-source generative processing. Palmier links Apple/platform frameworks and normal app dependencies. GPL is acceptable because the app is the product.

vean is AGPL-by-choice and extremely careful not to link GPL media libraries: it drives MLT/FFmpeg as subprocesses and may bundle sidecars in the app with provenance. The repo also preserves CLA/dual-license optionality.

Impact:

- Palmier is simpler legally for a standalone GPL app, but less flexible for proprietary embedders.
- vean's boundary discipline is more valuable if the long-term product is a core/runtime that others may embed or build around.

## What Palmier Is Doing Better

### 1. Shipping a coherent user-facing product

Palmier has a visible Mac app and a short setup path. Open app, connect MCP, edit. Their README includes install commands for Claude Code, Codex, Cursor, and Claude Desktop MCPB. vean has the deeper architecture, but user value is still mediated by CLI/app scaffolding and project setup.

### 2. Treating generation as a timeline primitive

Palmier tracks prompts/models/references and drops generated assets directly into the timeline. This directly addresses a painful creator loop: generate on web, download, import, replace, repeat.

vean's Remotion producer is strong for graphics, but it does not yet solve "AI clip generation and take management live inside the edit."

### 3. Rich agent context tools

Palmier's context surface is excellent for real agent editing. `get_transcript` returns actual audible post-edit words. `inspect_timeline` answers "what does the cut look like?" rather than making the agent infer from JSON. `search_media` turns local footage into an addressable semantic corpus.

vean should treat this as a concrete target, not an optional later luxury.

### 4. Tool descriptions encode workflow wisdom

Palmier's tool descriptions and `AgentInstructions` are unusually specific. They tell the agent when to use layout vs property edits, how to handle generation costs, when to inspect media, how to cut transcript words, how to work with languages, and when to send feedback.

vean has strong skills and action metadata, but Palmier's descriptions are closer to "agent product UX": they encode editing taste, not only schema.

### 5. Agent-scoped undo respects human edits

Palmier's `agentUndoStack` refuses to undo the user's own edits. This is small but important in a collaborative human-agent editor.

vean has portable inverse ops, but should still implement user/agent authorship boundaries in the app/session layer.

### 6. Skills as a product primitive

Palmier has a separate `palmier-skills` repo, app-side catalog fetch, local install into `~/.palmier/skills`, and bridges to Claude/Codex/Cursor skill directories. That is a more accessible product model than repo-local skill shims alone.

### 7. Native preview/export parity

Palmier shares the compositor path between preview and export. That reduces "preview looked different from export" risk within its AVFoundation feature envelope.

vean explicitly accepts two compositing paths for Remotion live preview vs MLT export. That is architecturally honest, but a UX liability unless proof tooling makes mismatches visible.

## What vean Is Doing Better

### 1. Canonical edit state is an interoperable text document

vean's `.mlt` spine is the biggest technical moat. It makes the timeline inspectable, diffable, round-trippable, and compatible with existing MLT-based editors. Palmier's `.palmier` JSON is readable, but it is Palmier's own format; external NLE XML is an export path.

### 2. Determinism and golden gates are much stronger

vean has documented gates for deterministic serialization, corpus round-trips, render-faithfulness via `melt`, XML namespace validity, keyframe round-trip, diagnostics harnesses, and op-inverse invariants. Palmier has a sizeable test suite, but the inspected architecture does not expose the same format-contract rigor.

### 3. Rational time and pro-format correctness

vean's rational fps invariant is the right foundation for 23.976/29.97 and professional timecode correctness. Palmier's `fps: Int` is simpler, but it is a real limitation if the system wants to become a general video editing substrate.

### 4. Pure edit algebra

vean's pure operation model is more agent-native at the semantic layer. Every operation returns consequences and inverse, and the action bridge can expose previews without mutating the document. Palmier's tools are practical but tied to app mutation and `UndoManager`.

### 5. Ambient diagnostics

vean's LSP model is a major divergence. A video editor that behaves like a language server can support editors, agents, CI, code actions, hovers, references, and continuous validity feedback. Palmier's tools mostly prevent or reject invalid operations; they do not provide the same compiler-like document health contract.

### 6. Action registry and policy metadata

vean's actions declare scopes, effects, mutates, destructive/open-world status, idempotency, reversibility, dry-run support, approval, audit, and job semantics. MCP/Tauri/CLI projections are meant to derive from that. Palmier's MCP tools are rich, but the inspected code does not show equivalent load-bearing effect metadata.

### 7. GPL boundary discipline

vean's subprocess-only renderer boundary is more painful but more reusable. Palmier is a GPL app; vean is trying to be a core/runtime with optional app packaging and future dual-license room.

### 8. Surface consistency by construction

vean's app/CLI/MCP/LSP all project from the action runtime. Palmier shares tools between MCP and in-app agent, but the UI/editing code and MCP tools are app-integrated rather than projected from a single formal action/effect registry.

## What Palmier May Be Doing Worse or Carrying Risk On

### Internal format risk

The `.palmier` JSON package is fine for product speed, but it means Palmier owns all interoperability. XML/FCPXML export is not the same as lossless canonical compatibility. If users want to round-trip with Premiere/DaVinci/Shotcut/Kdenlive, Palmier has to keep expanding exporters/importers.

### Apple API lock-in

AVFoundation/Core Image/Metal is excellent for a Mac app. It is not a portable editing core. Palmier's repo states macOS 26 Apple Silicon only. That is a strategic commitment.

### No apparent compiler/diagnostics layer

Palmier has validations and tests, but I did not find a shared full-set diagnostics engine like `collectDiagnostics(state)` or an ambient LSP-like surface. Agents rely on tools, inspections, and export/build failures. That is good enough for many product tasks but weaker for robust autonomous editing.

### Generation-centric business could distort editing primitives

Palmier's strongest wedge is AI video generation. That is commercially sensible, but it may bias the product toward AI-generated clip workflows and away from deep NLE correctness. Their FAQ explicitly says without AI features it is bare-bone and lacks transitions, masking, graphics.

### Tool surface breadth may outrun formal semantics

Palmier's MCP tool surface is large and useful, but many tools encode behavior in descriptions and imperative implementation. Without formal operation descriptors/effects/inverses, cross-surface guarantees become harder as the product grows.

### Privacy/network surface

Palmier includes Clerk, Convex, Sentry, hosted generation, skill catalog fetches, and feedback tooling. That is normal for a commercial app, but very different from vean's current "core has no network/secrets" boundary.

## What vean May Be Doing Worse or Carrying Risk On

### Product velocity and visceral UX

Palmier has the visible thing users can try. vean's architecture is stronger, but users and agents judge by "can I open footage, ask for a cut, inspect result, export?" Palmier is ahead.

### Media understanding gap

vean's current media catalog is lightweight. Palmier has on-device transcript, word cuts, semantic visual/spoken search, media inspection, composited timeline inspection, and waveform sync. This is the biggest feature gap.

### Too much structure before task-specific taste

vean has action metadata and operation descriptors. Palmier has product-specific agent instructions that encode the editor's intended workflow. vean should avoid making agents assemble low-level ops when a higher-level workflow primitive is the natural user task.

### Two preview/export paths for Remotion

vean's Remotion seam is correct, but it has an unavoidable parity risk: browser live preview overlaid on footage and MLT export via prerendered alpha clip can diverge. Palmier's shared native compositor has less of that problem inside its supported feature set.

### Setup and trust friction

Palmier's MCP setup is a one-liner from the app. vean's setup is more powerful but more complex: Bun, MLT/FFmpeg, `.lsp.json`, `.mcp.json`, project DB, route aliases, app sidecars, skills. The Mac app must hide that without violating trust boundaries.

## Feature-by-Feature Comparison

| Axis | Palmier Pro | vean | Practical read |
|---|---|---|---|
| Primary artifact | `.palmier` package with JSON timeline, media manifest, generation log | `.mlt` XML timeline plus gitignored `.vean/vean.db` for product state | Palmier optimizes product evolution; vean optimizes interoperability/determinism |
| Core platform | Swift 6.2, SwiftUI/AppKit, AVFoundation, macOS 26 Apple Silicon | TypeScript/Bun core, MLT/FFmpeg subprocesses, Tauri Mac app | Palmier is native app; vean is portable/headless core plus app |
| Render/export | AVMutableComposition, AVAssetExportSession, Core Image/Metal compositor | `melt`/FFmpeg sidecars; Remotion alpha producers | Palmier tighter native loop; vean richer MLT interop |
| Agent surface | HTTP MCP from app, in-app agent, rich tool set | stdio MCP generated from action registry, ambient LSP, CLI | Palmier easier to try; vean more compiler-like |
| Timeline mutations | App tools + UndoManager | Pure ops with consequences/inverse | Palmier ergonomic; vean formally composable |
| Diagnostics | Validation/rejection/export errors; no found full-set LSP diagnostics | Shared pure diagnostics engine + LSP publishDiagnostics | vean stronger correctness model |
| Media intelligence | Inspect media/timeline, transcripts, word cuts, semantic search, waveform sync | Probe/catalog/list/find; transcription/search future | Palmier far ahead |
| AI generation | Central, closed processing, paid credits/subscription | Not central; Remotion/procedural graphics | Palmier market-ready for AI video |
| Skills | Productized catalog + local install | Repo/project skills and resolver | Palmier ahead as user-facing skill UX |
| Licensing | GPLv3 app, closed generation processing | AGPL core, CLA, subprocess-only GPL renderer boundary | vean more reusable as substrate |

## Specific Palmier Ideas Worth Stealing

1. Add a first-class `inspectTimeline` action that returns composited stills/storyboards for project frames. vean has render/still, but Palmier's framing as "what the user actually sees" is the right agent primitive.

2. Make timeline transcript a first-class query: post-edit words in timeline frames, not raw source transcript. Pair it with `removeWords`/word-range operations.

3. Add semantic media search as an action family, even if the first backend is simple transcript keyword search plus optional embeddings later.

4. Add agent-scoped undo/session authorship in the app: inverse ops remain canonical, but the UI should know which agent/session authored each undoable mutation and avoid undoing human edits.

5. Productize skills: catalog, install/update UI, local folder, and host-specific sync. vean already has the skill philosophy; Palmier shows the product wrapper.

6. Add project navigation MCP tools. Palmier just added `get_projects`, `open_project`, and `new_project`; vean has project actions but should make them as obvious to agents as timeline ops.

7. Write higher-level workflow tools around common edits. Palmier's `apply_layout`, `remove_words`, `sync_audio`, `apply_color`, and `inspect_color` are not just atomic editing primitives; they are task-shaped affordances.

8. Make generated/imported assets asynchronous with explicit status. Even without hosted generation, vean's proxy/transcribe/render/import jobs should expose the same placeholder/status lifecycle.

9. Invest in tool descriptions as product design. Palmier's descriptions teach the model how to behave. vean action descriptors should include task-specific judgement, not only schemas and safety metadata.

10. Include "send feedback" or structured limitation-reporting for agent sessions. Palmier's version is commercial telemetry; vean could keep it local as an artifact/issue suggestion.

## Things vean Should Not Copy

1. Do not make an app-internal JSON package the canonical timeline. That would erase vean's strongest architectural bet.

2. Do not abandon rational fps for product simplicity. Palmier's `Int` fps is a useful warning, not a model to follow.

3. Do not make the app the source of truth for editing semantics. Palmier can because it is an app; vean's value is the shared runtime.

4. Do not link media/rendering libraries directly just for native smoothness. vean's GPL boundary is a deliberate product/legal advantage.

5. Do not make generation cloud/vendor coupling a core dependency. It can be an adapter/job family, but not the core.

6. Do not replace ambient diagnostics with "call diagnose after every edit." Palmier's tool loop is good MCP UX; vean's LSP loop is a deeper differentiator.

## Strategic Positioning

Palmier is "Premiere/CapCut for the AI-video era." It is the end-user app where generation, editing, and agent operation are one workspace.

vean should be "the language server and edit runtime for video." The app can and should feel product-complete, but the moat is that every edit is a typed, reversible, diagnosable document operation over an interoperable timeline.

That positioning matters because copying Palmier feature-for-feature would pull vean toward being a second Mac-only AI editor. The better response is to use Palmier as proof of the user workflow, then build the deeper substrate they do not appear to have.

## Recommended Next Moves for vean

1. Close the media-intelligence gap first. Add transcript and timeline-inspection actions before more low-level op breadth.

2. Add high-level task actions that compile to the existing op algebra: `removeWords`, `duckMusicUnderSpeech`, `addBrollOverRange`, `applyLayout`, `syncAudio`, `captionTimeline`.

3. Add an app-visible skills catalog and install/update flow, backed by repo-local or user-local skills and projected to Codex/Claude.

4. Make `project.list/current/use/new` and `timeline.new/addFootage/addAudio` prominent in MCP discovery, not hidden behind generic action discovery.

5. Build a Palmier-style "first successful edit" demo: open project, import footage, read transcript, remove dead air, add lower third, render still/video, show before/after.

6. Keep `.mlt` as the spine and lean into that contrast publicly: Palmier is a great AI editor; vean is the agent-native editing core that can power editors, agents, CI, and interoperable project files.

## Unknowns / Open Questions

- I did not run Palmier because it requires macOS 26/Tahoe on Apple Silicon and this research did not need live UI behavior.
- I did not verify Palmier's XML/FCPXML exports against Premiere/DaVinci/Shotcut; code and tests indicate meaningful coverage, but not semantic round-trip fidelity.
- I did not audit Palmier's actual generation backend because it is closed-source by their own README/FAQ.
- I did not inspect every Palmier tool implementation in detail; the comparison is architecture/product-surface-level with spot checks of core files.
- Palmier's public repo is moving fast. The code references here are pinned to commit `4e76f039ad3c07ed072b8adfe5fdd1bfb8f824ec`.

