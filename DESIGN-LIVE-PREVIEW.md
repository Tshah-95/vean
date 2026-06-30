# Live preview — the no-save edit loop ("HMR for video")

> **Status: BUILT — Tiers 0/1/2 shipped and drive-verified (2026-06-30).** What was
> the design barrier is now the implementation: vean's preview is an in-browser,
> on-demand, per-frame WebGL2 compositor driven straight off the live in-memory IR.
> An edit propagates to the preview frame with **NO save and NO `melt` round-trip**
> (verified: a `lift`/`slip` through the editor hook recomposites the canvas, `0`
> `proxy-render`, `0` `save`, `0` `still`). It sits OVER the Move-0/1 core and
> EXTENDS the Move-5 viewer + Remotion seam; it changes **nothing** in `src/ir`,
> `src/ops`, `src/diagnostics`, or `src/driver`, and it does not move the `melt`
> boundary (the only `src/` additions are the read-side `src/preview/source-proxy.ts`
> short-GOP encoder + COOP/COEP/CORP headers + a session `revision`).
>
> **What shipped, by §9 build order (all green unless noted):**
> | Step | Lands in | Gate evidence |
> |---|---|---|
> | 0 · session `revision` + COOP/COEP/CORP | `src/preview/{session,server}.ts` | `revision` bumps per op/undo; served viewer `crossOriginIsolated === true`; CORP/COOP/COEP headers asserted |
> | 1 · keyframe resolver JS port | `viewer/src/keyframes.ts` | `tests/keyframes-port.test.ts` (89) runs core + port over the SHARED `keyframe-vectors.ts` — byte-for-byte |
> | 2 · Tier 0 source-frame `<video>` | `viewer/src/resolveVisible.ts` | `tests/resolve-visible.test.ts` (14); superseded as the realtime source by Tier 1 (proxy-render kept only as a fallback) |
> | 3 · mediabunny decode layer | `viewer/src/decode/{decode-worker,parallelDecoder}.ts` | mediabunny **inlined in the worker bundle, zero CDN refs**; `window.__veanDecode` decode-proof bridge |
> | 4 · Tier 1 `renderFrame(ir,frame)` | `viewer/src/{resolveLayers,compositor/glCompositor}.ts` | demo.mlt previews fully in-browser — f45 `#0e5c63` (vs GATE-MOVE5 `#0d5c61`, within scaler drift §8.1), lower-third on top, **0 proxy-render**; `tests/resolve-layers.test.ts` (13) |
> | 5 · Tier 2a perf | `viewer/src/decode/frameCache.ts` + worker pool | drive perf: composite median **0.05 ms/frame**, cache hitRate **0.998**, byte-bounded at 522/524 MB with `close()`-on-evict (6763 evicts, no leak), 4 workers, 0 stale-dropped; short-GOP H.264 proxy `-g 15` confirmed via ffprobe; `tests/frame-cache.test.ts` (12) |
> | 6 · Tier 2b audio + melt-still | `viewer/src/{audio/audioGraph,resolveAudio}.ts` | AudioGraph 48 kHz slaved to clock; `window.__veanApprox` exact-still bridge (`requestExactStill`); `tests/resolve-audio.test.ts` (8) |
>
> **Tier-by-tier:** Tier 0 **green** (subsumed by Tier 1). Tier 1 **green** (multi-track
> over-composite + dissolve + Remotion overlay, drive-proven on `corpus/demo/demo.mlt`
> AND `projects/retire`). Tier 2a **green** (perf + bounded memory measured under the
> budget). Tier 2b **green for video-locked audio + the on-demand still affordance**;
> the longer-soak A/V-drift-over-minutes assertion (§8.6) is exercised structurally,
> not yet over a literal multi-minute headless play.
>
> **Honest residuals** (the §8 hard parts, by design, not regressions): preview ≠
> export by construction (§8.1 — never asserted against browser pixels; `melt` +
> still-compare stays ground truth); per-filter effect parity is ongoing (§8.4 — the
> §7 `approximate` rows fall back to an on-demand `melt` still); HEVC stays
> proxy-only (§8.2). Root `bun run lint` reports pre-existing failures in unrelated
> `src/{cli,conform,state}` files (the `feat(state)` commit), NOT in any live-preview
> file; `viewer/` is biome-excluded by config and gated by `tsc` + `vite build`.

The load-bearing principle, stated once: **state is the source of truth in
memory; the playhead frame is pulled on demand; `melt` is a separate, slow,
exact export path it never touches in the preview loop.** Every industry NLE that
feels instant works this way. vean already has the hard half (a typed IR, a pure
edit algebra with inverses, an in-memory session with undo/redo, a master clock,
a live `@remotion/player` overlay). What's missing is exactly the other half: an
on-demand WebCodecs footage compositor. This doc specifies that half, grounded in
four reference editors read line-by-line and one WebCodecs spike run on this
machine.

---

## 0. The problem — today's preview is the export path in disguise

The Move-5 viewer composites a footage-proxy `<video>` UNDER an `@remotion/player`
overlay, both slaved to one master clock. The Remotion half is already right
(live `<Player>`, seeked imperatively). **The footage half is wrong.** Concretely,
the loop today is:

1. The user edits → the op mutates the in-memory session IR
   (`src/preview/session.ts:165` `applyOp` → `mutate` → the shared edit algebra).
2. To *see* the edit, the viewer must call `POST /api/proxy-render`
   (`src/preview/server.ts`), which runs `buildFootageProxy`
   (`src/preview/proxy.ts`): it serializes a STRIPPED clone of the IR to a temp
   `.mlt`, shells out to **`melt`** to render a low-res mp4 of the *whole
   timeline*, caches it under `.vean/cache/proxy/`, and returns a `proxyUrl`.
