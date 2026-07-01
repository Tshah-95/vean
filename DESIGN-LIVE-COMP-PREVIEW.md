# DESIGN — Live Remotion composition preview ("Remotion Studio, inside our playback")

Status: **scoping** (branch `live-comp-preview`, isolated worktree). Not yet built.
Date: 2026-06-30.
Companion to [DESIGN-LIVE-PREVIEW.md](DESIGN-LIVE-PREVIEW.md) (the footage compositor / decode tiers).

This doc answers the four questions from the brief: **the constraints**, **what we need to
build**, **why it must be built that way**, and **what works best long-term** — grounded in how
Remotion actually loads compositions, not hand-waving. Inputs: a 3-thread research sweep
(Remotion embedding/bundling mechanism; our viewer↔Remotion seam at code level; parity/perf/audio
constraints).

---

## 0. The decision, in one paragraph

The flicker debate surfaced the real architectural fork: **bake the Remotion comp to an alpha
`.mov` and decode it as a second video source, or render the comp live as React over the footage.**
Live render is **structurally lighter for preview** — one decoded source (footage) instead of two,
and the second source we'd drop is the *heaviest* (10-bit 4:4:4 + alpha ProRes). For the content
that matters (text, lower-thirds, kinetic type, data graphics — vean's whole reason to use
Remotion) live render wins decisively. **We keep baking for *export* (the alpha `.mov` is the truth)
and for heavy comps; we add live render for *preview/authoring*** so you can scrub and edit the comp
without a pre-bake round-trip. The surprise from the research: this is a *small* core change, because
vean is already shaped exactly the way Remotion recommends.

---

## 1. The core finding — we are already 90% of the way there

Remotion is explicit (`/docs/miscellaneous/embed-studio`): **you cannot embed Remotion Studio**, and
there is **no first-class API to load an arbitrary user composition** into a player. Their *recommended*
pattern instead is: **own your bundler, drive a paused `@remotion/player` via `seekTo`, build your own
UI around it.** That is a precise description of what vean already is:

| Remotion's recommended live-preview architecture | vean today |
|---|---|
| Own the bundler/build | The viewer is a **Vite app**; the parallel session just made the **live HMR dev viewer the default** (`bdaea1d`) |
| Comps are TSX you control | `remotion/src/compositions/*.tsx`, aliased into the viewer as `@remotion-comp` ([viewer/vite.config.ts](viewer/vite.config.ts)) |
| `<Player>` slaved to an external clock via `seekTo`, kept paused | `OverlayPlayer` already does exactly this — paused Player, `seekTo(masterFrame)` on every clock tick ([viewer/src/components/OverlayPlayer.tsx](viewer/src/components/OverlayPlayer.tsx)) |
| HMR via the dev server's Fast Refresh | Vite Fast Refresh — free, once comps are in the module graph |

**The single thing in the way** is [viewer/src/remotion/registry.ts](viewer/src/remotion/registry.ts):
a **static `COMPOSITIONS` const** with one entry (`LowerThird`), statically imported, frozen into the
bundle at build time. `resolveComposition(id)` (S7 already de-hardcoded it) falls back to the default
for any id it doesn't know — and it only knows `LowerThird`.

**The unlock:** turn that static const into a **dynamic registry built from a Vite glob** of the
project's comp directory:

```ts
// the conceptual shape — Vite turns this into lazy dynamic imports at build/dev time,
// and WATCHES the globbed files, so editing a comp hot-reloads it.
const modules = import.meta.glob("@remotion-comp/*.tsx"); // { "./Foo.tsx": () => import(...) }
```

Every comp in the project becomes resolvable **by id at runtime, with HMR, with zero per-comp
registration.** That is "Remotion Studio's live preview, inside our own playback" — and the bulk of
it is one file. Module Federation / `@remotion/bundler` (the *other* documented path) is **only**
needed for *3rd-party / decoupled* comps that aren't in our build graph — we defer that; we own our
comps.

---

## 2. Constraints (the *why* of the architecture)

These are the load-bearing facts that shape every build decision. Ignoring any one of them produces a
subtly-wrong or slow preview.

### 2.1 The Player is driven imperatively, and swapping comps remounts
- There is **no declarative `<Player frame={n}>`** — the frame is owned internally; you drive it with
  `playerRef.seekTo(frame)` each clock tick, Player kept `autoPlay={false}` / `controls={false}` so
  **the master clock is the sole time authority** (we already do this). Read-back for UI uses the
  official `frameupdate` + `useSyncExternalStore` pattern.
