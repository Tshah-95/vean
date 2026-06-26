# Move 0 — Gate report

**Status: GREEN pending one human spot-check.**

The headless spine is real and verified — the document core round-trips
losslessly, renders faithfully, **opens in Shotcut**, and the build is green.
Three rounds of adversarial verification ran:

- **Round 1** found 3 correctness defects in the keyframe / round-trip engine —
  **all 3 fixed** (see "Original defects — fixed").
- **Round 2** (a completeness/sibling hunt) found 3 *medium* lossy round-trips of
  the **same class** as original defect #2, at levels the first fix didn't
  generalize to — **all 3 fixed** (see "Sibling defects — fixed"). It also found
  5 *low/latent* contract gaps inside the keyframe engine that are **not on the
  document path** and cannot mis-render today — these are documented as open and
  scoped to Move 1 (see "Open — low / latent").
- **Round 3 (Shotcut-openability)** found the one defect that broke *opening* in
  Shotcut even though `melt` rendered fine: vean emitted `shotcut:filter` /
  `shotcut:transition` as **namespaced XML attributes with no namespace
  declaration**, which Shotcut's strict namespace-aware reader rejects. **Fixed**
  — they are now `<property>` children — and a new **`lint:xml` gate** enforces
  Shotcut-openability so it can never regress (see "Shotcut-openability — fixed").
  A follow-up adversarial sweep on the new shape then found one *high* round-trip
  defect (combined fadeIn+fadeOut on a windowed clip) — **fixed** in this session
  (see "Combined-fade round-trip — fixed").

Every gate box is green except the **human spot-check** in Shotcut (a manual
review step an agent can't perform — Tejas is confirming the actual GUI open
separately). Each agent result was re-run here before being recorded — not
trusted from the report.

---

## What passed (GREEN) — independently re-verified (this session)

Ran in `/Users/tejas/Github/vean`; every stage exited 0.

### 1. Build — PASS
- `bun run typecheck` (`tsc --noEmit`) → clean (exit 0).
- `bun run lint` (`biome check .`) → "Checked 27 files. No fixes applied." (exit 0).
- `bun run test` (vitest) → **185 tests / 11 files pass** (exit 0). The +10 over
  round-2's 175 are the 7 namespace/Shotcut-openability tests
  (`tests/xml-namespace.test.ts` + strengthened adversarial/serialize/parse cases)
  and the 3 combined-fade round-trip regression tests.

### 1b. Shotcut-openability (XML namespace validity) — PASS
- `bun run lint:xml` → **OVERALL: PASS — 12/12 XML namespace-clean
  (Shotcut-openable)** (exit 0). Runs `xmllint --noout --nsclean` over every
  committed `corpus/*.mlt` (10) **and** the fresh serializer output of every
  fixture in `corpus/vean-fixtures.ts` (2). ANY xmllint stderr (namespace OR
  well-formedness) fails it. This is the gate that pins the namespaced-attribute
  fix below. `verify:corpus` also folds it in as GATE 0
  ("xml: PASS — 12/12 namespace-clean") before any melt render.

### 2. Round-trip golden — PASS
`bun run roundtrip <file>` on the corpus; every file reaches a stable IR fixpoint
(exit 0). The two **vean-emitted** files are **byte-identical** through
parse→serialize:

```
vean-keyframes.mlt    byte-identical (loss-free)
vean-multitrack.mlt   byte-identical (loss-free)
```

Spot-checked two **Shotcut-saved** inputs (not vean emissions, so only required to
reach a stable normal form — vean legitimately normalizes attribute order,
clock→frame times, adds the Shotcut background producer + `shotcut:uuid`):

```
shotcut-dissolve.mlt    fixpoint stable (normalized; not byte-identical to input)
shotcut-multitrack.mlt  fixpoint stable (normalized; not byte-identical to input)
```

Guarded by `tests/corpus-golden.test.ts`.

### 3. Render-faithfulness — PASS
`bun run verify:corpus` (melt 7.38.0 + ffmpeg at `/opt/homebrew/bin`) renders both
the original and the re-emitted XML for every corpus file, samples evenly-spaced
frames, and compares with ffmpeg SSIM (threshold ≥ 0.98).
**OVERALL: PASS — 10/10 faithful.** Every sampled frame of all 10 files is
**SSIM 1.0000** (pixel-identical) — the round-1 sub-pixel 0.9997 on
`shotcut-dissolve.mlt` is gone; the whole corpus is now pixel-exact.

---

## Original defects — fixed (round 1)

`tests/adversarial.test.ts` exercised negative/relative frames, percent values,
the full marker table (`|` `~` Penner), rect/color keyframes, dissolve-length
guards, escape-hatch filters, namespace handling, and locale normalization. The
round-1 pass pinned three real defects as `KNOWN DEFECT` tests; **all three are
now fixed** and those tests flipped to assert the corrected behavior (plus
focused regression tests). No `KNOWN DEFECT` test block remains.

