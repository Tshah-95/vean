# Gate — Move 1b (the diagnostics engine + navigation queries)

**Status: GREEN — Move 1 COMPLETE.** The three deferred Move-1a items are closed,
the shared diagnostics engine + the two navigation queries are built and
golden-tested, the three debug CLI verbs are wired, and the whole gate is green
(typecheck · test · lint · lint:xml · verify:corpus · op-invariants). A
render-faithfulness defect in `resolveValueAtFrame` (fade-out anchoring) and three
diagnostics defects surfaced by an adversarial audit + hunt were FIXED this
session and locked with regression fixtures — see §0.

Base commit for this gate run: `bfcc834` (working tree; the fixes below sit on top
of it as the Move-1b commit).

Toolchain: melt 7.38.0, ffmpeg 8.1.2 (`/opt/homebrew/bin`), xmllint libxml 20913
(`/usr/bin`), Bun 1.3.14 + vitest 2.1.9, Biome.

---

## 0. Defects found by audit + hunt, FIXED this session (with render proof)

The Move-1b implementation passed all six mechanical gates on its first run, but a
pixel-level audit against the melt render and an adversarial diagnostics hunt
surfaced four genuine defects. Each was fixed at root cause and locked with a
regression fixture (no clean corpus fixture was narrowed); all gates re-run green.

### (c) `resolveValueAtFrame` fade-OUT anchored on the SOURCE span, not the RENDERED span — FIXED

A clip's fade level was computed over `playtime(clip)` (the source-content span).
For a clip whose HEAD is consumed by a same-track dissolve, that span is LONGER
than the clip's rendered on-timeline span (the dissolve moves `trimHead` frames
into the nested lumaMix tractor). The serializer anchors a fadeOut at
`len - frames` over the **rendered** length (`len = (out - trimTail) - (in +
trimHead) + 1`), and melt paints the fade there — so the resolver disagreed with
the picture.

- **Proof (corpus `vean-multitrack.mlt`, the gold clip-1):** its source playtime is
  60, but a 20-frame dissolve eats its head, so it RENDERS 40 frames at timeline
  `[45, 84]`. melt fades it `1 → 0` over timeline `70..84` (probed center luma
  `198 → 167 → 136 → 105 → 73 → 42 → 10 → 0`); the whole timeline is exactly 90
  frames (`ffprobe nb_read_frames=90`). The OLD resolver returned a FLAT `1` across
  `70..84` and only ramped `1 → 0` over timeline `90..104` — frames that do not
  exist — off by up to a full brightness unit at every fading frame, and wrongly
  reported `live: true` past the clip's end.
- **Root cause:** `playtime(loc.clip)` was used for the fade level, the clamp, AND
  the `live` flag. The clip's rendered span is `playtime − trimHead − trimTail`.
- **Fix (`src/query/resolve.ts`):** compute `len = playtime − dissolveConsumesAt(
  before) − dissolveConsumesAt(after)` (mirrors the serializer exactly; `startOf`
  already returns the rendered start). The fade now ramps over `70..84` and reports
  `live: false` past frame 84 — matching melt pixel-for-pixel.
- **The masking test:** `tests/query.test.ts` had asserted the fadeOut tail hit 0
  at frame **104** — validating the resolver against its OWN inflated domain, not
  melt. Rewritten to assert the fade over the RENDERED tail (`70..84`) and
  `live === false` at frame 95, so it now guards the defect instead of hiding it.

### hunt #1: out-of-range `Clip.gain` FIELD invisible to `dial-out-of-range` — FIXED

`gain` is a first-class `Clip` field that only becomes a `volume`/`gain` filter at
serialize time, so the dial-range check (which only iterated `clip.filters`) never
saw it: `gain: 1000` (+60 dB) was SILENT while the identical value as
`filter("volume", { level: 1000 })` correctly fired. **Fix (`checks/media.ts`):**
`checkDialRanges` now also reads `clip.gain` against the SAME gain range (one
source of truth), so the two forms agree. Corpus gain `0.8` stays silent; `8.5`,
`100`, `1_000_000` fire. Locked in `tests/diagnostics-media.test.ts` (field +
filter control).

### hunt #2 + #3: `keyframe-outside-clip` was both a MISS and a FALSE POSITIVE — FIXED (one change)

Two faces of the same over-simplified rule, both resolved by replacing its ad-hoc
regex with the canonical keyframe engine and correcting its firing condition:

