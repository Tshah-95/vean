# Move 1a — the edit algebra (design of record)

This is the **design barrier** for the edit algebra: the op taxonomy, the op
contract types, the UUID-identity approach, how ops compose from a small set of
playlist-surgery primitives, and the keyframe-representation decision that
resolves the 5 deferred keyframe gaps from Move 0's GATE.

The answer key is Shotcut's `src/commands/timelinecommands.{h,cpp}` and
`src/models/multitrackmodel.cpp` — we lift the *semantics* and drop the Qt/undo
machinery. Shotcut's commands mutate a live `Mlt::Playlist` and snapshot the
whole track XML for undo (an `UndoHelper`). vean does the opposite: **ops are
pure functions over the Timeline IR**, they never mutate, and the inverse is a
*fully-specified op invocation* (not an XML snapshot) — smaller, diffable, and
composable.

---

## 0. The op contract (pure, functional)

Every op has the shape:

```ts
type Op<A> = (state: Timeline, args: A) => OpResult;

type OpResult = {
  state: Timeline;          // a NEW timeline; the input is never mutated
  consequences: Consequences; // a structured report of what changed
  inverse: OpInvocation;    // { op, args } that undoes this op exactly
};
```

Laws every op MUST satisfy (enforced by `tests/op-invariants.test.ts`):

1. **Purity / immutability.** `op(state, args).state` is a fresh object; the
   input `state` is deep-unchanged. (We structurally clone on the way in.)
2. **Inverse correctness.** `apply(inverse, apply(op, state, args).state).state`
   **deep-equals** the original `state`. Undo = apply the inverse.
3. **Determinism.** No randomness on the *result-state shape* that the inverse
   can't reproduce. New clips get a uuid, but the uuid is captured into the
   inverse so undo restores it.
4. **Serializability.** `toMlt(result.state)` is Shotcut-openable
   (namespace-clean) and round-trips (`fromMlt∘toMlt` is a stable fixpoint).
5. **Typed failure.** An invalid precondition returns an `EditError` (a value),
   never a thrown opaque error. `apply` returns `OpResult | EditError`.

`apply(invocation, state)` is the single dispatcher: it looks the op up in the
**registry** (`src/ops/index.ts`), validates `args` against the op's Zod schema,
and calls it. Undo is just `apply(result.inverse, result.state)`.

### Consequences — the structured report

The whole reason this layer exists ("reports its consequences before a single
frame renders"). A superset shape; an op fills only the relevant fields:

```ts
type Consequences = {
  clipsAdded:    ClipRef[];   // uuid + where it landed (track, index, position)
  clipsRemoved:  ClipRef[];
  clipsMoved:    ClipMove[];  // uuid + from→to (track, position)
  clipsTrimmed:  ClipTrim[];  // uuid + in/out delta + playtime delta
  blanksCreated: BlankRef[];  // track, index, length
  blanksRemoved: BlankRef[];
  ripple:        RippleEffect[]; // per OTHER track: shift direction + frames
  durationDelta: number;      // total-timeline frame delta (signed)
  warnings:      Warning[];   // non-fatal (e.g. "fade shortened to fit")
};
```

`ClipRef`/`BlankRef` locate by **uuid + track id + position** (frames from track
start) — never by bare index, which is ephemeral.

### EditError — typed preconditions

```ts
type EditError =
  | { kind: "clip-not-found"; uuid: string }
  | { kind: "track-not-found"; track: string }
  | { kind: "frame-out-of-range"; frame: number; bound: number; detail: string }
  | { kind: "dissolve-too-long"; frames: number; neighbour: number; side: "in"|"out" }
  | { kind: "split-at-boundary"; frame: number; detail: string } // nothing to split
  | { kind: "invalid-args"; detail: string }   // Zod parse failure
  | { kind: "precondition"; detail: string };  // catch-all, always with detail
```

Mirrors Shotcut's `…Valid()` guards (`trimClipInValid`, `addTransitionValid`,
…) — but returned as a value, so the bridge/LSP can surface it as a diagnostic.