- **Swapping the *mounted component* is a remount** (smooth `seekTo` slaving applies to a single
  mounted comp). So when the active overlay clip changes comp id, expect a mount, not a crossfade —
  design the loading state for it (§2.2).

### 2.2 Loading arbitrary comps: own-Vite-dev-server (strategy C), not Federation, not Studio
- `component` (direct) vs **`lazyComponent`** (a `useCallback`-wrapped `() => import()`, **requires a
  default export**, uses Suspense). The glob gives us lazy importers → feed them to `lazyComponent`,
  or `await` them into a dynamic registry.
- **`remotion`/`react` MUST be deduplicated to a single instance** or hooks break — the viewer's Vite
  already dedupes via the `@remotion-comp` alias workspace; preserve this when the comp set goes
  dynamic.
- **Async lifecycle is the real complexity:** `resolveComposition` becomes async; `OverlayPlayer`
  needs a Suspense boundary / loading state; `deriveOverlay` ([viewer/src/App.tsx](viewer/src/App.tsx))
  must kick the load when it discovers a comp clip; decide what renders while loading (nothing /
  placeholder / last-good).

### 2.3 Per-project comp roots (dev vs prod)
- The glob/HMR path requires the **dev viewer (Vite)** — which is now the default. The comp dir is
  per-repo (`<repo>/remotion/src/compositions/`); the preview server is already per-repo
  ([src/preview/server.ts](src/preview/server.ts)), so Vite's root/alias must resolve the *current
  project's* comp dir. The **prod/`dist` viewer** has a frozen comp set (glob baked at build) — fine
  for distribution, but **live authoring is a dev-viewer capability.** State this explicitly; don't
  promise HMR in the packaged app without a per-project bundling step.

### 2.4 Parity is *managed*, never *achieved* — live is approximate, the bake is truth
Two runtimes, two compositors, no shared frame buffer. Even *inside* Remotion, preview ≠ render
(`<OffthreadVideo>` renders `<video>` in preview, `<Img>` in render). vean stacks a *second*
divergence (browser WebGL2 blend vs melt blend). So:
- **Declare every live frame `approximate`; the alpha-ProRes-into-melt path is the truth; a
  `melt`-still is the on-demand exact oracle.** We already have the exact|approximate scaffolding
  (DESIGN-LIVE-PREVIEW §6/§8) — generalize it to a per-frame flag the UI never lies about.
- **Pin the divergence sources we control:**
  1. **Premultiplied-vs-straight alpha** — the *most likely visible bug*, and it lives in **our**
     WebGL2 compositor, not Remotion. ProRes 4444 carries straight alpha; our compositor is
     premultiplied. Mismatch → fringing on anti-aliased text/soft shadows. **Golden test:** a
     50%-alpha gradient over mid-gray must match (ΔE/SSIM threshold) between live and melt-still.
     (We already shipped `verify:premult` for the *bake* path; extend it to the *live* path.)
  2. **Color space** — force `bt709` end-to-end (the "more accurate" path, default in Remotion v5)
     rather than sRGB-vs-bt709 drift.
  3. **Headless `--gl`** — the bake runs headless (GPU off → SwiftShader rasterizes blur/shadow
     differently than the live GPU). Pin `--gl` and validate that backend.
  4. **`delayRender` + `useBufferState` pairing** — `delayRender` is a no-op in preview; a comp that
     loads a font shows fallback glyphs live but correct glyphs in export unless it also calls
     `delayPlayback()`. **Lint** comps that do one without the other.
- **A drift budget owned by the diagnostics engine:** per comp, compare a live melt-still vs an
  export melt-still; a comp over threshold is flagged "live preview approximate beyond tolerance —
  scrub-stop fetches exact." Turns "never bit-exact" into a measured number.

### 2.5 Performance — live wins for the common case, bake wins for heavy comps
- **The decode-pool win is real:** live render = one footage decode, not footage + a heavy 4:4:4+alpha
  `.mov`. For text/shape/transition overlays, decisively cheaper.