- **#2 (miss):** the rule re-parsed keyframe times with `token.slice(0,eq).replace(
  /[^0-9-].*$/,"")` + `parseInt`, which strips a TIMECODE at its first `:` to frame
  `0`. So `00:00:05.000=0;00:00:10.000=1` (frames 150 & 300, ALL past a 50-frame
  window) read as in-window and was MISSED.
- **#3 (false positive):** the rule fired on ANY keyframe past the window — but
  `split()` deliberately keeps a head half's full-span ramp (`0=0;99=1` on a window
  `[0,39]`) verbatim by design, so a routine split of any clip carrying a full-span
  escape-hatch ramp flipped a clean document to a warning. **Verified against melt:**
  `0=0;200=1` on a 50-frame clip renders a LIVE gradient (luma `0→45`), it is not
  dead; only `100=0;200=1` (ALL keyframes past the window) renders a flat clamp
  (luma flat 0).
- **Fix (`checks/structural.ts`):** resolve effective frames through `parseAnim(s,
  {fps, length})` (timecodes via fps, negatives anchored to the source end), and
  fire ONLY when EVERY keyframe is past the window (a dead clamp — the motion is
  lost). A negative keyframe anchors in-window by construction. This simultaneously
  catches the all-past timecode animation (#2's real defect) and silences the split
  head + live-gradient cases (#3). Locked in `tests/diagnostics-structural.test.ts`
  + `tests/diagnostics-checks.test.ts` (all four render-verified regimes, plus a
  real `split()` before/after).

---

## The architecture this Move obeys (load-bearing)

Per AGENTS.md "Agent feedback contract" + BUILD-MONITOR.md:

- **The diagnostics ENGINE is shared core, in `src/diagnostics/` ONLY.** One
  engine; the LSP, MCP, CLI, tests, and the future UI all call it. No `src/lsp/`,
  no diagnostics in `src/bridge/` (the explicit escalation triggers) — neither
  directory exists.
- **LSP-ready.** `collectDiagnostics(state)` returns the **FULL current
  diagnostic set** for a document (so a future `vean-lsp` can `publishDiagnostics`
  on every change; an empty set clears). Pure, document-keyed, no I/O.
- **`resolveValueAtFrame` + `findReferences` are navigation QUERIES, in
  `src/query/`.** Also pure.
- **`diagnose` is a DEBUG/CI/manual verb, NOT the agent safety loop.** Framed that
  way in its help text + docstrings; the ambient loop is the Move-2 LSP push. No
  flow depends on "remember to run diagnose".
- **Move 2 is NOT built here** — no `vean-lsp` server, no MCP domain tools. This
  Move builds the engine + queries + the debug CLI that Move 2 will consume.

---

## What passed (GREEN) — re-verified this session

| Stage | Result |
|---|---|
| `bun run typecheck` (`tsc --noEmit`) | clean |
| `bun run lint` (`biome check .`) | **71 files**, no fixes |
| `bun run test` (vitest) | **682 passed**, 0 skipped, **25 files** |
| `bun run lint:xml` | **12/12** XML namespace-clean (Shotcut-openable) |
| `bun run verify:corpus` | **10/10** faithful; every sampled frame SSIM 1.0000 |
| `tests/op-invariants.test.ts` | **213 passed** (18/18 public ops; unchanged) |
| `diagnose <f> --json` on all 10 corpus files | **10/10 clean** (e=0 w=0 i=0 h=0), exit 0 |

New test files this Move: `query.test.ts` (25), `diagnostics-harness.test.ts` (45),
`diagnostics-checks.test.ts` (10), `diagnostics-structural.test.ts` (33),
`diagnostics-media.test.ts` (24), `diagnostics-sync.test.ts`, `cli-lsp.test.ts`
(12); plus the deferred-item locks in `keyframes.test.ts` / `roundtrip.test.ts` /
`ops-trim-move.test.ts`. The +7 over the prior run (675 → 682) are the regression
fixtures for the four §0 defects — each fixture was ADDED; the only existing
assertions changed are the three that encoded the now-fixed buggy behavior (the
masked fadeOut frame domain, and the two `0=0;200=1` over-fire assertions).

---

## 1. The 3 deferred Move-1a items — CLOSED

### 1a. The 5 low/latent keyframe-engine gaps (`src/ir/keyframes.ts`)

Resolved per `DESIGN-MOVE1.md §4`. `resolveValueAtFrame` is now their real
consumer (it parses + evaluates keyframe models on the document path), so each is
locked with a golden round-trip in `tests/keyframes.test.ts`:

1. **Timecode `:FF` re-spelled as `.mmm`** → a `Keyframe.timecodeSubform: ":ff" |
   ".mmm"` flag, recorded on parse; `formatTime` switches on it. A frame-aligned
   `00:00:02:00` now round-trips its `:FF` spelling byte-identically.
2. **Empty value `0=` fabricated a `0`** → an empty body parses to the opaque
   family (gap 3), not `Number("") === 0`. `0=` round-trips empty.
3. **A quoted/text value (`0="a;b"`, `0=normal`) threw** → a new `OpaqueValue =
   { type:"opaque"; raw:string }` member makes the `KeyframeValue` union TOTAL.
   `parseValue` falls back to opaque when a token is not color/rect/scalar;
   `serializeAnim` re-quotes an opaque containing `;`/`=`. **The load-bearing one:**
   no op or query can throw on a legal-but-exotic property.
4. **Sub-ms timecode drift** → the `:ff` subform is frame-exact, avoiding the
   lossy `.mmm` rounding entirely (same `formatTime` family as #1).
5. **A genuine 2-keyframe `0=0;N=1` ramp misclassified as a fade** → fade
   detection keys on the filter's `shotcut:filter` NAME (`src/ops/primitives.ts`
   `isFadeIn`/`isFadeOut`), never the keyframe shape. A user's real edge-anchored
   ramp stays a literal animated filter.

The `KeyframeValue` totality also gives the keyframe engine a `valueAtFrame`
EVALUATOR (interp markers: discrete hold / linear / Catmull-Rom smooth /
Penner≈linear; %, rect + color component-wise; negative/relative + timecode) — the
core `resolveValueAtFrame` runs on.

### 1b. `Clip.id` routed through `shotcut:uuid` (hunt #9)

`serialize.ts` (`makeProd`) now emits `shotcut:uuid = esc(clip.id)`; `parse.ts`
(`resolveProducer`) reads `shotcut:uuid` into `clip.id` (falling back to the XML
`producer${N}` id when absent). **Identity now survives the round-trip** — a
session reloading from disk mid-edit keeps targeting clips by their stable uuids.

- The two `corpus/vean-*.mlt` goldens re-blessed (`bun corpus/build-vean.ts`); the
  diff is **uuid lines only** (`{vean-producer0}` → `clip-0`, …) — no structural
  drift. The inline `GOLDEN` in `serialize.test.ts` re-blessed the same way.
- New round-trip test (`roundtrip.test.ts`): every authored id survives
  `fromMlt(toMlt(tl))`, including an id with XML-special chars (escaped +
  recovered).
- `verify:corpus` SSIM **1.0000** and `lint:xml` **12/12** preserved.
- The corpus CLI tests now address `clip-1` (the stable uuid), not `producer3`.

### 1c. Animated escape-hatch filter window re-base across trim/split

The `shiftAnimWindow` helper (moved into `src/ops/primitives.ts` so split + trim
share ONE copy; `trim.ts` re-exports it for its test path). **Split** now re-bases
the TAIL half's animated filter keyframes by `-localFrame` (the tail's origin
moves forward), leaving the HEAD verbatim (origin unchanged; keeping out-of-window
keyframes preserves the in-window gradient + the round-trip fixpoint). Each half's
filters are deep-cloned so a re-base on one never corrupts the other. **trimIn**
already re-based on a head trim. Locked by round-trip + the split-rebase tests in
`tests/ops-trim-move.test.ts`, and exercised by `resolveValueAtFrame` on the
re-based windows.

---

## 2. The diagnostics engine (`src/diagnostics/`)

- **`types.ts`** — the `Diagnostic` type (stable `code`, `severity`, `source`,
  `message`, `location` by stable identity, `related`, `fix` hint, `data`) + the
  checker contract `Checker = (state) => Diagnostic[]` + `CheckerEntry`.
- **`index.ts`** — the registry (`CHECKERS`) + **`collectDiagnostics(state, {only?})`**
  returning the FULL current set (LSP-ready; an empty set clears). Pure +
  document-keyed; stamps each Diagnostic's `source` from the registered checker
  name (authoritative provenance). `summarize(set)` derives the compact
  `{errors,warnings,infos,hints,clean}` health an MCP tool returns. Re-exported
  from `src/index.ts` as the `diagnostics` namespace.
- **`checks/structural.ts`** — LIVE rules (in-IR-computable, conservative,
  zero-false-positive): `in-out-beyond-source`, `in-before-source-start`,
  `keyframe-outside-clip`, `orphaned-filter`, `dissolve-too-long` /
  `dissolve-unanchored` / `dissolve-half` / `clip-overconsumed`, and the field-
  transition family (`transition-track-out-of-range`, `-self-composite`,
  `-inverted-window`, `-no-overlap`). The `keyframe-outside-clip` rule resolves
  effective frames through the canonical keyframe engine (`parseAnim` + fps),
  **not** an ad-hoc regex, and fires ONLY when EVERY keyframe is past the played
  window (a dead clamp) — an out-of-window keyframe anchored by an in-window one is
  a valid live gradient, so a `split()` head's verbatim full-span ramp stays silent
  (see §0). `missing-media-file` is an opt-in I/O-injected rule (`structuralWith({
  fileExists })`), a no-op on the pure registry path.
- **`checks/media.ts`** — LIVE in-IR media/lint rules: `dangling-resource`,
  `upscaling-past-canvas` (static pixel-rect slice), `colorspace-mismatch`,
  `pixel-aspect-mismatch` / `sample-rate-mismatch`, `redundant-filter` /
  `self-cancelling-filters`, and `dial-out-of-range`. The dial check covers BOTH a
  filter param AND the first-class `Clip.gain` FIELD against one shared range, so an
  out-of-range gain is caught whichever form it lives in (see §0 hunt #1). The rules
  needing I/O (dangling FILE ref, upscaling from a smaller SOURCE) are deferred to
  the DRIVER via `// TODO(driver)` markers, surfaced through the same `Diagnostic`
  type. **`checks/sync.ts`** is a finalized-signature stub (A/V link, per-source fps
  need a future IR addition); wired into the registry so it auto-covers when a rule
  lands.

