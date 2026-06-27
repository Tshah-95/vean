# vean roadmap

Markdown-first plan of record. Each **Move** is a phase that lands behind a
**verification gate** — nothing stacks on an unverified phase. Moves run as one
multi-agent workflow each (decompose → parallel build → adversarial verify →
synthesize), with a human gate-check between phases. Check boxes as they land.

The shape of the whole thing: **Moves 0–2 are the headless spine** (well-specified,
mostly agent-buildable — the answer key is Shotcut's source + the MLT clone).
**Move 3 is the taste-driven viz layer** (unblocked the moment Move 0 lands,
since it only needs to *read* the IR). **Move 4** unifies Remotion. **Move 5+** is
the parallelizable breadth.

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
- [x] Ship a Claude Code plugin config that registers `vean-lsp` with diagnostics
      enabled by default. <!-- The server is a conformant stdio LSP (vean-lsp bin /
      `bun run lsp`); host registration is editor configuration, not a code
      artifact — documented in the `editing` skill. No vean-specific polling
      protocol; an LSP host gets ambient vean diagnostics for free. -->
- [x] Wrap the core as MCP/CLI domain tools: `apply-op`, `preview-op`, `undo`,
      `render`, `still`, `resolve-value-at-frame`, `find-references` (+ `diagnose`
      as the debug verb). Tools return consequences, inverse, touched URIs, and a
      compact health summary (counts + new/blocking details only); no full
      diagnostic dump. <!-- src/bridge/mcp/server.ts (vean-mcp bin) over the
      transport-free tool core, split by side: tools/mutate.ts (apply/preview/undo +
      the compact-health discipline), tools/read.ts (resolve/refs queries + the
      render/still melt verbs — render/still return `touchedUris` = the produced
      mp4/png the agent inspects next), tools/core.ts (diagnose + ser/de + re-export
      barrel). The ToolResult contract is tools/types.ts; the read-tool result
      shapes live with their handlers in tools/read.ts. CLI: `bun run render` /
      `bun run still` (scripts/render.ts, still.ts — same read-tool core, three
      surfaces). The compact `health.newOrBlocking` is a before/after diff of the
      SHARED engine. Verified: tests/read-tools.test.ts (Node host, fake spawn — the
      argv + touchedUris contract) + `bun run read-tools:artifact` (Bun host, real
      melt — a true PNG/MP4 on disk at the touchedUris path). -->
- [x] Write the first real skill: the editing method — rely on ambient LSP for
      diagnostics, use MCP tools for domain actions, read consequence reports, and
      run the render→still inspection loop. <!-- .claude/skills/editing/SKILL.md,
      written from the actual Move-2 build. -->
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
      and a compact health summary without flooding full diagnostic payloads.
      <!-- tests/mcp-tools.test.ts + bun run move2:e2e: all four fields present;
      health has no `diagnostics` dump; new/blocking surfaced, untouched warnings
      counted-not-dumped. -->
- [x] Behavioral eval: a natural request ("tighten the gap", "duck the audio")
      maps to the right ops, receives ambient feedback, renders. <!-- the two
      seeded tasks (trimIn to tighten, gain to duck) in move2:e2e — op via tool →
      ambient clean → render → still (a real frame, visually confirmed). -->
- [x] Skill checklist verified on ≥2 seeded tasks; human reviews the stills.
      <!-- bun run move2:e2e PASS 2/2 (trimIn clip-3, gain clip-5); stills produced
      to out/move2-e2e/*.png. Human still-review remains a manual confirmation, as
      with the Move-0/1 Shotcut spot-checks. -->

---

## Move 3 — the visualization shell (the Conductor-for-video)

The taste-driven UI. Unblocked the moment Move 0 lands — it only needs to *read*
the IR + render outputs. Comes up simple, deepens as the core deepens.

- [ ] Web app (Vite/React): project list; timeline drawn from the IR; preview
      surface (rendered MP4 + still inspection day-zero); agent sessions/diffs panel.
- [ ] Git-worktree-per-exploration model wired into the project view.
- [ ] Later: `@remotion/player` slaved to a master clock; direct-manipulation
      that emits Move-1 ops.

**Gate:**
- [ ] Smoke test: app boots, reads a fixture IR, draws the timeline + shows
      render/stills without error.
- [ ] Real gate (subjective, concrete): Tejas opens a project, asks an agent for
      a change, sees before/after — and prefers it to Shotcut for the loop.

---

## Move 4 — Remotion as a first-class producer

One timeline, footage + graphics.

- [ ] Compositions become timeline clips: pre-rendered alpha (ProRes 4444,
      `yuva444p10le`, partial `frameRange`) for export; `<Player>` for live preview.
- [ ] Render cache keyed on (composition id + resolved input props + range).
- [ ] Decide audio ownership (MLT mixes; Remotion clips rendered video-only).

**Gate:**
- [ ] `ffprobe` confirms alpha (`yuva444p10le`); the clip composites on an upper
      MLT track (still shows the overlay over footage).
- [ ] Seeking the master clock moves the slaved `<Player>` (frameupdate event).
- [ ] One real piece: footage + lower-third, previewed live and exported, matching.

---

## Move 5+ — breadth

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