3. `PreviewPane.tsx` points a `<video src={proxyUrl}>` at that mp4 and scrubs it
   by setting `video.currentTime` (`viewer/src/components/PreviewPane.tsx:100-108`).

This is **the export pipeline misused for preview.** Its costs are structural,
not tunable:

- **A whole-timeline render to see one frame.** Changing a single cut re-renders
  the entire proxy mp4 through `melt` + `libx264` before the change is visible.
  That is seconds-to-minutes of latency for a sub-millisecond edit. The proxy
  module's own header admits it: *"a low-res render … shells out to `melt`."*
- **A file round-trip in the hot loop.** `proxy.ts` writes a stripped `.mlt`,
  spawns a subprocess, writes an mp4, then the browser fetches it. None of that
  belongs between a keystroke and a repaint.
- **No frame-exact scrub of the live edit.** `<video>.currentTime` lands on
  whatever frame the proxy's GOP allows; the edit you're judging is frozen in a
  pre-rendered file, not derived from the IR you're mutating.
- **The proxy is stale the instant you edit.** The session IR moved; the mp4 did
  not. Every edit invalidates the entire artifact.

`src/preview/proxy.ts` is a fine *export-adjacent* helper — and it stays, as a
fallback (Tier 2 §6.3). But it must not be the realtime footage source. The fix
is to derive the footage layer the same way the Remotion layer already is:
**composited live in the browser from the in-memory document, never from a file.**

---

## 1. The universal pattern — in-memory graph, on-demand frame, two pipelines

Four browser NLEs were read in full for this design (clones under
`/private/tmp/vean-lpr`). They differ in framework (Zustand, custom slate, signals)
and compositor (WebGPU, Rust/wgpu, PIXI/WebGL) but converge on **one shape**:

```
   in-memory edit state ──(an edit is a state mutation, never a save)──┐
            │                                                          │
            │  pure function:  renderFrame(state, playheadFrame)       │
            ▼                                                          │
   resolve which clips/text/transitions are LIVE at this frame ◄───────┘
            │
            ▼
   decode each live clip's source frame  (WebCodecs, hardware, GPU-resident)
            │
            ▼
   composite the layers by track z-order  (WebGL / WebGPU, ~one pass)
            │
            ▼
   present ONE frame to a canvas      ── repeats next rAF tick iff
                                          (frame changed) OR (state changed)
```

The "HMR" is not a special mechanism — it is the *absence* of one. An edit
invalidates the cached frame for the current playhead; the same on-demand
compositor that handles scrubbing re-pulls and repaints. Three independent
realizations of the exact same loop:

- **OpenReel** (`/private/tmp/vean-lpr/openreel-video`): `renderFrame(project,
  time) → {image: ImageBitmap}` is a pure function of `(project, time)`
  (`packages/core/src/video/video-engine.ts:528`). Reactivity is a React
  `useEffect` keyed on **both** `playheadPosition` AND `project.modifiedAt`
  (`apps/web/src/components/editor/Preview.tsx:4777`). An edit bumps a monotonic
  `modifiedAt`; the effect re-pulls the frame. That is the entire HMR loop, in
  ~80 lines.
- **OpenCut** (`/private/tmp/vean-lpr/opencut-classic`): a pure `buildScene(state)
  → renderTree` (`apps/web/src/services/renderer/scene-builder.ts:226`), then a
  single persistent `requestAnimationFrame` loop whose paint guard is
  `if (frame === lastFrame && renderTree === lastScene) return`
  (`apps/web/src/preview/components/index.tsx:197-202`). An edit swaps the
  `renderTree` *object identity*; the next tick repaints. No save, no serialize.
- **omniclip** (`/private/tmp/vean-lpr/omniclip`): `compose_effects(effects,
  timecode)` diffs the live effects against the on-stage sprites by stable
  `effect.id` and calls `app.render()` once
  (`s/context/controllers/compositor/controller.ts`). The state object IS the
  source of truth; the canvas reconciles to it directly.

And all three keep **two compositing pipelines**: a fast/approximate browser path
for live feedback, and a slow/exact path for export (OpenCut/omniclip encode
in-browser; vean's exact path is `melt`). OpenCut even flags it in code — an
`isPreview` boolean caps preview image size at 2048px
(`scene-builder.ts:102-104`). **vean already accepts this exact bargain** for the
Remotion seam ("Live preview ≠ bit-exact export," `OverlayPlayer.tsx:9`,
`AGENTS.md` Remotion seam). Live preview generalizes it from *just the Remotion
layer* to *the whole frame*.

---

## 2. vean's constraint is the ideal shape for this

vean cannot link `libmlt` (Hard boundary #1/#2 — AGPL-by-choice, arm's-length
`melt` subprocess). Shotcut and Kdenlive get live preview *for free* because they
link MLT in-process and render the playhead frame through `libmlt`. vean cannot.

**That constraint is not a handicap here — it forces the correct architecture.**
The browser-side WebCodecs + WebGL compositor:

- **needs no `melt` and no `libmlt`.** WebCodecs is the *browser's own* hardware
  decoder (VideoToolbox on macOS, D3D11VA on Windows). The decode never crosses
  the `melt` subprocess boundary.
- **adds zero GPL surface.** The one new dependency considered, **mediabunny**
  (the decode library OpenReel and OpenCut both use), is **MPL-2.0** — weak,
  file-level copyleft, pure-TypeScript, browser-side. It links no GPL code, never
  touches `melt`/`libmlt`, and stays entirely on the viewer side. It does **not**
  affect vean's AGPL+CLA dual-licensing escape hatch (depend on it as a package;
  never vendor-and-edit — a fork would have to re-publish under MPL-2.0).