1. **Comma-decimal inside an animation string → was a SILENT mis-animation.**
   A file authored under `LC_NUMERIC=fr_FR` with
   `<property name="level">0=0,2;59=0,8</property>` (comma = decimal) re-emitted the
   string verbatim under a `C`-locale header, so melt's `atof("0,2") == 0` animated
   brightness `0→0→1` instead of `0.2→0.8→1`. **Fix:** the keyframe engine accepts a
   comma OR dot decimal (`numAcceptingComma`), and `parse.ts` runs
   `normalizeAnimDecimals` on every animation-string property value — migrating a
   decimal comma between digits to a dot while leaving the `;`/`=`/marker structure
   and non-numeric content (colors, paths) byte-identical. End-to-end melt proof:
   the normalized file's mean luma rises monotonically (f0=60 → f59=191) tracking
   the 0.2→0.8 ramp; the raw-comma control renders FLAT (YAVG=16, black).

2. **Producer-level Shotcut properties were dropped on round-trip.** A
   `<producer>` carrying `shotcut:caption`, `eof=pause`, `aspect_ratio` (proxy
   hints, etc.) lost them because `resolveProducer()` read only
   `mlt_service`/`resource`/`length`. **Fix:** the IR `Clip` carries an ordered
   `extraProps` map; `parse.ts` captures every non-structural producer property
   (excluding `mlt_service`/`resource`/`length`/`shotcut:uuid`, modeled
   structurally — `STRUCTURAL_PRODUCER_PROPS`) in document order, and `serialize.ts`
   re-emits them deterministically after the structural props. Genuinely lossless,
   not a stable total-loss fixpoint. (This is the pattern the sibling fixes
   generalize.)

3. **Empty animation property used to fabricate a `0`.**
   `serializeAnim(parseAnim(""))` returned `"0"` — a value the blank property never
   had. **Fix:** `parseAnim("")` yields a static model with NO keyframes, and
   `serializeAnim` re-emits `""` (faithful empty pass-through). Whitespace-only also
   serializes to `""`.

**Robustness (single-frame extraction):** `still()` passed a single PNG to a fixed
(non-`%d`) filename, making ffmpeg's image2 muxer warn on every grab and risk
leaving a STALE PNG a downstream SSIM compare would treat as fresh. **Fix:**
`still()` forwards `update=1` to the muxer (warning-free, overwrite-correct), and
the ssimPng fixture's ffmpeg PNG generation gained `-update 1` to match. Live-
tested with melt 7.38.0: the grab overwrites a planted stale PNG and grabs the
exact requested frame. `bun run test` and `bun run verify:corpus` are warning-free.

---

## Sibling defects — fixed (round 2)

A completeness hunt confirmed defect #2 was fixed at the **producer** level but the
**same lossy drop** persisted at sibling levels, plus a related double-emit. All
three (severity *medium*) are now fixed, mirroring the `extraProps` pattern, with
9 regression tests (capture into IR + re-emit/fixpoint + no-fabrication-when-absent
per defect):

A. **Playlist-level non-structural `<property>` children were dropped.** A
   `<playlist>` carrying e.g. `shotcut:lock` or `custom:foo` (beyond the modeled
   `shotcut:video`/`shotcut:audio`/`shotcut:name`) lost them. **Fix:** added
   `extraProps` to the IR `Track`; `parse.ts` captures every non-structural playlist
   property (`STRUCTURAL_PLAYLIST_PROPS` excludes the three Shotcut hints) via a new
   `captureExtraProps` helper; `serialize.ts`'s `playlistXml` re-emits them after the
   structural hints, before entries. `shotcut:lock` and `custom:foo` now survive.

B. **Main-tractor-level `<property>` children were dropped.** The main `<tractor>`
   carrying project metadata (`shotcut:projectAudioChannels`, `shotcut:scaleFactor`,
   …) lost it because parse read only `<track>`/`<transition>` children. **Fix:**
   added `tractorProps` to the IR `Timeline`; `parse.ts` reads the main tractor's own
   `<property>` children; `serialize.ts` emits them first inside the main `<tractor>`.
   Both metadata props now survive.

C. **Field transition with `in`/`out` as `<property>` children → duplicated stale
   state.** Shotcut may write a transition window as
   `<property name="in">…</property>` / `out` instead of `in=`/`out=` attributes;
   parse supported the property fallback but did NOT exclude `in`/`out` from the
   property map, so re-emit produced BOTH attributes AND `<property>` children —
   divergent, and a later edit to `transition.out` would leave the stale property out
   of sync. **Fix:** `parse.ts` reads the window with a property fallback for both
   `in` and `out`, then excludes `in`/`out` from the property-map loop
   (`if (k === "in" || k === "out") continue`, parse.ts:596). The window is modeled
   once (`Transition.in/out`) and re-emitted once (as attributes). Attribute-form
   transitions stay clean.

