# Gate — Move 1a (the edit algebra)

**Status: GREEN.** The closed set of 18 public edit operations is implemented as
pure functions `op(state, args) → { state, consequences, inverse } | EditError`,
every public op is exercised by the registry-driven invariant harness, and the
integrity defects an adversarial hunt surfaced in the regimes the happy-path
samples avoid (cross-track ripple, straddling overwrite/insert, dissolve
interactions, cross-kind moves) are **fixed and regression-tested**.

Diagnostics / `resolve` / `refs` and the CLI surface (`diagnose`, `resolve`,
`refs`) remain **Move 1b** — out of scope here and left unchecked in ROADMAP.

Base commit for this gate run: `1fc313e` (working tree, then committed).

---

## The contract (recap)

Each op is a pure function over the Timeline IR. The five laws, all enforced by
`tests/op-invariants.test.ts`:

1. **Purity** — `op(state).state` is fresh; the input is never mutated.
2. **Inverse** — `apply(inverse, apply(op).state).state` DEEP-EQUALS the original.
3. **Determinism** — any minted uuid is captured into the inverse.
4. **Serializability** — `toMlt(result.state)` is namespace-clean (zero
   `prefix:` attributes) AND `fromMlt∘toMlt` is a stable fixpoint.
5. **Typed failure** — an invalid precondition returns an `EditError` VALUE,
   never a thrown error.

## Op coverage (18 public ops + 9 internal inverse ops)

The harness iterates the registry (`OP_NAMES`) and asserts all four checkable
laws (a–d) on every sample. **0 uncovered, 0 pending/skipped.**

| Op | Samples | Inverse op | Notes |
|---|---|---|---|
| append | 2 | `_dropAppended` | position via dissolve-aware `trackLength` |
| split | 2 | `_unsplit` | fade-direction deletion; color-length tracked; dissolve-starve guard |
| insert | 5 | `remove` / `_uninsert` | mid-clip split inverts exactly via `_uninsert` re-merge |
| overwrite | 4 | `_restoreRegion` | **straddle-exact** (captured-span restore) |
| lift | 3 | `_unlift` | dissolve-neighbour guard |
| remove | 2 | `_reinsert` | ripple-close never shreds other tracks; dissolve-neighbour guard |
| replace | 2 | `replace` | copyFilters path |
| trimIn | 4 | `trimIn` | ripple surfaces `ripple-blocked` warnings |
| trimOut | 4 | `trimOut` | fade-exceeds-window warning |
| move | 4 | `move` | cross-kind + dissolve + overwrite-content guards |
| dissolve | 3 | `_removeDissolve` | nested lumaMix tractor; remaining-playtime guard |
| fadeIn | 3 | `fadeIn` | sentinel set/clear |
| fadeOut | 2 | `fadeOut` | sentinel set/clear |
| gain | 3 | `_setGain` | dB⇄multiplier; unity clears |
| addFilter | 2 | `removeFilter` | clamped index |
| removeFilter | 2 | `addFilter` | positional restore |
| addTrack | 2 | `removeTrack` | video prepend / audio append |
| removeTrack | 2 | `_restoreTrack` | captured for inverse |

Internal inverse ops: `_dropAppended`, `_unsplit`, `_uninsert`, `_unlift`,
`_reinsert`, `_restoreRegion`, `_removeDissolve`, `_setGain`, `_restoreTrack`.

## Gate evidence (all stages exit 0)

| Stage | Result |
|---|---|
| `bun run typecheck` (`tsc --noEmit`) | clean |
| `bun run lint` (`biome check .`) | 53 files, no fixes |
| `bun run test` (vitest) | **501 passed**, 0 skipped, 18 files |
| `tests/op-invariants.test.ts` | **213 passed**, 0 skipped (18/18 ops covered) |
| `bun run lint:xml` | **12/12** XML namespace-clean (Shotcut-openable) |
| `bun run verify:corpus` | **10/10** corpus faithful; every sampled frame SSIM 1.0000 |

Toolchain: melt 7.38.0, ffmpeg 8.1.2 (`/opt/homebrew/bin`), xmllint libxml 20913
(`/usr/bin`).

## Hunt issues — all resolved