- **keeps the core untouched.** `src/ir`, `src/ops`, `src/diagnostics`,
  `src/driver` stay deterministic and file-based. The compositor is a *read-side
  projection* of the IR that lives in `viewer/`. The canonical document, the edit
  algebra, the diagnostics, and the exact render are all exactly where they were.

So the boundary that looks like a limitation (no in-process MLT) is precisely what
points vean at the same architecture every modern web NLE independently arrived
at. `melt` remains the **one** exact/slow renderer, invoked for export and for an
on-demand "exact this frame" fallback (§6.3) — never in the scrub loop.

---

## 3. Where vean already is (and what to reuse, not rebuild)

vean is roughly half-built toward this. The reusable pieces, with their analog in
the reference editors:

| vean has, today | file | reference analog | reuse as |
|---|---|---|---|
| Typed, frame-exact IR (integer frames, rational fps `[num,den]`) | `src/ir/types.ts` | OpenCut tracks / OpenReel project — but vean's is *stricter* | the source of truth `renderFrame` reads |
| Pure edit algebra `op(state) → {state', consequences, inverse}` | `src/ops` | omniclip immer mutators — vean's is *richer* (stores inverses, not snapshots) | the only mutation path; keep it |
| In-memory session + undo/redo, **no disk write until save** | `src/preview/session.ts` | OpenCut's preview-vs-commit; OpenReel's project store | the live document the compositor watches |
| Master clock, single rAF writer of the integer playhead | `viewer/src/clock.ts` | OpenReel `MasterTimelineClock`; OpenCut `PlaybackManager` | the clock that drives `renderFrame` per tick |
| Live `@remotion/player` overlay, seeked imperatively to the master frame | `viewer/src/components/OverlayPlayer.tsx` | omniclip's top-z alpha sprite | the upper compositor layer, **unchanged** |
| Composited preview pane (footage UNDER overlay) | `viewer/src/components/PreviewPane.tsx` | the stage everyone has | the host the new `<canvas>` replaces the `<video>` in |
| Typed read/write API to the session | `viewer/src/api.ts`, `src/preview/server.ts` | — | the transport the viewer already uses |

**What's missing is exactly the right half of the reference loop:** the on-demand
WebCodecs decode → cache → composite stack for the *footage* layer. vean has the
graph, the algebra, the clock, the overlay, and the host pane. It is missing the
footage compositor that turns "the IR at frame F" into "a pixel buffer for frame
F" without `melt`.

Two specific gaps to close, both small:

1. **The session needs a monotonic revision.** `SessionEditResult` already returns
   the new `ir` on every op/undo/redo (`session.ts:61`). Add a monotonic
   `revision: number` (the analog of OpenReel's `modifiedAt` / OpenCut's
   `renderTree` identity) so the viewer can key a draw effect on
   `(currentFrame, revision)` instead of deep-diffing the IR.
2. **The master clock is wall-clock during play** (`clock.ts:112` `tick` uses
   `performance.now()`). That is fine for video-only Tier 0/1; when audio comes
   online (Tier 2) the clock's *time source* must become `AudioContext.currentTime`
   so A/V stays sample-locked. The clock's public surface (`seekTo`/`play`/`pause`,
   one `currentFrame` writer) does not change — only its internal time base.

---

## 4. The browser compositor — `renderFrame(ir, frame)`

The heart is one pure function, the read-side mirror of the serializer's track
walk:

```
renderFrame(ir, frame) -> ImageBitmap        // pure: same (ir, frame) -> same frame
```

It does what `serialize.ts:walkTrack` does, but **evaluated at a frame instead of
emitted as XML**:

1. **Resolve the visible set.** For each video track, walk the playlist (entries,
   blanks, dissolves) to find what covers integer `frame`; compute each live
   clip's *source* frame as `clip.in + (frame - clipStart)`. Keep integers
   throughout — vean's load-bearing invariant. Derive seconds **only** at the
   decode boundary: `seconds = sourceFrame * fps[1] / fps[0]` (the same exact
   rational conversion `clock.ts:57` already uses; never a float fps).
2. **Decode each footage layer.** Pull the decoded frame at `seconds` from the
   per-clip decoder (§5). Identity = the clip's stable producer UUID (vean's
   invariant), so the decode cache survives ripple/trim edits that only move the
   clip on the timeline.
3. **Resolve animated properties at the frame.** Filters/transforms with keyframes
   (`"0=100;50~=0"`) resolve to a concrete value at `frame` via vean's keyframe
   engine. The interpolation (`Interp`: linear / discrete / smooth-Catmull-Rom /
   `$` / `-` / penner — `src/ir/keyframes.ts:36-46`) MUST be ported to JS and stay
   byte-faithful to the Move-1 engine, sharing the same golden test vectors. A
   fade ramp that interpolates even slightly differently in the browser desyncs
   the preview from the export.
4. **Composite by track z-order.** Lower track index = lower z; upper tracks
   composite on top (the live equivalent of `qtblend`'s `a_track`/`b_track`,
   `serialize.ts:397`). One WebGL/WebGPU pass.
5. **Return one frame.** A GPU-resident `ImageBitmap` / texture the pane draws.

The `@remotion/player` overlay draws ON TOP of this canvas exactly as it does
today — its transparent regions reveal the composited footage for free
(`OverlayPlayer.tsx`). Two compositors, one editor track, just as the Remotion
seam already prescribes.

