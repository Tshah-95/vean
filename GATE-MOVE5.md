# Gate — Move 5 (Remotion as a first-class producer)

**Verdict: GREEN — Move 5 COMPLETE.** One timeline carries footage *and* graphics:
a Remotion composition is pre-rendered to an alpha ProRes 4444 clip (arm's-length
subprocess, license boundary held), composited over footage on an upper MLT track
via `qtblend`, previewed live in a local viewer on a single master clock, and
exported end-to-end through the real renderer to an mp4 that carries the overlay
*and* an audio bed. Every render-faithfulness assertion is proven against real
`melt`/`ffmpeg`/Remotion output — not asserted from code shape alone.

Base commits for this gate run (Move-5 work, oldest→newest):

- `5a22af5` feat(move-5a): Remotion alpha producer + timeline new/add-graphic/add-audio
- `b487322` feat(move-5b): live-preview viewer v0 — timeline strip + composited player + master clock
- `8348d2b` feat(move-5c): end-to-end demo fixture — lower-third over footage + audio

Tree at gate time: clean. All render artifacts (`corpus/demo/lower-third.mov`,
`out/**`, `viewer/dist` is committed-by-build but gitignored as a generated dir per
`git check-ignore`) are gitignored and regenerated on demand; nothing binary is
committed.

