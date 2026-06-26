# Move 0 — Gate report

**Status: PARTIAL (gate held open).**

The headless spine is real and verified — the document core round-trips, renders
faithfully, and the build is green. But the **adversarial pass found 3 genuine
correctness defects in the keyframe / round-trip engine**, one of which silently
mis-renders. So Move 0 does **not** go fully green: the round-trip is faithful in
the common case but is **not** the "losslessly round-trips" guarantee the
serializer banner promises. The gate is recorded honestly as PARTIAL, and the
keyframe round-trip box stays unchecked until the 3 defects are fixed.

This was verified by four independent agents, then each result was
re-run/spot-checked here before being recorded — not trusted from the report.

---

## What passed (GREEN) — independently re-verified

### 1. Round-trip golden — PASS
`bun run roundtrip <file>` on all 10 corpus `.mlt`; every file reaches a stable
IR fixpoint (exit 0). The two **vean-emitted** files are **byte-identical**
through parse→serialize:

```
vean-keyframes.mlt   byte-identical (1752 B == 1752 B)
vean-multitrack.mlt  byte-identical (4556 B == 4556 B)
```

The other 8 (4 harvested from studio `src/mlt`, 4 hand-authored Shotcut docs)
are *not* vean emissions, so they're only required to reach a stable normal form
(vean legitimately normalizes attribute order, clock→frame times, adds the
Shotcut background producer + `shotcut:uuid`). Guarded by
`tests/corpus-golden.test.ts`. Re-confirmed here: regenerating both vean fixtures
from `corpus/vean-fixtures.ts` matches the committed bytes exactly.

### 2. Render-faithfulness — PASS
`bun run verify:corpus` (melt 7.38.0 + ffmpeg 8.1.2 confirmed present) renders
both the original and the re-emitted XML for every corpus file, samples 5
evenly-spaced frames, and compares with ffmpeg SSIM (threshold ≥ 0.98).
**OVERALL: PASS — 10/10 faithful.** Min SSIM in the whole corpus is **0.9997**
(`shotcut-dissolve.mlt`, one sub-pixel frame at the dissolve midpoint); every
other sampled frame is **1.0000** (pixel-identical).

### 3. Build (`bun run test` + `bun run typecheck`) — PASS
- `bun run test` → **161 tests / 10 files pass** (the +25 over the original 136
  are the adversarial fixtures).
- `bun run typecheck` (`tsc --noEmit`) → clean.
- `bun run lint` (`biome check .`) → clean.

> Build note (transparency): the build gate run *as verified* was **RED** — 4
> auto-fixable biome errors in `src/driver/melt.ts` (useTemplate, formatting) and
> `tests/driver-melt.test.ts` (noDelete ×2), plus a stray `zz-repro.ts` scratch
> script. All were trivially fixable, so the gate agent landed the fixes in this
> same commit (auto-fix, not deferred): comma-decimal lint resolved by hand to
> control the exact diff, `zz-repro.ts` removed. Lint/typecheck/test are green
> *now*. The RED is recorded here so the history is honest, not papered over.

---

## What is RED (gate held open) — adversarial defects

`tests/adversarial.test.ts` (25 fixtures) exercised negative/relative frames,
percent values, the full marker table (`|` `~` Penner), rect/color keyframes,
dissolve-length guards, escape-hatch filters, namespace handling, and locale
normalization. **Most are handled correctly and are now locked in as passing
tests.** Three are real defects, pinned as `KNOWN DEFECT` tests (a future fix
flips them red, signalling the bug is gone):

1. **Comma-decimal inside an animation string → SILENT mis-animation (serious).**
   A file authored under `LC_NUMERIC=fr_FR` with `<property name="level">0=0,2;59=0,8</property>`
   (comma = decimal separator → 0.2 and 0.8) is re-emitted with the keyframe
   string **verbatim** (`0=0,2;59=0,8`) under a `C`-locale header. Root cause:
   `src/ir/parse.ts` `dotDecimal()` deliberately bails on any string containing
   `=` (line 101), so it never touches animation strings; `keyframes.ts` uses
   `Number()`, which rejects `"0,2"`. Confirmed `parseFloat('0,2') === 0`, so
   melt animates brightness `0→0→1` instead of `0.2→0.8→1`. This is the one defect
   that **mis-renders** rather than just dropping metadata — it directly
   contradicts the ROADMAP's `LC_NUMERIC` `.`-decimal requirement.

2. **Producer-level Shotcut properties dropped on round-trip.** A `<producer>`
   carrying `shotcut:caption`, `eof=pause`, and `aspect_ratio` loses all three on
   re-emit. `resolveProducer()` reads only `mlt_service`/`resource`/`length`. The
   round-trip still "fixpoints" because the loss is total and stable, which masks
   it from the fixpoint gate. Filter properties *are* preserved; the loss is
   specifically non-essential producer metadata.

3. **Empty animation property fabricates a `0` value.** `serializeAnim(parseAnim(""))`
   `=== "0"` — an empty (legal) MLT property value gains a value that was never
   there. Low severity, but a fabrication rather than a faithful pass-through.

Because of (1)–(3), the **"Keyframe round-trip … identical (golden)"** gate box
is left **unchecked**, and the serializer banner's "round-trips losslessly"
claim is not yet universally true.

---

## Human spot-check (the one manual step left)

Open the richest **re-emitted** vean artifact in Shotcut and confirm it looks
right:

```
open -a Shotcut /Users/tejas/Github/vean/corpus/vean-multitrack.mlt
```

Why this file: it is vean-emitted (banner: "Generated by vean"), round-trips
**byte-identical**, and is the richest single artifact — 2 video + 1 audio track,
a fade-in → dissolve → fade-out on V1, a blank-gap + overlay on V2, audio gain on
A1 (`tone.wav`), and a cross-track `qtblend` field composite with a keyframed
rect. It is self-contained (color producers + the committed `corpus/tone.wav` by
absolute path), so it opens and plays without any external media.

What to confirm visually: the dissolve and fades read smoothly, the V2 overlay
composites over V1, the audio track is present and gained, and Shotcut opens it
**without a normalization/repair prompt** (i.e. it accepts vean's XML as-is).

If it looks right, check the "Human spot-check" box in `ROADMAP.md`. The keyframe
round-trip box stays unchecked regardless until the 3 defects above are fixed.