**Reactivity = an effect keyed on `(currentFrame, revision)`.** This is the whole
HMR mechanism, lifted verbatim from `Preview.tsx:4777` and `index.tsx:197`:

- a `currentFrame` change → render immediately (scrub must feel instant);
- a `revision`-only change (an edit at the same frame) → debounce ~150ms so a
  burst of edits paints once (`Preview.tsx:4835`);
- a single in-flight render with latest-time coalescing, so the compositor never
  queues a stale frame (`Preview.tsx:4804-4826`).

Playback is *the same function on a clock*: the master rAF loop advances
`currentFrame`, and each tick calls `renderFrame(ir, frame)` and draws it. Scrub
and playback are one code path.

---

## 5. The decode pipeline — WebCodecs via mediabunny

The single most adoptable piece. Both OpenReel and OpenCut decode through
**mediabunny** rather than hand-rolling `VideoDecoder`, and the spike confirmed
why: raw `VideoDecoder` has sharp edges (see §8). mediabunny wraps pure-TS demux +
WebCodecs hardware decode + frame-accurate random-access seek behind one call:

```
const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
const track = await input.getPrimaryVideoTrack();
const sink  = new CanvasSink(track, { width, height, fit: "contain", poolSize: N });
const frame = await sink.getCanvas(sourceSeconds);   // frame whose start ts <= time
```

The disciplines to port (framework-agnostic, depend only on mediabunny +
`ImageBitmap`):

- **Per-clip resource cache** keyed by the producer UUID: the `Input` / `CanvasSink`
  / track handles are created **once per clip** and reused across seeks
  (`decode-worker.ts:40`). Re-creating the demuxer per frame is the classic perf
  trap.