**No-false-positive gate:** `collectDiagnostics` is SILENT (0 errors, 0 warnings)
on every committed corpus file — whole-engine AND per-checker
(`tests/diagnostics-harness.test.ts`, registry-driven, 45 tests), independently
re-confirmed by running `diagnose <f> --json` on all 10 corpus files (10/10 clean,
exit 0). Each rule FIRES on a genuinely broken state with the exact code + severity
(`tests/diagnostics-checks.test.ts` (10) + `-structural.test.ts` (33) +
`-media.test.ts` (24), both directions per rule).

---

## 3. The navigation queries (`src/query/`)

- **`resolve.ts` — `resolveValueAtFrame(state, target, frame)`** → `{ value,
  scalar, live, path, notFound? }`. The effective value of a parameter at a
  TIMELINE frame, resolved through the nested scope chain — clip keyframes → track
  filters → tractor filters → transition — returning the value AND the resolution
  PATH (every hop named, the producer flagged). Targets: a clip filter property, a
  clip fade (sentinel → effective level, the hot path), a field transition
  property. Full grammar via the keyframe evaluator. A clip's fade anchors on its
  RENDERED span (`playtime − adjacent-dissolve trim`), not its source playtime, so a
  dissolve-headed clip's fadeOut lands on the frames melt actually fades — pixel-
  verified (§0 finding c). (Track/tractor filters aren't first-class IR yet; the
  resolver walks + names those scopes, ready for the IR to grow them.)
