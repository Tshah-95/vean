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
- [x] `bun run test` green; `bun run typecheck` clean. <!-- 175 tests / 10 files
      pass (+14 over round-1: 3 original-defect flips + 9 sibling regressions +
      others); tsc --noEmit clean; biome check clean (25 files). -->
- [ ] Human spot-check: open a re-emitted `.mlt` in Shotcut, confirm it looks right.
      <!-- awaiting Tejas: open corpus/vean-multitrack.mlt in Shotcut (see GATE.md). -->

---

## Move 1 — the edit algebra + diagnostics (the LSP, headless)

The verbs and the type-checker. A closed set of pure operations and a static
diagnostics engine, driven from a CLI.

- [ ] Edit algebra as pure functions: `op(state) → {state', consequences, inverse}`.
      Mine the taxonomy from Shotcut `src/commands/`: append, insert, overwrite,
      lift, remove (ripple), trim in/out, split, move, add-transition, fades,
      gain, add/remove filter. UUID-keyed identity; nothing mutates state any
      other way.
- [ ] Tier-1 (static) diagnostics: gaps/overlaps, in/out beyond source length,
      keyframes outside clip bounds, dangling producer→file refs, orphaned
      filters, insufficient transition overlap, asymmetric A/V trim, fps-mismatch
      judder risk, upscaling >100%, colorspace mismatch, dial value out of range.
- [ ] `resolve-value-at-frame`: resolve a param through clip → track → tractor →
      transition keyframes (scope resolution — "go-to-definition for video").
- [ ] `find-references`: clips using a source; readers/writers of a property;
      adjacency/ripple set for a move.
- [ ] CLI surface: `edit`, `diagnose`, `resolve`, `refs`.

**Gate:**
- [ ] Op-inverse invariant suite: `apply(op)` then `apply(inverse)` returns the
      original IR (undo correctness) — property-based across ops.
- [ ] Diagnostics fixtures: broken timelines emit the **exact** expected
      diagnostic; clean timelines emit **zero** (no false positives).
- [ ] `resolve` / `refs` golden tests on known timelines.
- [ ] End-to-end script: load → apply N ops → diagnose (expect clean) → render →
      still.

---

## Move 2 — the agent bridge + skill

Make editing video feel like editing code with a language server.

- [ ] Wrap the core as a tight CLI and/or MCP server (the verbs above).
- [ ] Write the first real skill: the editing method — when to consult
      diagnostics (before + after every op), how to read a consequence report,
      the render→still inspection loop.
- [ ] Seed a fixture project an agent can edit end-to-end.

**Gate:**
- [ ] Behavioral eval: Claude Code, given a natural request ("tighten the gap
      before the payoff clip"), calls the right ops, consults diagnostics, renders
      — output IR/diff matches expected.
- [ ] Skill checklist verified on ≥2 seeded tasks; human reviews the stills.

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