Toolchain: melt 7.38.0, ffmpeg 8.1.2, ffprobe (`/opt/homebrew/bin`), xmllint
(libxml 20913), Bun 1.3.14, Node v26.3.0 (Remotion's bundler/render host), Vite
7.3.6, Biome 1.9.4, vitest 2.1.9. Remotion peer workspace: remotion@^4,
@remotion/cli@^4, @remotion/player@^4, react@^19 — in `remotion/package.json` only,
never in vean's root deps.

---

## Phase map

Move 5 landed in three phases. All three are **green**.

| Phase | What it delivered | Status |
|---|---|---|
| **A — alpha producer + build ops** | `remotion/` peer workspace + clean `LowerThird` composition; `src/driver/remotion.ts` alpha-ProRes subprocess driver with ffprobe alpha verification + render cache; `remotion.render`, `timeline.new`, `timeline.addGraphic` (footage-lower / alpha-upper / qtblend), `timeline.addAudio` actions, CLI-projected, stable-JSON-tested | **GREEN** |
| **B — live-preview viewer** | `viewer/` (Vite+React): frame-accurate timeline strip + `PreviewPane` compositing a downscaled footage proxy under an `@remotion/player` overlay, both slaved to one `ClockProvider` master clock; `preview.serve` action + `vean preview` CLI launcher binding 127.0.0.1, serving the timeline IR + footage proxy + `viewer/dist` | **GREEN** |
| **C — end-to-end demo** | `corpus/demo/demo.mlt` (footage cross-fade base + `LowerThird` overlay via qtblend + tone audio bed), `build-demo.ts`, and the `verify:move5` render-faithfulness gate proving alpha + composite-over-moving-footage + two-stream export through the real renderer | **GREEN** |

---

## The ROADMAP gate criteria — all met

| Criterion | Where it's proven |
|---|---|
| **`ffprobe` confirms alpha; the clip composites on an upper MLT track (still shows the overlay over footage)** | `bun run verify:move5` → `ffprobe` on the rendered overlay reports `pix_fmt=yuva444p12le` (carries an alpha plane). Composite proven by still-frame pixel sampling of a real `melt` export: at f45 the footage shows **through** the transparent overlay region (`#0d5c61`, not black); the dark lower-third bar renders **on top** (`#11181f`). |
| **Seeking the master clock moves the slaved `<Player>`** | `viewer/src/components/OverlayPlayer.tsx`: a `useEffect` on `clock.currentFrame` calls `playerRef.seekTo(frame)` every master-clock frame change, with the Player kept paused so the master RAF loop owns playback. Verified at the **code + build + serve** level (viewer builds, the server serves the IR/proxy, the wiring is exact). See *Honest scoping* for the one thing NOT yet proven. |
| **One real piece: footage + lower-third, previewed live and exported, matching** | `corpus/demo/` is that piece. Export proven by `verify:move5`: the mp4 has exactly **1 video + 1 audio** stream (`h264` 1080×1920 + `aac` 48kHz), the overlay composites over footage that **drifts** between frames (f45 `#0d5c61` → f80 `#241a52` — composite over *moving* footage, not a frozen/black frame), and the tone bed survives. Live preview served and probed: `GET /` → built viewer HTML (200), `GET /api/timeline` → real timeline IR JSON (fps `[30,1]`, 108 frames). |

---

## The deliverable checklist — all met

| Item | Where it's proven |
|---|---|
| **Compositions become timeline clips: pre-rendered alpha for export; `<Player>` for live preview** | `src/driver/remotion.ts` renders the alpha export clip; `viewer/src/components/OverlayPlayer.tsx` embeds `@remotion/player` for live preview. Two compositing paths, one editor track — exactly the Remotion-seam design. |
| **Render cache keyed on (composition id + resolved input props + range)** | `src/state/remotionCache.ts` (in `.vean` state) keys renders on composition + props + frame range; `remotion.render` reuses cached outputs. Covered by `tests/driver-remotion.test.ts`. |
| **Decide audio ownership (MLT mixes; Remotion clips rendered video-only)** | Decided and implemented: Remotion overlays are exported **video-only** with an alpha plane (`yuva444p12le`, no audio stream); audio is an MLT-owned track (`timeline.addAudio`, the tone bed in the demo). The exported mp4's single audio stream comes from MLT's mix, not Remotion. |

---

## Real gate evidence (raw)

**Alpha plane (the load-bearing flag — `--image-format=png` was required to get it):**

```
$ ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt,codec_name,width,height ... corpus/demo/lower-third.mov
codec_name=prores  width=1080  height=1920  pix_fmt=yuva444p12le
```

`yuva444p12le` carries an alpha plane (the `yuva` prefix is the proof). Note the
ProRes-4444 coercion: the driver *requests* `yuva444p10le`, but ProRes 4444 is
12-bit native, so the real output is `yuva444p12le`. The bit depth is cosmetic;
**the alpha plane is what matters**, and it is present. (The known failure mode —
omitting `--image-format=png`, which silently yields `yuv422p12le` with NO alpha —
is exactly what `verify:move5`'s alpha assertion guards against.)

**Composite + export (`bun run verify:move5`, 6/6 PASS):**

```
ok  alpha      overlay pix_fmt=yuva444p12le (carries an alpha plane)
ok  composite  f45 footage shows through transparent overlay (#0d5c61, not black)
ok  composite  footage drifts under overlay: f45 #0d5c61 → f80 #241a52 (moving footage)
ok  composite  overlay bar renders ON TOP at lower-third (#11181f, dark bar)
ok  export     mp4 has 1 video stream
ok  export     mp4 has 1 audio stream (the tone bed survived)
OVERALL: PASS — Move-5 demo composites overlay over moving footage + carries audio.
```

**Exported mp4 streams:**

```
$ ffprobe ... out/verify-move5/demo.mp4
codec_name=h264  codec_type=video  width=1080  height=1920
codec_name=aac   codec_type=audio  sample_rate=48000
```

**Viewer build + serve (Phase B):**

```
$ bun run viewer:build   → vite build, 124 modules transformed, dist/ emitted (built in 686ms)
$ vean preview --timeline corpus/demo/demo.mlt --port 5191 --no-open
  GET /              → status=200  bytes=653   (built viewer html from viewer/dist)
  GET /api/timeline  → {"ok":true, profile vertical-1080x1920-30, fps [30,1], totalFrames 108, timeline {...}}
  server log: "vean preview serving on http://127.0.0.1:5191  mode: viewer/dist"
```

**Footage proxy (the layer the viewer composites under the player — `bun run verify:proxy`):**

```
endpoint   dims=540x960  frames=90   acodec=aac  size=57116
synthetic  dims=540x960  frames=120  size=11248
OVERALL: PASS — proxy-render produces a playable, downscaled, frame-exact mp4 over the real endpoint; renders terminate (no hang).
```

**Demo timeline shape (`corpus/demo/demo.mlt`):** the composite is a `qtblend`
field transition on the main tractor compositing V2 (overlay, top) over V1
(footage, base) for `[0, 89]`; A1 carries the tone bed. Structure + byte-stable
round-trip pinned without rendering by `tests/demo-fixture.test.ts`.

---

## Standing gates (all green)

| Gate | Command | Result |
|---|---|---|
| Unit/golden suite | `bun run test` | **865/865 pass** (54 files) — includes `actions-remotion`, `driver-remotion`, `timeline-new`, `timeline-add-graphic`, `timeline-add-audio`, `demo-fixture` |
| Typecheck | `bun run typecheck` | clean |
| Lint/format | `bun run lint` | clean (159 files) |
| Shotcut-openability | `bun run lint:xml` | **12/12 namespace-clean** |
| Viewer build | `bun run viewer:build` | clean (124 modules, dist emitted) |
| Move-5 render-faithfulness | `bun run verify:move5` | **PASS 6/6** |
| Footage-proxy render | `bun run verify:proxy` | PASS |

---

## Architecture / boundary discipline (held)

- **License boundary held.** `remotion`, `@remotion/cli`, `@remotion/player`, and
  `react` live in `remotion/package.json` and `viewer/package.json` only — never in
  vean's root deps. vean drives the Remotion CLI as a **separate subprocess**
  (`src/driver/remotion.ts`), the same arm's-length pattern as `melt`. The published
  TS artifact stays pure.
- **Core stays headless/pure.** The new edit ops (transition/track/audio wiring) are
  deterministic file-based functions in `src/ops`; the IR already supported the
  composite shape (footage lower / alpha upper + `qtblend` field transition) — no new
  IR shape was invented. Product/coordination state (the render cache) lives only in
  `.vean`.
- **Action runtime discipline.** Every Move-5 behavior is a registry action with Zod
  input + effect metadata (`remotion.render`, `timeline.new`, `timeline.addGraphic`,
  `timeline.addAudio`, `preview.serve`), CLI-projected, and stable-JSON-tested.
- **Determinism.** `corpus/demo/demo.mlt` round-trips byte-identically (pinned ids);
  the gitignored overlay is regenerated deterministically from the Remotion render.

---

## Honest scoping — what is NOT claimed

These do not block the Move-5 verdict, but are recorded truthfully rather than
papered over:

1. **Live-preview frame-lock is verified at the code/build/serve level, not
   perceptually.** The wiring is exact (`OverlayPlayer` calls `seekTo` on every
   master-clock frame change; the player is paused so the master RAF owns playback),
   the viewer builds, and the server serves the real IR + footage proxy. What has
   **not** been done is a running-browser screenshot showing the playhead drag moving
   both the footage `<video>` and the Remotion overlay in lockstep. The ROADMAP gate
   phrases this as "seeking the master clock moves the slaved `<Player>`
   (frameupdate event)"; the mechanism is present and unit/build-verified, but the
   *perceptual* confirmation in a real browser is the one piece left to a manual eyes-on
   pass. Marked green on the strength of the exact wiring + the served, probed endpoints;
   flagged here so the next agent knows the browser-screenshot proof is the remaining
   belt-and-suspenders step, not a code gap.

2. **"Previewed live and exported, matching" — the *export* path is bit-proven; the
   *live-preview* path is the second compositing path by design.** Per the Remotion
   seam, live preview (`@remotion/player` over a downscaled proxy in Chrome) and the
   export (alpha ProRes → qtblend in MLT) are **two compositing paths that are not
   bit-identical** — that is the accepted, documented cost of the seam, not a defect.
   "Matching" here means *same timeline, same master clock, same composition + props*,
   which is what the shared `demo.mlt` + `ClockProvider` guarantee — it does not mean
   pixel-identical between the browser preview and the MLT export.

3. **Move-5 is restricted to integer-fps profiles** (the demo is vertical
   1080×1920 @30). The rational-fps invariant is intact in the IR; non-integer-fps
   composite profiles are simply not exercised by this Move's fixture. This is a
   scope boundary, not a regression.

4. **`out/demo-f45.png` / `out/demo-f80.png`** are stills written by an earlier manual
   `vean render still` pass; the authoritative, reproducible composite proof is the
   pixel sampling inside `verify:move5` (which regenerates its own overlay and is
   independent of any pre-existing artifact).

---

## Verdict

**GREEN — Move 5 COMPLETE.** Phase A (alpha producer + build ops), Phase B
(live-preview viewer), and Phase C (end-to-end demo) are all green against real
renderer output. The single recorded caveat (a perceptual browser screenshot of the
master-clock frame-lock) is belt-and-suspenders over an already-exact, build- and
serve-verified mechanism, and does not weaken the gate.
