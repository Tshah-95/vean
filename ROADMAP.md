# vean roadmap

Markdown-first plan of record. Each **Move** is a phase that lands behind a
**verification gate** — nothing stacks on an unverified phase. Moves run as one
multi-agent workflow each (decompose → parallel build → adversarial verify →
synthesize), with a human gate-check between phases. Check boxes as they land.

The shape of the whole thing: **Moves 0–2 are the headless spine** (well-specified,
mostly agent-buildable — the answer key is Shotcut's source + the MLT clone).
**Move 3 is the product runtime spine**: one typed action registry, a complete
Commander CLI, project/media ergonomics, and shared permission/effect metadata
that all surfaces consume. Its contract lives in [DESIGN-MOVE3.md](DESIGN-MOVE3.md).
**Move 4 is the local Mac app**: Tauri, bundled media sidecars, project UI, and
the same action runtime behind every button. **Move 5** unifies Remotion as a
producer. **Move 6+** is the parallelizable breadth.

---

## Move 0 — the document core (the spine)

Lock a typed, frame-exact representation of an MLT timeline that round-trips
losslessly to `.mlt` and renders faithfully. This is the "infrastructure works
exactly as we want" gate; everything stacks on it.

- [x] Port studio's `src/mlt` (types, builder, serialize, profile) as the seed;
      **strip the `@/brand` coupling** — colors become plain hex/named, no palette.
- [x] Extend the IR: multiple video + audio tracks (`tractor` of `playlist`s);
      explicit audio clips + gain + A/V link; first-class filters & transitions
      (not just dissolve); a real keyframe model.
- [x] Keyframe model + animation-string parser/serializer — round-trips MLT's
      `"0=100;50~=0"` strings byte-faithfully (full marker table: `|` hold, `~`
      smooth, `$`/`-` natural/tight, Penner easings; `%`÷100; negative/relative
      frames; rect/color component-wise; re-base to `in`; `LC_NUMERIC` `.`-decimal).
      <!-- markers, %, negative/relative frames, rect/color all round-trip
           (tests/adversarial); a comma-decimal INSIDE an animation string is now
           migrated to dot on parse (normalizeAnimDecimals), closing the
           LC_NUMERIC defect. See GATE.md. -->
- [x] Serializer: deterministic IR → `.mlt` (two-pass defs-before-refs, inclusive
      0-based in/out, `<blank length>` gaps, `a_track`/`b_track` integer indices,
      nested-tractor dissolve, `LC_NUMERIC`). Same IR → byte-identical XML.
- [x] Parser: `.mlt` → IR (reads Shotcut-saved files; normalizes like Shotcut's
      `MltXmlChecker` — decimal separators, relative paths, version guard).
- [x] Assemble the test corpus in `corpus/`: a few hand-authored `.mlt`, studio's
      own emissions, and a couple saved out of Shotcut.
- [x] `melt`/ffmpeg driver: headless render + single-frame grab + contact sheet.

**Gate (all green):**
- [x] Round-trip golden: every corpus file → IR → serialize → **semantically
      equal** (byte-identical for our own emissions). <!-- 10/10 fixpoint; the 2
      vean emissions byte-identical (corpus-golden.test.ts). -->
- [x] Render-faithfulness: `melt` renders the re-emitted XML; still-frame
      hashes/SSIM match rendering the original XML (within tolerance). <!-- verify:corpus
      OVERALL PASS — 10/10; SSIM 1.0000 on EVERY sampled frame of all 10 files
      (the round-1 0.9997 on shotcut-dissolve is gone — now pixel-identical). -->
- [x] Shotcut-openability (XML namespace validity): every corpus file AND every
      fresh serializer emission is namespace-clean under a strict reader.
      <!-- ENFORCED by the new `bun run lint:xml` gate (scripts/lint-xml.ts):
           `xmllint --noout --nsclean` over all 10 corpus/*.mlt + the 2 fresh
           vean-fixtures emissions → OVERALL PASS 12/12; also folded into
           verify:corpus as GATE 0 ("xml: PASS — 12/12 namespace-clean") before
           any melt render. ROOT-CAUSE FIX: vean used to emit shotcut:filter /
           shotcut:transition as NAMESPACED XML ATTRIBUTES with no xmlns
           declaration — melt rendered fine (namespace-lenient) but Shotcut's
           strict QXmlStreamReader REFUSED TO OPEN the file ("Namespace prefix
           shotcut … is not defined"). Now emitted as <property> children (the
           form genuine Shotcut writes); no element carries a namespaced
           attribute. Guarded by tests/xml-namespace.test.ts (structural scan +
           negative test + authoritative xmllint check). A follow-up adversarial
           sweep then found + FIXED one high round-trip defect on the new shape:
           a COMBINED fadeIn+fadeOut on a windowed (in>0) clip used to lose its
           0-based wrapper tractor on re-emit (parser only inverted 2-keyframe
           single-direction fades); fadeFromKeyframes now recovers the 4-keyframe
           combined shape into BOTH sentinels — byte-identical round-trip, 3
           regression tests in adversarial.test.ts. See GATE.md. -->
- [x] Keyframe round-trip: parse → typed model → serialize is identical (golden).
      <!-- the 3 original adversarial defects are FIXED and their KNOWN DEFECT
           tests flipped: (1) comma-decimal inside an animation string is migrated
           to dot on parse (normalizeAnimDecimals), so melt renders 0.2→0.8 not
           0→0; (2) producer-level shotcut:caption/eof/aspect_ratio preserved via
           clip.extraProps; (3) an empty animation property round-trips to empty
           (no fabricated "0"). A follow-up completeness hunt then found + fixed 3
           SIBLING lossy round-trips of the SAME class at other levels: playlist
           props (Track.extraProps), main-tractor props (Timeline.tractorProps),
           and a transition in/out attr+property double-emit (in/out now excluded
           from the property map). Round-trip is lossless at every level. See
           GATE.md. NOTE: 5 LOW/latent keyframes.ts contract gaps remain open
           (timecode :FF spelling, empty-value "0=", quoted-value throw, ms drift)
           — parseAnim/serializeAnim are NOT yet on the document path (it passes
           anim strings verbatim), so they cannot mis-render today; they get fixed
           when Move 1's edit algebra becomes their first consumer. -->
- [x] `bun run test` green; `bun run typecheck` clean. <!-- 185 tests / 11 files
      pass (+10 over round-2's 175: 7 namespace/Shotcut-openability tests in
      tests/xml-namespace.test.ts + strengthened adversarial/serialize/parse
      cases, and 3 combined-fade round-trip regressions); tsc --noEmit clean;
      biome check clean (27 files). Plus the Shotcut-openability gate:
      `bun run lint:xml` → PASS 12/12. -->
- [ ] Human spot-check: open a re-emitted `.mlt` in Shotcut, confirm it looks right.
      <!-- awaiting Tejas: open corpus/vean-multitrack.mlt in Shotcut (see GATE.md).
           The namespaced-attribute defect that made Shotcut REFUSE TO OPEN vean
           files is now fixed and machine-gated (lint:xml); this box stays
           UNCHECKED until Tejas confirms the actual GUI open separately. -->

---

## Move 1 — the edit algebra + diagnostics engine (headless) ✅ COMPLETE

The verbs and the shared diagnostic core. A closed set of pure operations plus a
static diagnostics engine that can be reused by LSP, MCP, CLI, tests, and the
future UI. The diagnostics engine is not itself the agent loop; it is the domain
checker every surface calls.

**Status: complete** (Move 1a + 1b, gated in `GATE-MOVE1A.md` / `GATE-MOVE1B.md`).
The two remaining unchecked boxes below are *not* Move-1 deliverables: the
end-to-end stitched script is Move 2's bridge deliverable (its pieces — edit,
diagnose, the melt driver — all exist), and the Shotcut human spot-check needs
Tejas at the GUI. Every agent-completable item is done; all six gates green,
diagnostics zero-false-positive on the corpus, resolve/refs render-faithful.

- [x] **(Move 1a)** Edit algebra as pure functions: `op(state) → {state',
      consequences, inverse}`. Mined the taxonomy from Shotcut `src/commands/`:
      append, insert, overwrite, lift, remove (ripple), trim in/out, split, move,
      dissolve (add-transition), fades, gain, add/remove filter, add/remove track —
      **18 public ops**, all implemented + UUID-keyed identity; the only mutation
      path is `apply(op)`. Integrity hardened: cross-track ripple never shreds
      other-track content (reports a `ripple-blocked` warning instead); straddling
      overwrite + mid-clip insert invert exactly; positional helpers count a
      dissolve overlap once; dissolve-corrupting edits and cross-kind moves return
      typed `EditError`s (never throw, never an unserializable state). See
      `GATE-MOVE1A.md`. (Diagnostics/resolve/refs below remain Move 1b.)
- [x] **(Move 1b)** Tier-1 (static) diagnostics ENGINE — the shared core in
      `src/diagnostics/` (`collectDiagnostics(state)` → the FULL current set,
      LSP-ready; pure, document-keyed). The in-IR-computable rules are LIVE:
      in/out beyond source length, keyframes outside clip bounds, orphaned filters,
      dissolve overlap exceeds neighbour, structurally-dangling resource. The rules
      needing I/O (dangling FILE ref, upscaling >100%, colorspace mismatch) or a
      future IR addition (asymmetric A/V trim, fps-mismatch judder, dial ranges) are
      FINALIZED-signature checker stubs (`checks/{sync,media}.ts`) with `// TODO`
      markers, each additive and held to the zero-false-positive bar. The registry
      auto-covers new checkers. <!-- gaps/overlaps are structurally impossible in
      the ordered-IR (gaps are explicit blanks, overlaps are dissolves), so that
      rule is a no-op until the IR admits absolute positions. -->
- [x] **(Move 1b)** `resolveValueAtFrame` (src/query/resolve.ts): the effective
      value of a param at a frame, resolved through the nested scope chain (clip
      keyframes → track filters → tractor filters → transition) + the resolution
      PATH (which scope produced it). Full grammar: markers (discrete/linear/
      Catmull-Rom smooth/Penner≈linear), %, rect + color component-wise, negative/
      relative + timecode. The keyframe engine's `valueAtFrame` evaluator is its
      core. (Track/tractor filters aren't first-class IR yet, so the resolver walks
      + NAMES those scopes but they don't contribute until the IR grows them.) A
      clip's fade anchors on its RENDERED span (playtime minus adjacent-dissolve
      trim), not its source playtime — so a dissolve-headed clip's fadeOut lands on
      the frames melt actually fades (pixel-verified against the corpus render),
      not `trimHead` frames late past the end of the timeline. See `GATE-MOVE1B.md`.
- [x] **(Move 1b)** `findReferences` (src/query/references.ts): clips using a
      source; readers/writers of a property (with the animated flag); a clip's
      adjacency/ripple set (same-track neighbours + cross-track reach under ripple).
- [x] **(Move 1b)** CLI/debug surface: `edit` (1a), `diagnose`, `resolve`, `refs`
      (1b — `scripts/{diagnose,resolve,refs}.ts`, wired in package.json). `diagnose`
      is framed as a DEBUG/CI/manual-inspection verb (exit 1 on any error = a CI
      gate); it is **not** the required feedback step after ordinary Claude Code
      edits — that ambient loop is the `vean-lsp` push in Move 2.

**Gate:**
- [x] **(Move 1a)** Op-inverse invariant suite: `apply(op)` then `apply(inverse)`
      returns the original IR (undo correctness) — registry-driven across EVERY
      public op (purity + apply→inverse deep-equal + serialize Shotcut-clean +
      round-trip fixpoint per sample). 18/18 public ops covered, 0 pending/skipped.
- [x] **(Move 1b)** Diagnostics fixtures: broken timelines emit the **exact**
      expected diagnostic (`tests/diagnostics-checks.test.ts` — each rule fires with
      the exact code + severity); clean timelines emit **zero**
      (`tests/diagnostics-harness.test.ts` — registry-driven SILENCE over EVERY
      committed corpus file, per-checker, auto-covering checkers as they land — the
      no-false-positive gate). 53 tests.
- [x] **(Move 1b)** `resolve` / `refs` golden tests on known timelines
      (`tests/query.test.ts` — 25 tests against the corpus: the V1 brightness fade
      ~0→~1, the marked brightness ramp, the affine rect component-wise, the field
      transition, and the source/property/adjacency reference sets). Plus the CLI
      smoke tests (`tests/cli-lsp.test.ts` — 10 tests).
- [ ] End-to-end script: load → apply N ops → diagnostics engine reports clean →
      render → still. <!-- the pieces exist (edit + diagnose + the melt driver);
      the single stitched-together script lands with the Move 2 bridge, which is
      where the op→ambient-diagnostics→render loop is the actual deliverable. -->
- [x] **(Move 1b)** The 3 deferred items from Move 1a closed: the 5 keyframe-engine
      gaps (timecode `:ff` subform, the opaque-value family, name-keyed fade
      detection — `keyframes.ts`), `Clip.id` routed through `shotcut:uuid` (identity
      survives the round-trip; goldens re-blessed), and the animated escape-hatch
      filter window re-base across trim/split (`shiftAnimWindow` shared by both).
      See `GATE-MOVE1B.md`.

---

## Move 2 — ambient LSP + diagnostic-aware agent bridge ✅ COMPLETE

Make editing video feel like editing code with a language server: Claude should
see timeline errors after changes without being instructed to call a separate
diagnose tool, while domain tools still expose consequences and undo.

**Status: complete** (gated in `GATE-MOVE2.md`, designed in `DESIGN-MOVE2.md`).
The bridge is a surface OVER the shared core (it calls `src/diagnostics`,
`src/query`, `src/ops`, `src/driver`; reimplements no rule). All four completion
criteria met and every gate green. Two cross-surface defects of the same root-cause
family (a positionless color-clip window must serialize 0-based) were fixed at root
cause in the edit algebra — split-of-a-color-clip (found during build) and
trim-of-a-color-clip whose inverse broke across the persist round-trip (found at
gate time, C3) — each regression-locked at the edit-algebra layer AND over the
bridge wire, with the Move-1 op-invariants gate re-verified green (221/221).

- [x] Ship `vean-lsp` over stdio with document sync for project documents (`.mlt`),
      `publishDiagnostics`, definitions/references/hover for clips/assets/
      properties, and code actions for deterministic repairs. <!-- src/bridge/lsp/
      split by feature: engine.ts (analyze: parse + collectDiagnostics → LSP shapes +
      the shared element-locating helpers), navigation.ts (hover/references/definition
      — the READ surface, delegating to src/query resolveValueAtFrame + findReferences;
      hover resolves a clip's fade/animated params to their effective value at the
      clip-start frame, the "go-to-definition for video"), codeActions.ts (the FIX
      surface), server.ts (stdio: TextDocuments full sync; onDidChangeContent →
      publishDiagnostics — the ambient loop; binds the three modules to the JSON-RPC
      handlers). Code actions are WorkspaceEdits over the .mlt text computed from a
      diagnostic's code+data: clamp an out-of-source entry out-point
      (in-out-beyond-source), swap an inverted transition window
      (transition-inverted-window), clamp a transition onto content
      (transition-no-overlap) — each proven to clear its diagnostic on re-analysis
      and over the real wire (request→apply→empty re-publish); repairs needing a
      structural rewrite or a human choice route to the MCP apply-op layer. Diagnostic
      ranges via the additive src/ir/source-map.ts (IR identity → .mlt text span;
      parser untouched, Move-0/1 goldens green). tests/lsp-navigation.test.ts +
      tests/lsp-codeactions.test.ts. -->
- [x] Ship host registration references for `vean-lsp` and `vean-mcp`.
      <!-- The server is a conformant stdio LSP (vean-lsp bin / `bun run lsp`) and
      the MCP server is `vean-mcp` / `bun run mcp`; actual host registration is
      represented for Claude Code by .lsp.json / .mcp.json. The repo-owned durable
      references are package bins/scripts, AGENTS.md, .agents/skills/setup/SKILL.md,
      .agents/skills/editing/SKILL.md, skills/setup, skills/editing, and
      `bun run doctor`. No vean-specific
      polling protocol; an LSP host gets ambient vean diagnostics for free. -->
- [x] Wrap the core as MCP/CLI domain tools: `apply-op`, `preview-op`, `undo`,
      `render`, `still`, `resolve-value-at-frame`, `find-references` (+ `diagnose`
      as the debug verb). Mutating tools return consequences, inverse, touched URIs,
      and optional alerts only when the mutation introduced new blocking errors; no
      standing health snapshot or full
      diagnostic dump. <!-- src/bridge/mcp/server.ts (vean-mcp bin) over the
      transport-free tool core, split by side: tools/mutate.ts (apply/preview/undo +
      the focused mutation-output discipline), tools/read.ts (resolve/refs queries + the
      render/still melt verbs — render/still return `touchedUris` = the produced
      mp4/png the agent inspects next), tools/core.ts (diagnose + ser/de + re-export
      barrel). The ToolResult contract is tools/types.ts; the read-tool result
      shapes live with their handlers in tools/read.ts. CLI: `bun run render` /
      `bun run still` (scripts/render.ts, still.ts — same read-tool core, three
      surfaces). Optional `alerts` are a before/after diff of the SHARED engine,
      filtered to new errors only. Verified: tests/read-tools.test.ts (Node host, fake spawn — the
      argv + touchedUris contract) + `bun run read-tools:artifact` (Bun host, real
      melt — a true PNG/MP4 on disk at the touchedUris path). -->
- [x] Add repo-local product state substrate.
      <!-- `src/state/` owns `.vean/vean.db` via SQLite + Drizzle. Committed
      migrations live in `drizzle/`; `.vean/` is gitignored. CLI commands:
      `state init/status`, `project init`, `jobs list/enqueue/claim/complete/fail`.
      Concurrency posture: WAL, 5s busy_timeout, short lease transactions for
      jobs, no long render/agent work inside DB transactions. -->
- [x] Write the first real skill: the editing method — rely on ambient LSP for
      diagnostics, use MCP tools for domain actions, read consequence reports, and
      run the render→still inspection loop. <!-- .agents/skills/editing/SKILL.md
      is canonical; .claude/skills/editing/SKILL.md and skills/editing/SKILL.md are
      compatibility symlinks. -->
- [x] Seed a fixture project an agent can edit end-to-end. <!-- corpus/
      vean-multitrack.mlt is the seed; `bun run move2:e2e` drives two seeded edits
      through it op→ambient→render→still. -->

**Gate:**
- [x] Ambient feedback eval: an op/document change creates one known timeline
      defect; `vean-lsp` pushes the diagnostic into context without a manual
      `diagnose` call; the fix clears the pushed set. <!-- tests/lsp-ambient.test.ts:
      a didOpen over a real paired JSON-RPC connection publishes in-out-beyond-source;
      a didChange with the fix publishes []. The code action, applied, also clears it.
      tests/lsp-codeactions.test.ts extends this over the wire for the transition
      repairs: a textDocument/codeAction request returns the fix, and applying it as a
      didChange re-publishes the cleared (empty) set. -->
- [x] Tool ergonomics eval: `apply-op` returns consequences, inverse, touched URIs,
      and optional alerts without flooding full diagnostic payloads.
      <!-- tests/mcp-tools.test.ts + bun run move2:e2e: required fields present;
      clean edits have no health snapshot, no diagnostics dump, and no alerts;
      new blocking errors surface in alerts. -->
- [x] Behavioral eval: a natural request ("tighten the gap", "duck the audio")
      maps to the right ops, receives ambient feedback, renders. <!-- the two
      seeded tasks (trimIn to tighten, gain to duck) in move2:e2e — op via tool →
      ambient clean → render → still (a real frame, visually confirmed). -->
- [x] Skill checklist verified on ≥2 seeded tasks; human reviews the stills.
      <!-- bun run move2:e2e PASS 2/2 (trimIn clip-3, gain clip-5); stills produced
      to out/move2-e2e/*.png. Human still-review remains a manual confirmation, as
      with the Move-0/1 Shotcut spot-checks. -->

---

## Move 3 — action runtime + project ergonomics

This is the product-runtime spine. Move 2 proved the individual surfaces work;
Move 3 makes them scale without drift: define an action once, validate it once,
run policy once, and expose it through Commander CLI, MCP, deterministic LSP code
actions, and the future Tauri app.

This is also where vean becomes comfortable as a daily local tool. Project setup,
media routing, active timeline selection, render/still outputs, transcripts,
labels, and job state should stop being repeated shell ceremony. The system
should expose the whole local media world to agents in structured form while
keeping canonical edit state in `.mlt` files.

### 3A. Canonical action registry

- [x] Add `src/actions/` as the single typed runtime above `src/ops`,
      `src/diagnostics`, `src/query`, `src/driver`, and `src/state`.
      `src/ops` remains the pure edit algebra; actions are product behaviors
      such as `timeline.applyOp`, `render.still`, `project.init`, and
      `media.scan`. <!-- Seeded with existing Move-2 timeline/render tools plus
      setup/state/project/job/media/route actions. -->
- [x] Define `ActionDefinition<I, O>` with stable id, title, description, Zod
      input/output schemas, required scopes, effect metadata, surface metadata,
      and an `execute(ctx, input)` handler. Zod remains canonical; JSON Schema
      export for MCP/docs/UI tooling remains future.
- [ ] Define `ActionContext` as dependency injection, not ambient globals:
      project resolver, document store, local state DB, media catalog, driver,
      logger, clock, id factory, cancellation signal, surface name, and policy
      decision.
- [x] Add `executeAction(id, input, ctx)` that validates input, resolves project
      context, applies permission/confirmation policy, opens DB connections
      briefly, executes the handler, validates output, and returns a typed
      success/error envelope. <!-- Seed policy enforces deny/validation and
      carries effect metadata; interactive confirmations remain future. -->
- [x] Move existing tool cores behind actions without changing behavior:
      `apply-op`, `preview-op`, `undo`, `diagnose`, `resolve-value-at-frame`,
      `find-references`, `render`, `still`, `state init/status`, `project init`,
      and `jobs list/enqueue/claim/complete/fail`.
- [x] Preserve the Move-2 tool-output contract: mutating timeline actions return
      consequences, inverse, touched URIs, and only newly introduced blocking
      alerts; the full diagnostic set belongs to ambient LSP or explicit
      `diagnose`. <!-- Covered by tests/cli-actions.test.ts over
      timeline.previewOp. -->

### 3B. Permission, effect, and audit metadata

- [x] Add native vean metadata, then project it down to host-specific concepts.
      MCP annotations and app hints are not the source of truth.
- [x] Scopes: `timeline:read`, `timeline:write`, `media:read`,
      `media:write`, `render:execute`, `state:read`, `state:write`,
      `jobs:read`, `jobs:write`, `fs:read`, `fs:write`, `process:execute`,
      `external:open`.
- [x] Effects: `kind` (`read`, `compute`, `preview`, `create`, `update`,
      `delete`, `render`, `execute`), mutated resources, `openWorld`,
      `destructive`, `idempotency` (`pure`, `idempotent`, `non-idempotent`),
      `reversibility` (`none-needed`, `inverse-op`, `snapshot`, `manual`,
      `irreversible`), `dryRun` (`none`, `supported`, `required`),
      `approval` (`auto`, `ask`, `ask-strong`, `deny`), audit level, and job
      metadata (`inline`/`queued`, cancellable, retry-safe).
- [x] Default policy: auto-allow closed-world reads, compute, and previews; ask
      for timeline/state writes, render/process execution, and queued jobs;
      ask-strong for outside-project filesystem writes, irreversible deletes,
      bulk destructive actions, or open-world effects; deny network effects in
      core actions by default. <!-- src/actions/policy.ts: evaluatePolicy(action,
      ctx, input) computes the level from native effect metadata + context
      (outside-project fs writes escalate to ask-strong); defaultPolicyLevel() is
      the context-free baseline carried on every ActionDescriptor.policy.
      tests/policy.test.ts pins the four tiers + the outside-project escalation.
      Interactive CLI confirmation UX (--yes/--confirm prompts) remains the
      surface-side projection. -->
- [ ] Projection rules:
      - MCP gets `readOnlyHint`, `destructiveHint`, `idempotentHint`, and
        `openWorldHint` derived from the native effect.
      - LSP gets only deterministic, closed-world document edits with no
        subprocess, filesystem, or project-wide side effects.
      - Tauri capabilities are generated from action scopes + window targets.
      - CLI gets consistent `--json`, `--dry-run`, `--yes`/`--confirm`, and
        refusal messages from the same policy layer.

### 3C. Complete Commander CLI

- [x] Keep Commander as the CLI framework. No hand-rolled argument parsing.
- [x] Expose every registered action through the escape hatch:
      `vean action list`, `vean action describe <id>`, and
      `vean action run <id> --input-json ...`.
- [x] Give the seeded high-frequency actions ergonomic Commander commands that
      still call `executeAction`: `doctor`, `project`, `timeline`, `render`,
      `state`, and `jobs`.
- [x] Add ergonomic Commander commands for `media` and `route` actions.
      <!-- `vean media root add/list/remove`, `vean media scan/list/find`, and
      `vean route set/list/resolve` all call `executeAction`; setup beyond doctor
      and config remain future work. -->
- [x] Add structured discovery for humans and agents:
      `vean discover --json`, `vean discover <query> --kind ... --json`,
      enriched `vean action describe`, and timeline op catalog commands
      (`vean timeline ops list/describe/examples`). Aliases are searchable
      metadata and CLI conveniences, never duplicate action ids or MCP tools.
- [ ] Add ergonomic Commander commands for the next action families:
      `setup` beyond doctor and `config`.
- [ ] Define global options consistently: `--project <id-or-path>`,
      `--timeline <id-or-path>`, `--repo <path>` where needed, `--json`,
      `--dry-run`, `--yes`, `--confirm <token>`, `--cwd <path>`, and
      `--no-color`.
- [ ] Standardize output modes: human-readable by default, stable JSON under
      `--json`, newline-delimited JSON only for watch/streaming commands, and
      nonzero exit codes for typed failures.
- [x] Add CLI contract tests that assert every action is either exposed by a
      first-class command or intentionally hidden from CLI, and that every CLI
      command maps to a registered action. <!-- tests/actions-registry.test.ts
      and tests/cli-actions.test.ts cover canonical command discovery and action
      parity. -->

### 3D. Project selection and routing

- [x] Implement a project resolver used by all surfaces. Resolution order:
      explicit `--project`, `VEAN_PROJECT`, nearest ancestor containing
      `.vean/vean.db`, then the user's active project pointer if present. The
      resolver must print/return the chosen project in JSON output so agents do
      not guess.
- [ ] Add project commands:
      `vean project init [path]`, `vean project use <path-or-id>`,
      `vean project list`, `vean project current`, `vean project status`,
      `vean project doctor`, and `vean project open`.
- [ ] Store durable project-local configuration in `.vean/vean.db`: title,
      root path, active timeline, folder roles, media roots, render/output
      roots, setup choices, and user-approved import policies. Keep this
      gitignored and reproducible; never make it the canonical timeline.
- [x] If a persistent cross-shell active project pointer is needed, store only a
      pointer/index in OS user config (macOS Application Support / XDG config),
      not canonical project data. This is a UX locator, not source of truth.
      <!-- Implemented as VEAN_CONFIG_HOME-aware ~/.vean/projects.json seed. -->
- [x] Add route resolution helpers so commands can address project resources by
      role instead of long paths: `timeline:main`, `media:raw`, `media:proxy`,
      `renders:review`, `stills:latest`, `transcripts:source`, etc.
      <!-- Initial route table/actions landed for arbitrary aliases plus
      automatic `media:<role>` aliases when adding media roots. Timeline
      commands now use `timeline:main` for omitted-URI editing and accept
      path/file URI/route targets with one alias-to-alias indirection. Render/
      still/transcript route families are the next consumers. -->
- [ ] Make every path-bearing action report resolved paths and touched URIs.
      Agents should never have to infer where a render, still, transcript, proxy,
      or imported asset landed.

### 3E. Media catalog and local asset ergonomics

- [x] Add project-local media roots with policies: link, copy, proxy, ignore,
      transcribe, label, and watch. Start Mac-only.
      <!-- Landed as `media_roots.policy_json`, with policy carried as metadata
      but not yet interpreted by import/proxy/transcription jobs. -->
- [x] Add media commands:
      `vean media root add/list/remove`, `vean media scan`, `vean media list`,
      and `vean media find`.
- [ ] Add media commands for the next tier:
      `vean media add`, `vean media probe`, `vean media label`, and
      `vean media transcribe` (stub or job-backed until transcription lands).
- [x] Track initial media catalog rows in `.vean/vean.db`: stable media id,
      root id, path, relative path, extension-derived kind, size, mtime, labels
      JSON placeholder, probe JSON placeholder, and timestamps.
- [ ] Expand media catalog rows with content hash/fingerprint when available,
      duration, fps, resolution, audio streams, transcript status, proxy status,
      and last probe result. This is cache/coordination state; the files remain
      the source.
- [ ] Use jobs for slow work: probing large folders, proxy generation,
      transcription, waveform analysis, render/export, and agent sessions. Job
      claims stay short transactions; subprocess work happens outside DB locks.
- [ ] Keep the catalog useful to agents: expose structured search/filter results
      and summaries over CLI/MCP/UI, not just file paths. The goal is to make
      local media, labels, transcripts, and project folders addressable in
      prompts and automations.

### 3F. Surface adapters

- [x] Generate MCP tool registration from the registry first, with explicit
      opt-in/opt-out per action. MCP remains a domain-action adapter, not the
      policy source and not the ambient diagnostics source.
      <!-- `src/bridge/mcp/server.ts` now loops action descriptors with MCP
      metadata and registers tools from the canonical Zod-backed action inputs.
      tests/mcp-registration.test.ts verifies discovery/timeline tools and that
      op aliases do not become duplicate MCP tools. -->
- [x] Generate Tauri invoke-command descriptors/capability inputs from action
      metadata for the Move-4 app. The app may add presentation-specific code,
      but not duplicate domain logic. <!-- src/actions/tauri-projection.ts derives
      a run_action descriptor + the implied Tauri capabilities (scope → permission)
      per action; scripts/gen-tauri-actions.ts writes app/src-tauri/vean-actions.json
      (44/44, one generic run_action command — no per-action Rust). app-doctor
      asserts full projection coverage. -->

- [ ] Keep LSP code actions diagnostic-first and narrow. They may call the
      action runtime only when the full edit is deterministic from the diagnostic
      and current document.
- [x] Add docs output: `vean action docs --format markdown|json` so the website,
      README, and future app can list supported actions without drift.

### 3G. Homebrew and developer distribution

- [x] Add a Homebrew formula/tap path for the CLI-first Mac install. The formula
      installs the pure TypeScript/Bun-facing package and declares `mlt` and
      `ffmpeg` as system dependencies; it does not bundle codec/media binaries.
      <!-- packaging/homebrew/vean.rb: depends_on mlt + ffmpeg + bun, installs the
      source + production deps under libexec, exposes vean/vean-lsp/vean-mcp bun
      wrappers, caveats point at `vean doctor --surface cli-lsp` + the env
      overrides. url/sha256 filled on first tagged release; --HEAD works today. -->
- [ ] `vean doctor --surface cli-lsp` must pass after a Homebrew install on a
      clean Mac with `mlt`/`ffmpeg` installed by the formula dependency graph.
- [ ] Preserve source checkout parity: every command available from Homebrew is
      available from `bun src/cli.ts` / `bun run ...` in a clone, and both call
      the same action runtime.
- [x] Document environment overrides (`VEAN_MELT`, `VEAN_FFMPEG`,
      `VEAN_FFPROBE`) for nonstandard installs and for the future Mac app
      sidecar resolver. <!-- src/driver/melt.ts resolveBin() honors them (the
      `*_BIN` spelling too); `vean doctor` resolves + reports the binary in use;
      the Mac app's lib.rs renderer_env() sets them to the bundled sidecars. The
      formula caveats + DESIGN note them. tests/driver-env.test.ts. -->

**Gate:**
- [ ] Registry parity: every Move-2 tool/CLI behavior is now action-backed; tests
      prove old entrypoints and action entrypoints produce the same output.
- [x] CLI parity: every registered public action is available through either an
      ergonomic Commander command or `vean action run`; hidden actions have an
      explicit reason in metadata.
- [ ] Policy projection: at least one read, preview, timeline write, render,
      state write, job, and destructive-denied fixture has correct CLI behavior,
      MCP annotations, and Tauri capability metadata snapshot.
- [ ] Project ergonomics eval: from a fresh checkout, run
      `vean project init`, `vean project use`, add/scan a media root, create or
      select a timeline, render a still, and inspect all touched paths without
      passing absolute paths after selection.
- [ ] Concurrency eval: two workers claim jobs against the same `.vean/vean.db`
      without double-claiming; render/probe/transcribe jobs never hold long DB
      transactions.
- [ ] Agent eval: a fresh agent can ask "use the main project, find the talking
      head clip, duck the music, render a review still" and route through project
      context + media catalog + action registry without bespoke instructions.
- [ ] Distribution eval: Homebrew install and source checkout both pass
      `doctor`, can initialize a project, and can render a still through the same
      action id.

---

## Move 4 — local Mac app (the Conductor-for-video)

The product UI is a local Mac app, not a web app. The website exists to download
the app and host docs. The app uses the same action runtime, local state, and
renderer sidecars as the CLI; it does not become a second implementation.

- [x] Seed Tauri Mac app scaffold and harness without product UI decisions.
      <!-- app/src-tauri, minimal Vite surface, sidecar manifest placeholder,
      `bun run app:doctor`, `bun run app:doctor -- --native`, and a verified
      macOS `.app` bundle target. DMG packaging remains later because the current
      seed gate only needs a bootable app artifact, not installer distribution. -->
- [x] Tauri Mac app shell: project picker, current project dashboard, timeline
      read view, media browser, render/still preview, and jobs/activity panel.
      <!-- The app is a thin Tauri shell: app/src-tauri/src/lib.rs spawns `vean
      preview` (the preview.serve sidecar) on a free loopback port, health-checks
      it, and navigates the WKWebView there — so the existing viewer/ renders the
      timeline + composited preview with zero app-side UI. A collapsible right rail
      (viewer/src/components/Sidebar + panels/) adds Media / Render / Jobs /
      Project tabs, each backed by the generic POST /api/action bridge (the same
      executeAction the CLI/MCP call). Native menu gestures (Open Project Folder…,
      Add Media Root…, Project Info) + the run_action invoke are Rust-side. ONE
      sub-surface remains: a dedicated agent-session panel (the worktree model
      below). -->
- [x] Bundle pinned sidecars for the Mac app: `melt`, MLT modules/profiles,
      `ffmpeg`, and `ffprobe`. Keep them subprocess-only; never link GPL codec/
      media libraries. <!-- scripts/bundle-sidecars.ts assembles a minimal headless
      closure (35 dylibs + 16 MLT modules, ~68MB), relocates load paths to @rpath,
      re-signs (ad-hoc dev / Developer ID release), and `--verify` proves a
      scrubbed-env render. tauri.conf externalBin + resource tree; lib.rs
      renderer_env() points the spawned sidecar at them (else system deps). The
      bundle is a gitignored build artifact. Bundling the vean/vean-lsp/vean-mcp
      bins themselves (a no-Bun release) remains later; dev/source runs them via
      bun. -->
- [x] Add license/provenance packaging: sidecar versions, build source/offers,
      notices, and a reproducible manifest. The source/CLI/Homebrew artifact
      remains pure TypeScript with system deps. <!-- sidecars/MANIFEST.json: per-
      component version, source, SPDX (melt GPL-2.0, ffmpeg GPL-3.0 via
      --enable-gpl --enable-version3), the ffmpeg configure line, and the
      arm's-length-not-linked note; license texts under sidecars/licenses/. The
      full GPL written-offer URLs + notarization are the release/cert step. -->
- [~] App setup flow: detect system state, ask before user-level changes,
      initialize/select project, configure folder roles/media roots, verify with
      `doctor`. <!-- `vean doctor` (+ --surface) and `bun run app:doctor` are the
      detection/verify half (read-only pass/fail). The guided IN-APP setup UI
      (ask-before-change, host-trust steps) is the remaining piece. -->
- [x] UI calls registered actions via local IPC. Every button/menu either maps
      to an action id or is view-only. <!-- Every product panel calls POST
      /api/action (loopback) → executeAction; the native shell calls the
      run_action invoke. No surface duplicates domain logic. -->
- [ ] Git-worktree-per-exploration model wired into project view and agent
      sessions, with diffs/renders/stills easy to compare. <!-- the substantial
      remaining Move-4 feature; not started. -->
- [x] Direct-manipulation timeline gestures emit Move-1 ops through the action
      runtime; no UI-only edit path. <!-- viewer useTimelineEditor +
      timelineGestures: drag/trim/blade commit ops via /api/apply-op (the edit
      algebra) with undo/redo/save + ambient diagnostics; no UI-only mutation. -->

**Gate:**
- [x] App boots on macOS, opens a fixture project, reads `.vean/vean.db`, draws
      the timeline, lists media, and shows render/still artifacts. <!-- Verified
      headlessly end-to-end: launching the app spawns the sidecar on a free port,
      which serves the real demo timeline (2 video/1 audio, 108 frames, 0
      diagnostics), 126 media catalog rows, and renders a still (served image/png)
      — all over the same endpoints the WKWebView loads. The final GUI pixel
      spot-check is pending a non-headless look (as with the Move-0/1 Shotcut
      spot-checks). -->
- [x] Bundled sidecar gate: on a clean Mac without Homebrew `melt`/`ffmpeg` on
      PATH, the app renders a fixture via bundled sidecars; the CLI/Homebrew path
      still uses system deps. <!-- bundle-sidecars --verify: melt renders h264
      1920x1080 in a fully scrubbed `env -i` (no Homebrew on PATH/DYLD); 0
      /opt/homebrew refs across all relocated binaries. -->
- [x] Action parity gate: app-triggered render/still/apply-op produces the same
      typed output and touched URIs as CLI/MCP action execution. <!-- Structural:
      the app (/api/action, run_action) and the CLI both route through the same
      executeAction; verified live that /api/action project.current / media.list /
      render.still return the same envelopes as `vean action run`. -->
- [x] Setup gate: app can run doctor and produce a clear pass/fail report without
      silently modifying Claude/Codex trust or user PATH. <!-- `bun run app:doctor`
      (10/10) + `vean doctor` are read-only pass/fail reporters; no trust/PATH
      mutation. -->
- [ ] Real gate (subjective, concrete): Tejas opens a project, asks an agent for
      a change, sees before/after, and prefers the loop to Shotcut for that task.
      <!-- needs Tejas at the GUI. -->

---

## Move 5 — Remotion as a first-class producer

One timeline, footage + graphics.

- [x] Compositions become timeline clips: pre-rendered alpha (ProRes 4444,
      `yuva444p10le`, partial `frameRange`) for export; `<Player>` for live preview.
- [x] Render cache keyed on (composition id + resolved input props + range).
- [x] Decide audio ownership (MLT mixes; Remotion clips rendered video-only).

**Gate:** GREEN — see [GATE-MOVE5.md](GATE-MOVE5.md).
- [x] `ffprobe` confirms alpha (`yuva444p10le`); the clip composites on an upper
      MLT track (still shows the overlay over footage).
- [x] Seeking the master clock moves the slaved `<Player>` (frameupdate event).
- [x] One real piece: footage + lower-third, previewed live and exported, matching.

---

## Move 6+ — breadth

The parallelizable tail; no architectural gate. Each item lands with a schema
entry + a render/still golden, independently verifiable.

- [ ] The full filter/dial catalog (generated from `melt -query` + an override
      table for missing/one-sided ranges & units).
- [ ] More transitions; color tools; speed/time-remap; markers/chapters.
- [ ] Proxies + preview scaling; format long tail (10-bit, 4:2:2, rotation,
      anamorphic, multi-audio, timecode, captions).
- [ ] Bidirectional visual↔code editing of the Remotion layer (recast codemods,
      à la Remotion Studio).

---

## Verification philosophy

- **Static before perceptual.** Tier-1 diagnostics are the "type-checker"
  (instant, exact, computed from the graph). Rendering frames + analyzing them is
  the "test suite" (expensive, run deliberately). Most day-one value is Tier-1.
- **Golden everything that's a format contract.** The two riskiest surfaces —
  `.mlt` serialization and the keyframe-string round-trip — silently mis-render
  rather than erroring when wrong, so they are golden-tested first.
- **Frame-exact rational time** is the precondition for every diagnostic being
  correct. No float fps, ever.