The adversarial hunt reported 9 issues (6 high, 2 medium, 1 low). All 8
high/medium are fixed; the low one was a documented/accepted design choice.

| # | Sev | Issue | Resolution |
|---|---|---|---|
| 1 | high | ripple-all-tracks shreds + under-reports other-track content | `rippleOtherTracks(dir:-1)` only pulls a track left where the seam is BLANK; a content track is left in place and reported via a `ripple-blocked` warning. The re-open (inverse) carries a `skipOpen` set so undo stays exact. |
| 2 | high | overwrite / non-ripple move inverse wrong when the region straddles a boundary | overwrite captures the WHOLE touched span (`spanCovering`) and `_restoreRegion` replaces the post-edit span with the captured originals (re-merges fragments). Non-ripple move over real content is now rejected with a typed precondition (it's non-invertible). |
| 3 | high | dissolve frame-math double-counts the shared overlap | New `renderedSpan` (clip minus adjacent-dissolve trims; dissolve = its blended `frames`) drives `trackLength`/`startOf`/`itemIndexAt`; `append` uses `trackLength` too. `trackLength([A(60), dissolve(20), B(60)]) === 100`. |
| 4 | high | insert/overwrite/ripple into a dissolve throws an opaque Error (law #5) | `regionTouchesDissolve` guard → typed `precondition`; `itemIndexAt` no longer returns dissolve markers to `splitEntryAt`. No op throws on a dissolve. |
| 5 | high | remove/lift/move of a dissolve neighbour → dangling marker (unserializable) | `clipTouchesDissolve` guard on remove/lift/move-source → typed `precondition`. |
| 6 | med | split of a color clip adjacent to a dissolve breaks the serialize fixpoint | `splitEntryAt` sets each COLOR half's `length` to its own played count, so the literal `length` matches the window on every emission path. |
| 7 | (within #6) | split color length round-trip on the dissolve path | Same fix as #6. |
| 8 | med | move places a clip onto a track of the wrong kind | move rejects any cross-kind (video↔audio) move with a typed precondition. |
| 9 | low | split/addTrack mint a fresh random uuid per run (IR-level non-determinism) | Accepted design choice (the uuid is captured into the inverse; XML output is stable today). Unchanged — to revisit when `Clip.id` is routed through `shotcut:uuid` (Move 1b). |

Bonus hardening found while fixing the above: a split that would starve a
dissolve's clip (leave the dissolve-facing half shorter than the dissolve) now
returns a typed precondition instead of producing an unserializable state.

## Regression coverage added

- `tests/op-invariants.test.ts` — new samples: mid-clip insert (inverts via
  `_uninsert`), straddling overwrite (captured-span restore). Harness grew
  205 → 213 tests.
- `tests/ops-dissolve-ripple-guards.test.ts` (new) — ripple-shred fix (content
  left in place + warned + exact undo; blank seam still pulls left), straddle /
  mid-clip exact inverse, dissolve frame-math, all dissolve-corrupting edits →
  typed EditError, cross-kind move → typed EditError.
- `tests/ops-placement.test.ts` — the mid-clip insert case now asserts EXACT
  inverse (was "lossy regime"); the multi-item overwrite blank reporting kept.
- `tests/ops-trim-move.test.ts` — the "overwriting real content is visible" case
  now asserts the corrected behaviour (non-ripple move over content is REJECTED,
  not silently lossy + non-invertible).

## Still open (correctly deferred to Move 1b)

- **Diagnostics / `resolve` / `refs` / CLI verbs** — the LSP query surface (the
  rest of the Move 1 ROADMAP). Not started; explicitly out of scope for 1a.
- **`Clip.id` → `shotcut:uuid` serialization** — recorded in `DESIGN-MOVE1.md §1`.
  `Clip.id` is stable in-memory (all the op contract + inverse invariants need)
  but does not survive serialize→parse today; routing it through `shotcut:uuid`
  re-blesses the two `vean-*.mlt` goldens. This is the only reason hunt issue #9
  (IR-level uuid non-determinism) is left as-is.
- **Animated-filter (escape-hatch) window re-base across trim/split** — the
  `shiftAnimWindow` helper exists; the reference samples don't carry escape-hatch
  filters across a split, and the keyframe re-base on trim lands with the Move 1b
  trim work.