- **`references.ts` — `findReferences(state, ref)`** → by SOURCE (clips using a
  media path/color), by PROPERTY (every filter/transition reader/writer, with the
  animated flag), or by CLIP (the adjacency/ripple set: same-track neighbours +
  cross-track reach under ripple — "what moves if it moves").

Golden-tested against the corpus in `tests/query.test.ts` (25 tests): the V1
brightness fade reads ~0 at frame 0 and ~1 by the fade end (vean-multitrack); the
marked brightness ramp (linear → discrete hold → smooth) and the affine rect
(component-wise) read correctly (vean-keyframes); the field transition and the
source/property/adjacency sets resolve as expected.

---

## 4. The debug CLI verbs (`scripts/`, wired in package.json)

- **`diagnose <file.mlt> [--only a,b] [--json]`** — runs the shared engine; prints
  the full set + health; **exits 1 iff any error** (a CI gate), else 0. Framed in
  its header + help as a DEBUG/CI/manual verb, explicitly NOT the agent safety loop.
- **`resolve <file.mlt> <frame> <target-json>`** — the `resolveValueAtFrame` verb;
  prints the value, scalar, live flag, and the resolution path.
- **`refs <file.mlt> <query-json>`** — the `findReferences` verb; prints the
  located sites.

Smoke-tested end-to-end against the corpus in `tests/cli-lsp.test.ts`
(10 tests), including `diagnose`'s exit-1 CI gate on a hand-authored broken file.

---

## Still open (correctly deferred to Move 2)

- **`vean-lsp` (stdio, document sync, `publishDiagnostics`, definitions/references/
  hover, code actions)** + **the MCP/CLI domain tools** (`apply-op`, `preview-op`,
  `undo`, `render`, `still`, wrapping `resolve`/`refs`). This Move built the engine
  + queries + debug CLI those will consume — not the bridge itself (the
  BUILD-MONITOR boundary).
- **The end-to-end stitched script** (load → apply N ops → engine reports clean →
  render → still): the pieces exist (edit + diagnose + the melt driver); the single
  script is the Move-2 op→ambient-diagnostics→render deliverable.
- **The perceptual/probe diagnostics** (dangling FILE ref, upscaling, colorspace —
  driver-surfaced with I/O) and the timing rules needing a future IR addition (A/V
  link, per-source fps). Finalized checker signatures + `// TODO` markers are in
  place; each lands additively at the zero-false-positive bar.