With the producer fix (#2) generalized to playlist, tractor, and the transition
in/out path closed, the round-trip is lossless at **every** level; the serializer
banner's "round-trips losslessly" claim holds universally, and the
**"Keyframe round-trip … identical (golden)"** gate box is checked.

---

## Shotcut-openability — fixed (round 3)

**The one defect that broke *opening* in Shotcut while `melt` rendered fine.**
vean emitted Shotcut's logical filter/transition names as **namespaced XML
attributes** — `<filter mlt_service="brightness" shotcut:filter="fadeInBrightness">`
and `<tractor ... shotcut:transition="lumaMix">` — with **no `xmlns:shotcut`
declaration**. `melt` is namespace-lenient (it rendered all along, so
render-faithfulness was always SSIM 1.0000), but Shotcut's strict
namespace-aware `QXmlStreamReader` rejects an undeclared prefix
("Namespace prefix shotcut for filter on filter is not defined") and refuses to
open the file. Reproduced exactly with `xmllint --noout --nsclean`.
**Subtlety that shaped the gate:** `xmllint` **exits 0** on a namespace error,
printing only to **stderr** — so `lint:xml` keys off stderr, not the exit code.

**Fix:** the logical name is now emitted as a `<property name="shotcut:filter">`
/ `<property name="shotcut:transition">` **child** (the form genuine Shotcut
writes, and the namespace-safe form a strict reader accepts) — matching the
existing `shotcut:uuid`/`video`/`audio`/`name` property convention. No element
carries any namespaced attribute. `serialize.ts` emits it first (a deterministic
stable slot); `parse.ts` reads it from the property child (primary) with the
legacy attribute form tolerated as a fallback and normalized to property form on
re-emit. Regenerated `corpus/vean-multitrack.mlt` (4 occurrences) and fixed
hand-authored `corpus/shotcut-dissolve.mlt`; all 10 corpus files pass
`xmllint --noout --nsclean`. Guarded by **`scripts/lint-xml.ts`** (the `lint:xml`
gate + GATE 0 in `verify:corpus`) and **`tests/xml-namespace.test.ts`** (a
hermetic structural scan asserting zero namespaced attributes in `toMlt()` of
every fixture, with a negative test proving the scanner catches the bug, plus an
authoritative `xmllint --nsclean` check).

## Combined-fade round-trip — fixed (round 3 follow-up sweep)

The adversarial sweep on the new property-form shape found one *high*-severity
round-trip defect (well-formed and namespace-clean, but a real mis-render on
re-save through Shotcut): **a clip with BOTH `fadeIn` AND `fadeOut` on a windowed
file clip (`in > 0`) did not round-trip.** The serializer compiles both fades to
ONE 4-keyframe `brightness`/`volume` filter named `fadeInOut{Brightness,Volume}`
(`0=0;in-1=1;len-out=1;len-1=0`) placed on a **0-based wrapper tractor** so the
keyframes anchor to the played window (melt mis-anchors keyframes on a windowed
producer). But `parse.ts`'s `fadeFromKeyframes` only inverted **exactly-2-keyframe**
(single-direction) fades, so the 4-keyframe combined fade survived as a raw
`brightness` filter; on re-emit `resolveFades` saw no fade sentinels and emitted
the filter **directly on the windowed producer** (no wrapper) — the 0-based
keyframes then mis-anchored against a producer whose source domain starts at the
clip's in-point. The existing roundtrip gate missed it (the parser didn't drop
the filter outright, so it reached a stable fixpoint, and the golden vean fixtures
use only single-direction fades on from-zero color clips).