- **Decoded-frame LRU**, keyed by `(producerUUID, sourceFrame)` — NOT
  timeline-time, so frames survive edits that only reposition the clip
  (`frame-cache.ts`). Byte-accounted eviction (`~4·w·h` bytes/frame, e.g.
  `maxSizeBytes ≈ 500MB`), LRU by `lastAccessed`, and **explicit
  `ImageBitmap.close()` on every evict** (the #1 OOM, §8).
- **Decode-ahead / preload.** Around the playhead, compute the missing frame set
  (`getPreloadRange(currentTime, ahead≈30, behind≈10)`, `frame-cache.ts:242`) and
  feed a priority queue with `AbortController`s so a seek cancels stale preload
  work. OpenCut's variant is a **seek-vs-iterate heuristic**: if the target is
  within ~2s ahead, forward-iterate the decoder (cheap, in-GOP); else keyframe-seek
  (`video-cache/service.ts:80-99`), with a per-media **generation counter** that
  cancels in-flight decodes for old playhead positions (the scrub-lag killer).
- **Worker pool.** `navigator.hardwareConcurrency` (capped ~4) module workers each
  running the decode worker; least-busy scheduling, a small in-flight cap, an
  overflow queue, and **zero-copy** `postMessage(resp, {transfer:[bitmap]})`
  (`parallel-frame-decoder.ts`). Decode off the main thread keeps the 16ms paint
  budget for compositing + UI.

**Offline-first caveat:** OpenReel imports mediabunny inside its workers with an
`esm.sh` CDN fallback (`decode-worker.ts:44-61`). vean is no-network — **bundle
mediabunny into the worker via the Vite worker build and drop the CDN fallback.**

---

## 6. The tiered plan

Three tiers, each with concrete techniques lifted from the references and a
**verifiable acceptance gate**. Every gate is driveable headless via the existing
`drive` harness — `bun scripts/drive.ts up --project <p> --timeline <route>` boots
the real `viewer/` + preview server on loopback, and `agent-browser --session vean`
drives the byte-identical frontend the Mac app renders (the app's WKWebView just
navigates to the same loopback URL — `scripts/drive.ts` header). Nothing stacks on
an unverified tier.

### Tier 0 — cuts/layout liveness via source-frame seeking (the smallest real win)

> **SHIPPED (green, subsumed by Tier 1).** `viewer/src/resolveVisible.ts` answers the
> "which source clip + source frame is live at the playhead" walk; `revision` drives
> the re-resolve. Tier 1's compositor superseded the pooled-`<video>` presentation,
> so the realtime footage source is now the WebGL2 canvas, never `proxy-render`
> (which survives only as the §6.3 fallback). The acceptance gate below is met by the
> Tier-1 drive runs (zero `proxy-render`/`melt` on edit; edit→repaint within the
> debounce window).

**Goal:** kill the `melt`-proxy-for-preview round-trip for the common case —
single-clip-at-a-time footage, cuts, trims, ripple, track layout — using one
`<video>` per source seeked by source-time, no compositor yet.

This is deliberately the *cheapest* path to "edits are live": it does NOT need
WebCodecs or a GPU compositor. It replaces the *whole-timeline melt proxy* with
**per-source-clip `<video>` elements seeked to the source frame** the playhead
resolves to. The viewer already knows how to seek a `<video>` by source time
(`PreviewPane.tsx:96-108`); Tier 0 generalizes it from "one proxy of the whole
timeline" to "the source clip live at the playhead, seeked to its source frame,"
derived from the live IR. Multi-track overlap and transitions are deferred to
Tier 1 (until then, the topmost covering clip wins).

- **Technique (from):** omniclip's HTMLVideoElement-as-texture path
  (`video-manager.ts add_video_effect`) and its `seek()` → await `seeked`
  precision (`controller.ts`); the resolve-visible-set walk mirrors
  `serialize.ts:walkTrack` evaluated at a frame.
- **vean wiring:** add `revision` to the session (§3); in the viewer, on
  `(currentFrame, revision)` resolve the IR to "which source clip + source frame is
  live," point a pooled `<video>` at that source, set `currentTime`. Delete the
  `/api/proxy-render`-on-every-edit dependency for this case.

**Acceptance gate (driveable):** boot a single-track project via `drive up`; apply
a `trim`/`ripple` op through `/api/apply-op`; assert (a) **no** `POST
/api/proxy-render` and **no** `melt` subprocess fires for the edit, and (b) the
preview `<video>` lands on the new source frame within one debounce window. A
`render.still` from `melt` at the same frame matches the previewed source frame
(modulo scaler/color drift — §7). Wall-clock from edit→repaint < 150ms.

### Tier 1 — the browser multi-track + transition + Remotion-overlay compositor

> **SHIPPED (green).** `viewer/src/compositor/glCompositor.ts` (WebGL2 stage, z-order
> quads, premultiplied-alpha over-composite, gl-transitions fade/luma) +
> `viewer/src/resolveLayers.ts` (the `walkTrack`-mirroring multi-track + dissolve +
> fade/opacity resolver). Drive-proven on **two** projects: `corpus/demo/demo.mlt`
> (footage cross-fade + LowerThird graphic overlay via the Remotion `<Player>`) AND
> `projects/retire` (PXL footage base + a **baked** `chat.mov` overlay the footage
> compositor decodes — the load-bearing correction in commit `ba0948c`: a non-graphic
> over-composite clip is decoded, not handed to the `<Player>`). Both composite the
> overlay on top of live footage with **zero `proxy-render`**.

**Goal:** the real `renderFrame(ir, frame)` — multiple video tracks, dissolves and
field transitions, per-clip fades/filters, with the Remotion overlay on top — all
composited in the browser from the live IR.

- **Decode:** mediabunny `CanvasSink.getCanvas(sourceSeconds)` per clip, the
  per-clip resource cache (§5). `CanvasSink({alpha:true})` for any layer that
  needs transparency (`mediabunny.d.ts:640`).
- **Composite:** one WebGL2 (WebGPU where available, WebGL2 fallback) stage; one
  sprite/quad per visible clip; `zIndex = trackIndex` for z-order
  (omniclip `controller.ts:49`, `video-manager.ts:106`). Keep vean in TypeScript —
  do **not** adopt OpenCut's Rust/wgpu module; port its *texture-cache discipline*
  instead (decoded frames cached by source identity, static layers by content-hash
  into persistent `OffscreenCanvas`es, `wasm-compositor.ts:99-182`) so only the
  changed layer re-uploads per frame.
- **Transitions as shaders** (the MLT-service → shader table, §7): render
  outgoing → `rtFrom`, incoming → `rtTo`, run a `gl-transitions` GLSL fragment with
  `{from, to, progress, ratio}`, `progress = (frame − transIn) / (transOut −
  transIn)` (omniclip `transition-manager.ts:179-277`;
  `/private/tmp/vean-lpr/gl-transitions/transitions/{fade,luma}.glsl`).
- **Remotion overlay:** unchanged — `@remotion/player` composites over the footage
  canvas, transparent regions reveal footage (`OverlayPlayer.tsx`). The footage
  `<video>` of Tier 0 becomes the footage `<canvas>` here, and the
  `/api/proxy-render` path is no longer the realtime footage source at all.
- **Keyframe resolver:** the JS port of `src/ir/keyframes.ts`, shared golden
  vectors (§3, §4 step 3).

**Acceptance gate (driveable):** the Move-5 demo timeline (`corpus/demo/demo.mlt`
— footage cross-fade base + `LowerThird` overlay via qtblend + audio bed) previews
**fully in-browser**: `drive up` on it, screenshot at f45 and f80, assert the
footage shows *through* the transparent overlay region and the lower-third renders
on top — the same pixels the Move-5 gate already proved against a real `melt`
export (`GATE-MOVE5.md`: f45 `#0d5c61`, lower-third `#11181f`), now produced by the
browser compositor with **no `melt` call**. A two-track dissolve scrubs frame-exact
across the overlap. Zero `proxy-render` requests during the session.

### Tier 2 — performance: decode-ahead, LRU, workers, proxies, melt render-cache

> **SHIPPED — 2a green, 2b green-with-one-residual.** 2a: `viewer/src/decode/frameCache.ts`
> (byte-bounded LRU, `close()`-on-evict/replace, integer-frame decode-ahead) +
> `viewer/src/decode/parallelDecoder.ts` (4-worker pool, generation-counter stale-seek
> cancel) + `src/preview/source-proxy.ts` (short-GOP `-g 15` / all-intra H.264 960×540
> proxy, ffprobe-confirmed). Measured on `projects/retire`: composite **0.05 ms median**,
> cache **0.998** hit-rate, resident bytes held under the 524 MB cap with evicts ≈ inserts
> (no leak), 0 stale-dropped at rest. 2b: `viewer/src/audio/audioGraph.ts` +
> `resolveAudio.ts` (Web Audio graph, clock time base → `AudioContext.currentTime`) and
> the `window.__veanApprox.requestExactStill` on-demand `melt`-still fallback for
> `approximate`-flagged services. **Residual:** the literal multi-minute A/V-drift soak
> (§8.6) is covered structurally (rational clock, per-clip scheduling), not yet by a real
> 2-minute headless playthrough.

**Goal:** hit the ~16ms/frame budget under playback and heavy scrubbing, on real
footage, and degrade gracefully past it.

- **Decode-ahead + LRU + worker pool:** port `frame-cache.ts` and
  `parallel-frame-decoder.ts` near-verbatim (§5) — they are framework-agnostic.
  The generation-counter stale-seek cancel (OpenCut `service.ts`) is what makes
  scrubbing not lag.
- **Proxies for the live path (§6 of the codec decision):** build a *lightweight
  short-GOP H.264 proxy* for the decode path, not the whole-timeline mp4
  `proxy.ts` builds today. vean already transcodes to H.264 for the proxy; the
  change is what's done with it (demux+WebCodecs+composite, not `<video>.play()`)
  and the encode params (short GOP / all-intra for instant random access, §8.2).
- **`melt` render-cache fallback** (Resolve-style): per MLT service, flag
  preview fidelity `exact | approximate` (§7). For an `approximate` frame the user
  is scrutinizing (a frei0r filter, a non-default blend), the viewer can request a
  single **exact** still from `melt` via the existing `POST /api/still`
  (`render.still`, `server.ts`) and overlay it — the slow exact path used
  on-demand for one frame, never in the scrub loop. This is the *only* place `melt`
  re-enters preview, and it is opt-in per frame.
- **Audio ownership (real scope, not a freebie):** Tier 0/1 can keep audio on the
  old proxy `<video>` (silent footage canvas + a separate audio element) OR move
  audio to a Web Audio graph slaved to the master clock. The honest version is the
  latter: port OpenReel's per-clip `AudioBufferSourceNode` scheduling, switch the
  clock's time base to `AudioContext.currentTime` (§3), and mix gains/fades from
  the IR. Multi-track gain/keyframe mixing will not be sample-accurate via a single
  `<video>` — this is a distinct subsystem with its own A/V-sync correctness bar.

**Acceptance gate (driveable + measured):** on real footage (the HEVC PXL clips +
their H.264 proxies used in the spike), `drive up` and play through: assert steady
decode+composite stays under one frame budget at the profile resolution (the spike
measured ~1ms/frame decode+upload at 1080p — §8.2), scrub seeks land < 33ms median
with a short-GOP proxy, GPU memory stays bounded across a 2-minute scrub (no leak —
every evicted `ImageBitmap`/`VideoFrame` `close()`d), and an `approximate`-flagged
filter triggers exactly one `/api/still` `melt` call when its exact frame is
requested.

---

## 7. The MLT-service → browser mapping

vean knows precisely what it emits (`src/ir/serialize.ts`). Each service maps to a
browser primitive; most are **exact**, a few are **approximate** (flag them for the
Tier-2 `melt` still fallback). Source pointers are vean's emitter + the reference
shader/filter.

| MLT service vean emits | emitted at | browser primitive | fidelity |
|---|---|---|---|
| `luma` dissolve, no luma-file (default `luma:"luma"`) | `serialize.ts:357` | `gl-transitions/fade.glsl` `mix(from,to,progress)` | **exact** |
| `luma` WITH a luma-file resource | `serialize.ts:357` | `gl-transitions/luma.glsl` matte wipe (luma PNG as `sampler2D`) | **exact** |
| `mix` audio cross-fade (sum=1) | `serialize.ts:361` | Web Audio gain crossfade (`gainOut=1−p`, `gainIn=p`) — NOT a shader | **exact** |
| `qtblend` field transition / Remotion over-composite (default normal/distort) | `serialize.ts:397`, `actions/graphic.ts:191` | PIXI/WebGL sprite `zIndex` stack + premultiplied-alpha over-composite; transparent overlay reveals footage | **exact** |
| `brightness`/`level` fade (fade sentinels) | `serialize.ts:261-268` | resolve keyframe at F → multiply sprite RGB by `level` (or `sprite.alpha`) | **exact** |
| `volume`/`gain` (static + fade) | `serialize.ts:278`, `:261` | Web Audio gain node | **exact** |
| `color` clip (resource = hex/named color) | `serialize.ts:528` | solid-fill quad / 1×1 texture — NOT decoded | **exact** |
| brightness/contrast/gamma/saturation/hue, grayscale, color-overlay, opacity | per-clip filters | PIXI `AdjustmentFilter`/`HslAdjustmentFilter`/`ColorOverlayFilter`/`GrayscaleFilter` (`filter-manager.ts:234-621`) | **close** |
| gaussian/box blur | per-clip filters | PIXI `BlurFilter`/`KawaseBlurFilter` (kernel ≠ MLT/frei0r) | **approximate** → melt-still fallback |
| any `frei0r.*` / non-default qtblend blend mode | per-clip filters / transition | best-effort shader or none | **approximate** → melt-still fallback |

**Filter STACK order matters:** `melt` applies filters in document order
(`serialize.ts` stacks fades, then gain, then the rest); PIXI applies `sprite.filters`
in array order. The browser must preserve vean's emission order exactly or stacked
color ops compose differently — assert it.

---

## 8. The honest hard parts

Nothing here is free. Each risk is named with which reference, if any, already
solved it.

### 8.1 Two paths drift — preview ≠ export, by construction

WebCodecs decode + browser-GPU composite will **not** be bit-identical to a `melt`
export: different scalers, YUV→RGB matrices, full-vs-limited range, filter math,
blur kernels, colorspace handling. vean's IR carries a `colorspace` (601/709/240,
`types.ts:53`) a naive sRGB composite ignores. **This is the accepted
"two-compositing-paths" cost** vean already took for the Remotion seam — but it now
spans the whole frame. Mitigations: composite in linear-light where it matters;
flag `approximate` services for the `melt`-still fallback (§6.3, §7); and — load-
bearing — **never assert correctness against browser-composited pixels.** vean's
invariant is "same IR → byte-identical XML," and render-faithfulness is gated by
`melt` + still-compare (`verify:corpus`, `verify:move5`), never in the browser.
Every reference editor accepts this divergence; none claim preview == export.