- **Where live render gets expensive (Remotion's own caveats):** heavy WebGL/Three/Skia, big
  blurred/shadowed layers, thousands of DOM/SVG nodes, large per-frame JS — these pay per-frame
  **main-thread** (the thread our clock runs on) + GPU cost.
- **The embed footgun that will tank a complex comp:** an unmemoized `inputProps` re-renders the whole
  comp tree on **every clock tick.** Memoize `inputProps`; render controls as a **sibling with a ref**
  to the Player (Remotion's documented best practice) so the Player re-renders rarely.
- **Knobs:** drive the live Player at a **lower backing resolution during active scrubbing**, full-res
  melt-still on scrub-stop. `logLevel="trace"` surfaces mount/seek/buffer timing for the drive harness.
- **Rule:** the diagnostics engine measures per-comp live-render cost and flags "bake recommended for
  this comp" when it blows the frame budget — same pattern as the drift budget. Live-vs-bake is a
  **per-comp affordance the engine decides, not a global mode.**

### 2.6 Audio — mute the Player, route nothing
- MLT owns all audio mixing; overlay comps are video-only. **Mute the `<Player>` permanently**
  (`initiallyMuted` + `.mute()` on mount, never `.unmute()`). Routing comp audio into our master Web
  Audio graph would create a *second, divergent mixer* — don't. Muting is also the **autoplay-safe**
  path (no audio gesture gate).
- **Lint/reject `<Audio>`/`<Video>`-with-sound inside overlay comps** (it would play in neither path
  — live mutes it, export bakes video-only) — a comp-authoring diagnostic.

### 2.7 Compositing seam — DOM-overlay (Option A), not texture readback
- **Stack the muted `<Player>` as a sibling DOM layer *over* the footage `<canvas>`** (z-index), let
  the browser composite. Pros: trivial, full Remotion feature set, GPU-accelerated, no per-frame
  copy, lowest overhead. This is also what DESIGN-LIVE-PREVIEW already assumes.
- **Reject Option B (render the Player into a WebGL2 texture each frame):** per-frame DOM→texture
  readback is the expensive path and *spends the very perf win we came for*; it only works if comps
  are pure-canvas. Reserve the single-compositor (our premultiply, `bt709`, unified blend) for the
  **melt-exact still and the export**, where exactness is actually *claimed*.
- Consequence: anti-aliased/semi-transparent edges are exactly where live (browser blend) and
  melt-still (export blend) visibly differ — **fine, as long as the UI never claims the live frame is
  exact** and a scrub-stop fetches the melt-still. The premultiply golden keeps the *exact* path
  trustworthy; the `approximate` flag keeps the *live* path honest.

---

## 3. What we build — the roadmap

Phases are independently shippable and verifiable. **P0 is the unlock; P1 makes it real; P2 is the
payoff; P3–P5 make it honest, fast, and authorable.** Each lands behind a gate (golden/drive proof),
matching the repo's verification philosophy.

### P0 — Dynamic composition registry (the unlock)  ·  small
- Replace the static `COMPOSITIONS` const ([viewer/src/remotion/registry.ts](viewer/src/remotion/registry.ts))
  with a registry built from `import.meta.glob("@remotion-comp/*.tsx")` (lazy). `resolveComposition(id)`
  resolves any project comp by id, with the existing default fallback for the unknown/legacy case.
- Each comp exposes its `defaults` (defaultProps) — read them from the module (a named export
  convention, or `getCompositions`-style metadata) so the Player is configured correctly per comp.
- **Gate:** a 2nd, non-`LowerThird` comp added to `remotion/src/compositions/` renders live in the
  viewer, slaved to the clock, **without touching `registry.ts`** (drive proof + `__veanOverlay`
  bridge asserting the resolved comp id).

### P1 — Async load lifecycle  ·  medium
- `resolveComposition` async + `OverlayPlayer` Suspense/loading state; `deriveOverlay` kicks the load
  on comp-clip discovery; define the loading visual (placeholder vs last-good frame).
- Handle the **comp-swap remount** (§2.1) cleanly — no flash of default.
- Per-project comp-root resolution for the dev viewer (§2.3): Vite resolves the *current repo's*
  comp dir via the preview server's `repo`.
- **Gate:** switching between two comps mid-timeline loads + renders each correctly; missing/broken
  comp degrades to a typed error overlay, not a crash.

### P2 — The live-edit (HMR) loop — the payoff  ·  small-medium
- Wire Vite Fast Refresh so **editing a comp's TSX updates the live preview while the Player stays
  mounted** (this is mostly free once P0/P1 land; the work is keeping the Player mounted across HMR +
  preserving the playhead). This is the "Remotion Studio in our playback" deliverable: scrub + edit
  the comp without a pre-bake.
- **Gate:** edit a comp's text/color in `remotion/src/compositions/*.tsx`; the viewer overlay updates
  within the HMR window with the playhead preserved (drive proof).

### P3 — Parity hardening  ·  medium
- Generalize the per-frame `exact|approximate` flag; the `melt`-still oracle on scrub-stop/pin.
- **Live premultiply golden** (extend `verify:premult` to the live WebGL2 path); pin `bt709` +
  headless `--gl`; the per-comp **drift-budget diagnostic**.
- **Gate:** the 50%-alpha-over-gray golden matches live↔melt-still within threshold; a deliberately
  over-budget comp is flagged.

### P4 — Performance guardrails  ·  medium
- Memoize `inputProps`; ref-driven sibling controls; **lower backing resolution during scrub**,
  full-res still on stop; `logLevel=trace` wired into the drive harness.
- The per-comp **live-render-cost budget** → "bake recommended" diagnostic (the engine's live-vs-bake
  call).
- **Gate:** a heavy comp stays interactive at draft res and is flagged "bake recommended"; a light
  comp holds frame budget at full res.

### P5 — Comp-authoring diagnostics  ·  small, ongoing
- Lint comps for: `<Audio>`/`<Video>`-with-sound (§2.6); `delayRender` without `useBufferState`
  (§2.4.4); a declared props schema (so the action/registry layer can drive `inputProps`).
- **Gate:** each rule fires on a crafted bad comp, silent on the clean set (the zero-false-positive
  bar, same as the diagnostics engine).

### Deferred (explicitly out of scope now)
- **Module Federation / `@remotion/bundler`** for 3rd-party/decoupled comps not in our build graph
  (the `remotion-remote-composition` pattern) — only if/when we want to load comps from outside the
  project. We own our comps; not needed yet.
- **Removing the bake from *export*** — export stays baked (alpha `.mov` → melt is the truth). Live
  preview is what becomes un-baked. (Matches "we can deal with the bake for export for now.")
- **HMR in the packaged/`dist` app** — needs a per-project bundling step; the live-authoring loop is a
  dev-viewer feature until then.

---

## 4. What works best long-term — the dual model, owned by the engine

The end state is **not** "live replaces baked." It's **both, and the diagnostics engine decides
per comp:**

- **Live (Vite-loaded React `<Player>`, DOM-overlay, approximate, HMR)** — the default for
  authoring/preview. One decode, instant edit, no pre-bake. Wins for the common case.
- **Baked (alpha ProRes `.mov` → melt)** — the **export truth**, and the preview path for *heavy*
  comps (the engine flags them) and the **exact still oracle** on scrub-stop.

This is squarely vean's thesis: a *typed, diagnosable* engine that owns the **live-vs-bake decision**
(per-comp drift budget + render-cost budget), the **parity contract** (per-frame `approximate` flag +
melt-still oracle), and the **comp-authoring rules** (audio/buffer/schema lint) — instead of a global
mode the user has to reason about. The UI just shows "live (approximate) ⟷ exact still," and the
engine keeps it honest. No NLE does this; it's the same compiler-for-video posture as the rest of the
core.

---

## 5. Complexity / risk summary (the honest read)

| Area | Complexity | Note |
|---|---|---|
| P0 dynamic registry (glob) | **Low** | One file; Vite does the heavy lifting; HMR for free |
| P1 async load lifecycle | **Medium** | Suspense/loading states, comp-swap remount, per-project root — the real "make it robust" work |
| P2 HMR loop | **Low–Med** | Mostly free post-P0/P1; keep Player mounted + playhead across HMR |
| P3 parity | **Medium** | Premultiply golden is the sharp edge (in *our* code); the rest is pinning knobs |
| P4 perf | **Medium** | Memoization + scrub-res are easy; the per-comp cost budget is the engine work |
| P5 authoring lint | **Low** | Additive diagnostics, established pattern |
| Federation (deferred) | **High** | Avoided by owning our comps |

**Biggest risks:** (1) the premultiply/fringing parity bug (mitigated by the live golden + the
`approximate` honesty); (2) the embed re-render footgun tanking a heavy comp (mitigated by memoized
`inputProps` + ref controls); (3) dev-vs-prod HMR expectation gap (state it plainly). None are
blockers; all are known and bounded.

## 6. Dependencies & parallelization
- **P0 → P1 → P2** are sequential (each builds the prior). **P3, P4, P5 can run in parallel** once P1
  lands (disjoint scopes: P3 = driver/golden + diagnostics; P4 = viewer Player embed + a render-cost
  diagnostic; P5 = a comp-lint diagnostic). 
- Independent of `main`'s "make the video look good" work — this whole effort is the viewer↔Remotion
  seam, isolated on `live-comp-preview`.
