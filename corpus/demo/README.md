# `corpus/demo` — the Move-5 end-to-end fixture

The seed of vean's product demo and the live target for the viewer: a footage base
with the **vean lower-third** composited on an upper track (qtblend) plus an audio
bed, proven end-to-end through the real renderer.

```
demo.mlt          committed   the timeline: base + qtblend overlay + audio bed
build-demo.ts     committed   authors demo.mlt + (re)renders the overlay
lower-third.mov   gitignored  the Remotion alpha overlay (regenerated on demand)
```

## What's in the timeline

| Track | Content |
|---|---|
| **V1** (base) | a teal→indigo solid-colour **cross-fade** (a synthesized "footage" stand-in — no external asset; the dissolve gives visible motion *under* the overlay) |
| **V2** (gfx) | the **`LowerThird`** Remotion composition exported to an alpha ProRes 4444 clip (`lower-third.mov`) |
| **A1** (audio) | the repo `tone.wav` bed at −6 dB with 6-frame fades |
| field transition | a **`qtblend`** compositing V2 (overlay, top) over V1 (footage, base) for `[0, 89]` |

All integer frames @ **VERTICAL 1080×1920 @30** (Move-5 is restricted to integer-fps
profiles — see `ROADMAP.md`).

## Regenerate the overlay (run once after a fresh clone)

`lower-third.mov` is a gitignored binary that `build-demo.ts` reproduces from the
deterministic Remotion render. The committed `demo.mlt` references it by the
repo-relative path `corpus/demo/lower-third.mov`, so run the build from the repo
root before previewing or exporting:

```sh
bun run demo:build          # render the overlay + (re)write demo.mlt
# or with evidence:
bun corpus/demo/build-demo.ts --check
```

> Needs a `bun install`'d `remotion/` workspace (`bun run remotion:install`) plus
> `melt` + `ffmpeg` on PATH.

## Preview it live (the viewer)

```sh
vean preview --timeline corpus/demo/demo.mlt
```

Opens the local 127.0.0.1 viewer: a frame-accurate timeline strip and the
composited preview (footage proxy `<video>` under the `@remotion/player` overlay)
on one master clock — seeking the playhead moves both layers together.

## Export it (the end-to-end proof)

```sh
vean render video corpus/demo/demo.mlt --out out/demo.mp4
```

The mp4 carries the overlay composited over the footage **and** an audio stream.
The full gate automates the proof (alpha + composite-over-moving-footage + a
two-stream export):

```sh
bun run verify:move5
```

`verify:move5` regenerates the overlay itself, so it is independent of whether
`lower-third.mov` is present. It is intentionally **not** part of `verify:corpus`
(which globs top-level `corpus/*.mlt` only and must stay green on a fresh clone,
where the gitignored overlay does not yet exist).