### 8.2 Codec coverage + the HEVC decision (settled by spike)

A WebCodecs spike ran on this machine (Chromium 149 / real Chrome 149, macOS 26.3,
VideoToolbox), decoding the user's real footage (uniformly HEVC `hvc1` Main 8-bit).
Findings:

- **HEVC decodes here — but hardware-only.** `isConfigSupported` returns
  `supported:true` for `hvc1.*`, and a real `configure()`+`decode()` emitted 60/60
  frames with real pixel content. **But `hardwareAcceleration:'prefer-software'` →
  `supported:false`: Chrome has NO software HEVC decoder.** HEVC-in-WebCodecs works
  iff the machine has hardware HEVC (~91.5% of sessions per WebCodecs telemetry —
  i.e. **~8.5% of users cannot decode HEVC at all**, plus Linux/older GPUs).
- **Decision: build a lightweight H.264 (short-GOP) proxy for the live decode
  path; do not feed raw HEVC to users' browsers.** Reasons: (1) **portability** —
  H.264 `avc1` decodes everywhere (HW or SW); HEVC has no fallback and the web
  editor must not be a black screen for the ~8.5%. (2) **latency** — the proxy is
  2-3× faster to seek; a short/all-intra GOP collapses worst-case seek toward a
  single-keyframe ~6ms (spike: HEVC-1080p seek median 10.7ms / max 35.9ms; H.264-
  1080p median 33ms / max 48ms; **proxy 960×540 median 13.6ms / max 21.3ms**). (3)
  vean **already** builds an H.264 proxy (`src/preview/proxy.ts`); reuse the
  artifact, change only its GOP (`-g 15` or `-intra` for scrub-heavy footage, a
  separate normal-GOP path for export) and demux it with WebCodecs instead of
  `<video>.play()`. Pin `colorSpace`/range when uploading (source is full-range
  `yuvj420p`) to avoid washed-out output.