---

## 1. UUID identity — the load-bearing decision

**`Clip.id` IS the stable op-target uuid.** It already exists on the IR
(`clipSchema.id`, "the load-bearing identity across a session"). Ops target
clips by `id`, never by `(trackIndex, clipIndex)` — indices are ephemeral
(every insert/remove/split renumbers them; this is exactly why Shotcut's undo
snapshots XML and why we instead key on a stable id).

Rules:

- **Every clip carries a uuid.** The builder already guarantees this
  (`nextId("clip")` deterministic counter, or an explicit `id`, or `uuid()` for
  runtime). Ops that mint a clip (split's right half, a future paste) call
  `uuid()` so the new clip is globally unique, and **capture that uuid into the
  inverse** so undo restores the exact same id (inverse correctness law #2).
- **Blanks have no identity.** A `<blank>` is positional gap, not content
  (matches MLT: blanks are anonymous). Ops locate blanks by `(track, index)`
  *within the op*, but the inverse never needs a blank's id — it reconstructs
  blanks from captured lengths.
- **Identity is preserved across move/trim/gain/fade/filter.** These mutate a
  clip in place; the uuid is unchanged (matches Shotcut keeping the producer
  across `moveClip`). Only split *creates* a new uuid (the right half); the left
  half keeps the original (matches Shotcut: `splitClip` inserts a *copy* for the
  left window `[in, in+duration-1]` then resizes the *original* to the right
  `[in+duration, out]`; vean mirrors this so the surviving original id stays on
  the right half… see "Split" below for why we put the new uuid on the right).

### IR addition (small, Move-0-green)

The IR needs **no schema change** for the op layer: `Clip.id` is already the
uuid and ops run on the in-memory IR where it is stable. We add only:

- `clip.uuid` is *not* a new field — we reuse `id`. To make intent legible the
  ops layer re-exports an alias `clipUuid(clip) = clip.id` and the design names
  it "uuid" throughout, but the wire format is unchanged. **No Move-0 gate
  moves** (no serialize/parse/schema diff).

### Known persistence gap (scoped to Move 1b — exact diff recorded)

`Clip.id` is stable **in memory within a session**, which is all the op contract
and its inverse-invariant need. It does **not** yet survive a serialize→parse
round-trip: `serialize.ts` mints ephemeral `producer${N}` ids and emits
`shotcut:uuid="{vean-<producerId>}"`; `parse.ts` sets `clip.id = prod.id`
(`producer0`, …). So if a session *reloads from disk mid-edit*, clip ids change.

This is a real gap but **out of scope for the op contract** (ops + undo operate
on the live IR) and **changing it now would break Move 0's byte-identical
golden** (the emitted `shotcut:uuid` bytes change). The fix, for Move 1b, is a
clean, self-contained diff:

> Route `Clip.id` through `shotcut:uuid`: in `serialize.ts makeProd`, emit
> `shotcut:uuid` = `esc(clip.id)` instead of `{vean-<producerId>}`; in
> `parse.ts resolveProducer`, read `shotcut:uuid` into `clip.id` (falling back to
> the producer id when absent). Re-bless the two `corpus/vean-*.mlt` goldens
> (`bun corpus/build-vean.ts`) since the uuid bytes change. Add a round-trip test
> asserting authored ids survive `fromMlt(toMlt(tl))`.

Recorded here so it is not lost; it lands with Move 1b's serialize work, not on
the op-contract PR (sequencing: it touches Move-0 goldens).

---

## 2. The op taxonomy

Mined from Shotcut `multitrackmodel.cpp`. Each row: **args** · **mutates** ·
**consequences** · **inverse**. All positions are timeline frames from a track's
start; all ids are uuids. Ripple variants take a `rippleAllTracks` flag.

| op | args | mutates | inverse |
|---|---|---|---|
| **append** | `{ track, clip }` | removes the track end-blank placeholder, places `clip` at the end of the track playlist | `remove({ uuid: clip.id, rippleAllTracks:false })` (its lift/remove of the last entry restores the placeholder) |
| **split** | `{ uuid, frame }` | clone the producer; left half `[in, in+Δ-1]` keeps a NEW uuid, right half `[in+Δ, out]` keeps the original uuid; DELETE fade-out filters from the left, fade-in filters from the right; shift filter/keyframe windows on both | `merge({ leftUuid, rightUuid })` (rejoin) — Move 1a ships split's inverse as a captured-data `join` invocation (see Split) |
| **insert** (ripple) | `{ track, clip, position, rippleAllTracks }` | split the covering clip at `position`, insert between halves; if `rippleAllTracks`, push every other unlocked track right by `clip` playtime | `remove({ uuid: clip.id, rippleAllTracks })` |
| **overwrite** | `{ track, clip, position }` | if past track end, pad blank then append; else split-left, remove/split until the region length is consumed, insert `clip` into the hole. **Captures the removed region.** | `overwrite`-restore: `_restoreRegion({ track, position, removed, insertedUuid })` — remove the inserted clip and splice the captured region back |
| **lift** | `{ uuid }` | replace the clip entry with a blank of equal length (leaves a gap); consolidate adjacent blanks | `_unlift({ track, position, clip })` — replace that blank with the captured clip |
| **remove** (ripple) | `{ uuid, rippleAllTracks }` | remove the entry, consolidate blanks (ripple-close); if `rippleAllTracks`, pull other tracks left by the playtime | `_reinsert({ track, position, clip, rippleAllTracks })` — re-open the gap and place the captured clip |
| **replace** | `{ uuid, clip }` | swap the producer at the entry, keep the played window length (resize the new producer to the slot); optionally copy filters | `replace({ uuid, clip: <captured old> })` |
| **trimIn / trimOut** | `{ uuid, delta, rippleAllTracks }` | resize the playlist entry in/out; shift clip-attached fade/keyframe windows by `delta`; non-ripple grows/shrinks the neighbouring blank, ripple shifts other tracks | `trimIn/trimOut({ uuid, delta: -delta, rippleAllTracks })` (scalar inverse) |
| **move** | `{ uuid, toTrack, toPosition, ripple, rippleAllTracks }` | remove (lift or ripple-remove) then re-place (insert or overwrite) at the destination, preserving uuid + group; **captures any overwritten region** | `move` back to the captured origin, plus `_restoreRegion` for anything the forward move overwrote |
| **dissolve** | `{ track, leftUuid, rightUuid, frames }` | overlap two adjacent clips by `frames` → a same-track `Dissolve` IR marker; the neighbours are shortened by `frames` | `removeDissolve({ track, index })` — restore the two clips' lengths and drop the marker |
| **fadeIn / fadeOut** | `{ uuid, frames }` | add/update the `vean.fadeIn`/`vean.fadeOut` sentinel filter (= Shotcut's `fadeIn{Brightness,Volume}`); `frames:0` removes it | `fadeIn/fadeOut({ uuid, frames: <previous> })` (scalar inverse; 0 = none) |
| **gain** | `{ uuid, db }` | find-or-attach the clip's gain (the `Clip.gain` field = Shotcut's `audioGain` volume filter), set level | `gain({ uuid, db: <previous> })` (scalar inverse) |
| **addFilter / removeFilter** | `{ uuid, filter }` / `{ uuid, index }` | attach/detach an (ordered) filter on the producer | the opposite, capturing the filter + its index |
| **addTrack / removeTrack** | `{ kind }` / `{ track }` | add/remove a video or audio playlist; **video prepends** (top = front of compositing), **audio appends** | `removeTrack/addTrack`, capturing the removed track's content + index |

### Args validation

Every op's args have a Zod schema (`src/ops/types.ts`, per-op). `apply` parses
args first; a parse failure is `{ kind:"invalid-args" }`. This is the typed-
input half of "Zod on every op input" (ROADMAP Move 1).

---

## 3. How ops compose from primitives

Shotcut's higher ops are *built out of lower ones* — `overwrite` calls
`splitClip` + `removeRegion`; `move` is `removeClip`/`liftClip` + `insertClip`/
`overwrite`; `removeRegion` is `splitClip` + remove loop. vean factors the same
shared surgery into **pure primitives** (`src/ops/primitives.ts`) that every op
file imports, so an op is a short, legible recipe:

- **Locate** — `findClip(state, uuid) → { trackKind, trackIndex, itemIndex, clip, position }` (the Shotcut `clip_info` + `clip_start`); `findTrack(state, track)`.
- **Entry surgery** (on a single track's `items[]`, pure):
  - `splitEntryAt(items, itemIndex, localFrame)` — the `splitClip` semantics:
    clone, left/right windows, fade-direction filter deletion, keyframe-window
    shift. Returns `{ items, leftUuid, rightUuid }`.
  - `removeRange(items, position, length)` — the `removeRegion` loop (split the
    straddled ends, drop covered entries).
  - `insertAt(items, position, entry)` — split the covering clip, splice between
    halves.
  - `liftAt(items, itemIndex)` / `removeAt(items, itemIndex)` — replace-with-
    blank / drop + `consolidateBlanks`.
  - `consolidateBlanks(items)` — merge adjacent blanks, drop a trailing blank,
    leave a single 0-length placeholder iff the track is empty (the
    `consolidateBlanks` + `removeBlankPlaceholder` semantics).
  - `padToPosition(items, position)` — append a blank so the next append lands at
    `position` (the "add blank to end if needed" branch).
- **Ripple across tracks** — `rippleOtherTracks(state, exceptTrack, position, frames, dir)` — insert/adjust or remove a blank at `position` on every *other* unlocked track (the `insertOrAdjustBlankAt` / `removeRegion`-on-others fan-out).
- **Frame math** — `playtime(clip)=out-in+1`, `trackLength(items)`, `clipStart(items, itemIndex)`, `itemAt(items, position)` (the `get_clip_index_at`).

These primitives are unit-tested in isolation (`tests/op-invariants.test.ts`
also exercises them via the ops). Every op = locate → one or two primitive calls
→ assemble `{state, consequences, inverse}`. **append** and **split** are
implemented as the two reference consumers (split is the trickiest — it drives
`splitEntryAt` including the fade deletion + keyframe shift).

### Split — the subtle one (the reference for fade/keyframe handling)

`split({ uuid, frame })` mirrors `multitrackmodel.cpp::splitClip`:

1. Locate the clip; `local = frame - clipStart` (frames into the played window).
   Guard: `0 < local < playtime` else `EditError "split-at-boundary"`.
2. **Left half** `[in, in+local-1]`, **right half** `[in+local, out]`. The right
   half keeps the **original uuid**; the left half gets a **fresh uuid**. (We
   choose left-new/right-original — Shotcut inserts a copy for the left window
   and resizes the original to the right, so the *original producer object*
   survives as the right entry. Keeping the original uuid on the right matches
   that and means a later op still referencing the pre-split clip lands on the
   tail, the safer default.)
3. **Fade filters:** DELETE `fadeOut` sentinels from the LEFT half and `fadeIn`
   sentinels from the RIGHT half (Shotcut detaches `fadeOut*` from the new copy
   and `fadeIn*` from the original). A `fadeIn` stays on the left (the head still
   fades up); a `fadeOut` stays on the right (the tail still fades down). The
   combined-`InOut` case splits into a left `fadeIn` and a right `fadeOut`.
4. **Keyframe windows:** any *escape-hatch* animated filter (an
   `"0=…;N=…"` property) is re-based per half — see §4 for the exact rule. The
   fade sentinels carry only `{frames}` (no absolute keyframes in the IR — the
   serializer owns the keyframe math), so they need no shift; this is precisely
   why fades are sentinels (§4).
5. **Consequences:** `clipsTrimmed` (original → right window) + `clipsAdded`
   (left half) + `durationDelta:0`.
6. **Inverse:** `join({ leftUuid, rightUuid })` — re-merge the two halves into
   one clip with the original window and uuid, restoring the deleted fades. Move
   1a ships `join` as a stub; split's inverse therefore *captures the pre-split
   clip* and uses a `_unsplit` restore invocation (remove the two halves, splice
   the captured original) so split's inverse-invariant passes **now** without
   waiting for `join`'s body. When `join` lands (its own file), split's inverse
   switches to the symmetric `join` invocation.

---

## 4. Keyframe representation — the decision that resolves the 5 deferred gaps

Move 0 left 5 low/latent gaps in `keyframes.ts` (`parseAnim`/`serializeAnim`),
explicitly deferred because "the edit algebra is their first consumer and should
*shape* the representation." Move 1a is that consumer. The decision:

### Decision: the op layer manipulates fades as **intent sentinels**, and
### escape-hatch keyframes as **typed `Keyframes` models**, with a single
### opaque-string escape — and it keys fade detection on the **`shotcut:filter`
### name**, not the keyframe shape.

Concretely:

1. **Fades are never raw keyframes in the IR.** A clip's fade is the
   `vean.fadeIn`/`vean.fadeOut` *sentinel filter* carrying only `{frames:N}`.
   The serializer compiles it to the proven brightness/volume keyframe shape on
   a 0-based window. **Ops manipulate the sentinel (an integer), never a
   keyframe string** — so `fadeIn`/`fadeOut`/`split` do frame arithmetic on
   `frames`, and the byte-exact keyframe emission stays owned by
   `serialize.ts`. This is why split needs no keyframe surgery for fades, and
   why fades round-trip Shotcut-clean *today* (Move 0 already proved it).

2. **Escape-hatch animated filters use the typed `Keyframes` model.** When an op
   must shift a *non-fade* animation window (trim/split on a clip carrying an
   `affine`/`brightness` escape-hatch filter), it `parseAnim(value, {in})` →
   shifts each `keyframe.frame` by the delta → `serializeAnim(model, {in})`.
   The model already round-trips byte-faithfully (Move 0 golden). **Re-basing
   rule on split/trim:** subtract the trimmed head frames from every keyframe
   frame, clamp to `[0, playtime-1]`, drop keyframes that fall outside the new
   window (matches `MLT.adjustClipFilters` shifting filter in/out by the split
   delta). Move 1a *defines* this rule and the helper `shiftKeyframeWindow`;
   the full per-filter resolve-path can land in Move 1b, but the **append +
   split reference ops do not need it** (their fixtures use fade sentinels +
   from-zero windows), so they pass now.

3. **The 5 gaps, resolved:**

   - **Gap 1 (timecode `:FF` re-spelled as `.mmm`).** *Resolution: add a
     `Keyframe.timecodeSubform: ":ff" | ".mmm"` flag* (Move 1b impl). The op
     layer never *authors* timecode keyframes (it works in integer frames), so
     it can't regress this; the flag is the shaping decision recorded now, with
     `formatTime` switching on it.
   - **Gap 2 (empty value `0=` fabricates `0`).** *Resolution: an empty value
     body parses to the opaque-string family (gap 3), not a number* — `0=`
     becomes `{ type:"opaque", raw:"" }`, serialized back as `0=`. Decided now;
     impl with gap 3.
   - **Gap 3 (quoted/text value `0="a;b"`, `0=normal` throws).** *Resolution:
     add an `OpaqueValue = { type:"opaque"; raw:string }` member to
     `KeyframeValue`.* `parseValue` falls back to opaque when a token is neither
     color/rect/scalar; `serializeAnim` re-quotes an opaque containing `;`/`=`.
     This is the representation the edit algebra needs so a clip carrying a text-
     valued animated filter survives trim/split. **This is the load-bearing one**
     — it makes the `KeyframeValue` union total, so no op can throw on a
     legal-but-exotic property.
   - **Gap 4 (sub-ms timecode drift).** Same `formatTime` family as gap 1; the
     `:ff` subform avoids the lossy ms rounding for frame-aligned times. Resolved
     by gap 1's flag.
   - **Gap 5 (a genuine 2-keyframe `0=0;N=1` brightness misclassified as a
     fade).** *Resolution: key fade detection on the filter's `shotcut:filter`
     name (`fadeInBrightness`/…), NOT the keyframe shape.* `parse.ts
     classifyFilters`/`fadeFromKeyframes` already names the recovered sentinel;
     the op layer's `isFadeFilter(f)` checks `f.shotcutName ∈ {fadeIn*,fadeOut*}`
     OR `f.service ∈ {vean.fadeIn, vean.fadeOut}` — never the bare 2-keyframe
     shape. So a real edge-anchored ramp the user authored stays a literal
     filter and survives ops untouched.

   Gaps 1/2/4 are spelling/edge refinements with **no op that can trigger them in
   Move 1a** (the algebra is integer-frame and fade-via-sentinel). Gap 3 (opaque
   value) + gap 5 (name-keyed fade detection) are the two the algebra *does*
   depend on; their **representation is decided here** and the impl lands in
   Move 1b (`tests/keyframes.test.ts` is their home, per Move-0 GATE). Crucially,
   **fades manipulated by the reference ops round-trip Shotcut-clean now** —
   because they never become raw keyframes (decision #1).

### Why this is the right shape

It keeps the *hot path* (fades, the 99% case) as integer intent the ops reason
about trivially and the serializer renders exactly, while giving the *cold path*
(arbitrary animated escape-hatch filters) a total, round-trippable typed model.
No op ever fabricates or drops a keyframe value, and fade detection can never
collide with a user's legitimate ramp.

---

## 5. File layout (Move 1a)

```
src/ops/
  types.ts        the Op / OpResult / Consequences / EditError contract + per-op arg Zod schemas
  primitives.ts   the shared pure playlist-surgery (locate, splitEntryAt, removeRange, insertAt, blanks, ripple, frame math)
  append.ts       ✅ implemented (reference) + `samples`
  split.ts        ✅ implemented (reference, the fade-deletion consumer) + `samples`
  insert.ts overwrite.ts lift.ts remove.ts replace.ts trim.ts move.ts
  dissolve.ts fade.ts gain.ts filter.ts track.ts   ← STUBS (finalized signatures, body throws NotImplemented), each its own file
  index.ts        the op REGISTRY (name → op fn) + `apply` dispatcher + `samples` collection
```

`src/index.ts` re-exports `./ops`. Each op file exports: the op function, its
args Zod schema, and a `samples` fixture (see §6) so the registry-driven
invariant harness picks it up automatically.

---

## 6. The `samples` convention (what build agents must follow)

`tests/op-invariants.test.ts` is **registry-driven**: it iterates every op in
the registry and, for each that exposes a `samples` fixture, asserts the two
laws (inverse round-trip + serialize/round-trip). A build agent filling a stub
**only adds its `samples`** and the harness covers it.

Each op file exports:

```ts
export const samples: OpSample[] = [ … ];

type OpSample = {
  name: string;                 // human label for the test case
  state: () => Timeline;        // a FRESH start state built from the IR builder/corpus
  args: <the op's args>;        // valid args against `state`
};
```

Rules:

1. **`state` is a thunk** returning a fresh timeline built with the `@/`
   builder (call `resetIds()` first for determinism), or a corpus fixture. Never
   share a mutable instance between cases.
2. **`args` must be valid** for `state` (the harness asserts the op does *not*
   error). To test an error path, that's a *separate* unit test in the op's own
   file, not a `samples` entry.
3. **At least one sample per op**, covering its primary path. Add cases for
   ripple variants and the fade/keyframe interaction where relevant.
4. The harness asserts, per sample: (a) `apply(inverse, apply(op).state).state`
   deep-equals `state()`; (b) `toMlt(result.state)` parses namespace-clean and
   `fromMlt∘toMlt` is a stable fixpoint. **append + split pass now; the rest pass
   as their bodies land.**

A build agent's checklist for a stub: implement the body to satisfy the op
contract (§0), fill `consequences` and `inverse`, add ≥1 `samples` entry, run
`bun run test` — the harness will exercise it.