**Fix:** `fadeFromKeyframes` now also matches the 4-keyframe head-up/hold/tail-down
shape and returns **BOTH** `vean.fadeIn` + `vean.fadeOut` sentinels (with frames
recovered as `k1+1` and `playtime-k3`); both `classifyFilters` call sites spread
the result. The wrapper is rebuilt on re-emit and the round-trip is byte-identical
for video AND audio combined fades (verified for windowed in>0, plus gain-stacked).
Single-direction and from-zero cases are unchanged. Regression-locked by 3 tests in
`tests/adversarial.test.ts` ("combined fadeIn+fadeOut on a WINDOWED (in>0) file
clip"): byte-identical re-emit for video + audio, and an assertion that the
recovered IR carries both fade sentinels (not a raw `brightness` filter). This also
fully closes round-2 open item #5 below for the document path — fade recovery no
longer leaves a re-emittable mis-render — though that item's note about keying on
the `shotcut:filter` name (vs keyframe shape) remains the more robust long-term
discriminator for Move 1.

## Open — low / latent (not gating; scoped to Move 1)

The same hunt found 5 *low-severity* contract gaps **inside the keyframe engine**
(`src/ir/keyframes.ts`, `parseAnim`/`serializeAnim`). They are documented here as
genuinely open. They do **not** gate Move 0 because **`parseAnim`/`serializeAnim`
are not on the document path** — `parse.ts`/`serialize.ts` never call them; the
round-trip passes animation-string property values through **verbatim** (parse
applies only `normalizeAnimDecimals`, serialize only `esc()`). Confirmed by grep
and end-to-end: timecode `:FF` strings, ms-timecode strings, and rects all
round-trip byte-for-byte through `fromMlt`/`toMlt`. So none of these can mis-render
any current corpus file (consistent with verify:corpus = SSIM 1.0000 everywhere).

They become live the moment Move 1's edit algebra parses a keyframe model — that
consumer is also what should *shape* the representation (a sub-form flag, an
opaque-string value family), so fixing them now would risk locking a design before
its only caller exists. `tests/keyframes.test.ts` guards the byte-faithful contract
and will be the home for these once Move 1 lands them.

1. **Timecode `HH:MM:SS:FF` re-emitted as `HH:MM:SS.mmm`.** `formatTime` always
   emits the `.mmm` form; the `Keyframe.timecode` flag records no `:FF`-vs-`.mmm`
   sub-form. (keyframes.ts `formatTime`/`parseTime`.)
2. **Empty animation *value* (`0=`) fabricates a `0`.** `numAcceptingComma("") === 0`
   (because `Number("")` is `0`), so `0=` → `0=0`. Same class as original defect #3,
   one level deeper (inside an item rather than the whole string).
3. **Quoted value containing `;` or `=` throws.** `serializeAnim` quotes such values,
   but `parseValue` is handed the unquoted body and `parseScalar` throws — the
   `KeyframeValue` union has no opaque-string variant, so quoted/text values
   (`0="a;b"`, `0=normal`) are unrepresentable.
4. **Sub-millisecond / non-frame-aligned timecode drift** in the `.mmm` form (same
   `formatTime` rounding family as #1).
5. **A genuine (non-fade) `brightness`/`volume` filter with an edge-anchored
   2-keyframe ramp (`0=0;N=1`) is misclassified as a fade sentinel**, dropping its
   `shotcut:filter` name + sibling properties. Narrow collision (only the exact
   fadeIn/fadeOut shapes trip it; it re-emits an identical level string so it reaches
   a fixpoint and stays visually faithful, hence low). Lives in `parse.ts`
   `classifyFilters`/`fadeFromKeyframes` — fix is to key fade detection on the
   filter's `shotcut:filter` name, not the keyframe shape alone.

**Things that PASSED the adversarial hunt** (no defect): filter order on a producer;
transition property preservation + order; comma-decimal normalization inside a
rect/transition-geometry string and in profile attrs; attribute-reorder determinism
(two inputs differing only in attribute order emit byte-identically); negative/
relative frames; rect/percent/6-8-digit color round-trip; the hardened
`still()`/frame-grab (overwrites a stale PNG, grabs the exact frame).

---

## Human spot-check (the one manual step left — Tejas only)

Open the richest **re-emitted** vean artifact in Shotcut and confirm it looks
right:

```
open -a Shotcut /Users/tejas/Github/vean/corpus/vean-multitrack.mlt
```

Why this file: it is vean-emitted (banner: "Generated by vean"), round-trips
**byte-identical**, and is the richest single artifact — 2 video + 1 audio track,
a fade-in → dissolve → fade-out on V1, a blank-gap + overlay on V2, audio gain on
A1 (`tone.wav`), and a cross-track `qtblend` field composite with a keyframed rect.
It is self-contained (color producers + the committed `corpus/tone.wav` by absolute
path), so it opens and plays without any external media.

What to confirm visually: the dissolve and fades read smoothly, the V2 overlay
composites over V1, the audio track is present and gained, and Shotcut opens it
**without a normalization/repair prompt** (i.e. it accepts vean's XML as-is). The
namespaced-attribute defect that previously made Shotcut **refuse to open** vean
files is fixed and machine-gated (`lint:xml`); this manual step now confirms the
*visual* result and that the real GUI accepts it cleanly — a check an agent can't
perform. **Tejas is confirming this separately; the box stays UNCHECKED until he
reports the actual GUI open.**

If it looks right, check the "Human spot-check" box in `ROADMAP.md`. With that box
checked, Move 0 is fully GREEN and Move 1 is unblocked.