- **ProRes 4444 (the Remotion alpha-export format) is NOT WebCodecs-decodable** in
  browsers. vean sidesteps this for free: the live Remotion layer comes from
  `@remotion/player` (a React render), NOT from decoding the exported ProRes. The
  bit-exact alpha clip stays `melt`-export-only. This is a hard constraint that
  *happens to match* vean's existing seam, not a choice.
- **Throughput is not the bottleneck.** Steady decode + WebGL upload measured
  ~1ms/frame even at 1080p HEVC (≈16× under budget); the GL draw is ~0.05ms. The
  budget pressure is entirely **seek distance from the nearest keyframe** — which
  the short-GOP proxy + LRU + decode-ahead directly attack.

### 8.3 `ImageBitmap`/`VideoFrame` lifetime — the dominant failure mode

Every decoded frame is GPU-resident and refcounted. **Forgetting `close()` OOMs the
GPU / stalls the decoder within seconds of scrubbing.** OpenReel does it
meticulously (`frame-cache.ts:76`, `playback-controller.ts:415`); omniclip closes
on every draw/replace/skip (`decoder.ts`, `draw_decoded_frame`); the W3C samples
close the replaced pending frame and every skipped stale frame
(`webcodecs/samples/lib/video_renderer.js chooseFrame`). vean's cache MUST own
`close()` on eviction and on replace; **bound the LRU by bytes (`4·w·h`), and the
in-flight decoder pool by frame COUNT** (the decoder has a hard in-flight limit and
hangs silently past it). The spike hit this directly (§8.5).

### 8.4 Effect parity is ongoing per-filter work

OpenCut/omniclip reimplement each effect as a shader; any filter without a browser
implementation simply does not appear in preview (preview shows *fewer* effects
than the exact export). vean inherits this: the §7 `approximate` rows, plus any
new `frei0r.*`/MLT filter, need a shader OR a melt-still fallback. This is not a
one-time port — it's a standing per-filter cost. The honest posture: preview is for
*judgment*, the `melt` export is *ground truth*, and the UI says so.

### 8.5 WebCodecs sharp edges found in the spike (real, while building it)

- **Per-frame `await decode()` DEADLOCKS on inter-frame video.** The HW decoder
  pipelines/reorders (B-frames) and won't emit frame *i* until later chunks are
  queued. The decode loop must be **push-N-then-collect-async** (feed the whole
  keyframe→target GOP, collect outputs as they arrive), never request-await-per-
  frame. (Cost two hung spikes before switching models — and is exactly why
  mediabunny's `getCanvas(time)` abstraction is worth adopting over raw
  `VideoDecoder`.)
- **`isConfigSupported:true` is not proof of decode** (it reported `true` for HEVC,
  VP9, AV1; only a real `configure`+`decode` proved HEVC). Validate codecs with a
  real decode.
- **Codec strings come from the container, per-file** (mp4box reports
  `hvc1.1.6.L123`, no trailing `.B0`, and Chrome accepts it). Don't hardcode a
  codec string; derive it per source (mediabunny/omniclip/getVideoFrames all do).
- **Cross-origin isolation:** raw WebCodecs-in-workers + `SharedArrayBuffer` (for an
  audio ring buffer) need COOP/COEP headers (omniclip ships `coi-serviceworker.js`).
  vean's preview server (`src/preview/server.ts`) must send
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp` and serve every asset/media stream CORP-compatibly, or
  `VideoDecoder`/`SharedArrayBuffer` silently fail. (mediabunny's `CanvasSink` path
  may avoid the SAB requirement for video-only Tier 1; audio Tier 2 will need it.)

### 8.6 A/V sync under decode jitter

Audio is the master clock; video chases it (W3C `media_worker.js`; OpenReel
`MasterTimelineClock`). During heavy edits/scrub, re-composition can starve the rAF
loop and let video lag — drop video frames (`chooseFrame` already does), never block
audio, and consider pausing playback during structural edits. vean's wall-clock
`tick` (`clock.ts:112`) must move to `AudioContext.currentTime` when audio lands
(§3, §6 Tier 2) or 29.97 footage desyncs over minutes — a direct violation of the
rational-time invariant if done in float ms.

---

## 9. Build order (for the follow-up workflow)

Sequenced so nothing stacks on an unverified piece; each step is one bounded,
gateable unit.

0. **Session revision + COOP/COEP.** Add a monotonic `revision` to
   `SessionEditResult` (`src/preview/session.ts`); send COOP/COEP + CORP headers
   from `src/preview/server.ts`. *Gate:* `revision` increments per op/undo/redo;
   `crossOriginIsolated === true` in the served viewer.
1. **Keyframe resolver JS port.** Port `src/ir/keyframes.ts` interpolation to a
   browser module that **shares the Move-1 golden vectors.** *Gate:* the ported
   resolver matches the existing keyframe golden tests byte-for-byte. (This gates
   preview fidelity and is shared with the exporter — do it before any compositor
   work.)
2. **Tier 0 — source-frame `<video>` liveness.** Resolve-visible-set walk + pooled
   `<video>` seeked to source frame; delete `proxy-render`-per-edit for the single-
   clip case. *Gate:* §6 Tier 0.
3. **mediabunny decode layer.** Bundle mediabunny into a Vite worker (no CDN
   fallback); per-clip resource cache; `getCanvas(sourceSeconds)`. *Gate:* a real
   clip decodes a known frame in-browser headlessly.
4. **Tier 1 — `renderFrame(ir, frame)` compositor.** WebGL2(+WebGPU) stage,
   z-order, the §7 mapping (exact rows first), `gl-transitions` dissolve/luma,
   Remotion overlay on top. *Gate:* §6 Tier 1 (the Move-5 demo previews fully
   in-browser, matching the `melt`-export pixels, zero `proxy-render`).
5. **Tier 2a — perf.** Port `frame-cache.ts` (LRU + decode-ahead, byte-bounded,
   `close()` on evict) and `parallel-frame-decoder.ts` (worker pool, generation-
   counter cancel); short-GOP H.264 proxy encode. *Gate:* §6 Tier 2 perf + memory.
6. **Tier 2b — audio + melt-still fallback.** Web Audio graph slaved to the clock
   (clock time base → `AudioContext.currentTime`); per-service `exact|approximate`
   flag + on-demand `/api/still` overlay for flagged frames. *Gate:* multi-track
   gain/fade previews audibly; an `approximate` filter fetches exactly one `melt`
   still on demand; A/V stays locked over a 2-minute play.

When a tier lands and a pattern proves out, **promote it** to a skill under
`.agents/skills/` and fix the AGENTS.md resolver row — per the repo's
keep-the-resolver-healthy rule, written from what actually happened, not guessed
ahead.

---

## References (cloned + read under `/private/tmp/vean-lpr`)

- **OpenReel** `openreel-video` — the closest blueprint. `renderFrame` pure
  compositor (`packages/core/src/video/video-engine.ts:528`), the `(playhead,
  modifiedAt)` HMR effect (`apps/web/src/components/editor/Preview.tsx:4777`),
  `frame-cache.ts` (LRU + decode-ahead), `parallel-frame-decoder.ts` (worker pool),
  mediabunny decode (`decode-worker.ts`).
- **OpenCut** `opencut-classic` — `buildScene` + frame-identity dirty check
  (`apps/web/src/preview/components/index.tsx:185-214`), `video-cache/service.ts`
  (seek-vs-iterate heuristic + generation-counter stale-seek cancel),
  preview-vs-commit overlay (`core/managers/timeline-manager.ts`).
- **omniclip** `omniclip` — one compositor / two frame sources
  (`compositor/parts/video-manager.ts`), `compose_effects` reconcile by stable id
  (`compositor/controller.ts`), `gl-transitions` shader pattern
  (`compositor/parts/transition-manager.ts`).
- **WebCodecs samples** `webcodecs/samples` — `demuxer_mp4.js` (MP4Box →
  `EncodedVideoChunk`), `video_renderer.js` (`chooseFrame` close-stale), audio
  master-clock A/V sync (`media_worker.js`, `web_audio_controller.js`).
- **gl-transitions** `gl-transitions/transitions/{fade,luma}.glsl` — the exact
  dissolve/luma shaders for MLT `luma`.
- **mediabunny** (MPL-2.0) — `CanvasSink.getCanvas/canvasesAtTimestamps`, the
  decode primitive to adopt (`openreel-video/mediabunny.d.ts:598-683`).

vean source grounding this doc: `src/preview/{session.ts,proxy.ts,server.ts}`,
`viewer/src/{clock.ts,api.ts}`, `viewer/src/components/{PreviewPane,OverlayPlayer}.tsx`,
`src/ir/{serialize.ts,keyframes.ts,types.ts}`, `scripts/drive.ts`, `GATE-MOVE5.md`.
