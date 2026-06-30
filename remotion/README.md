# vean-remotion — the Remotion producer (peer workspace)

This directory is a **peer workspace**, not part of vean's TypeScript build. It
has its own `package.json`; **none** of its dependencies (`remotion`,
`@remotion/*`, `react`, `react-dom`) ever enter vean's root `package.json`. vean
drives the Remotion CLI as an **arm's-length subprocess** — exactly the way it
drives `melt` — so the published vean artifact stays pure TypeScript and the
license boundary holds.

## Install

```sh
cd remotion
bun install
```

This pulls Chrome's headless shell on first render (cached afterwards).

## What it produces

`remotion render` produces an **alpha ProRes 4444 clip** that vean drops onto an
upper MLT video track and composites over footage with a `qtblend` field
transition. The alpha plane is load-bearing:

- `--image-format=png` is REQUIRED. Without it Remotion uses jpeg intermediate
  frames, which cannot carry alpha, and you silently get a no-alpha ProRes file.
- The produced pixel format is `yuva444p12le` (ProRes 4444 is 12-bit native; the
  `yuva444p10le` request coerces to 12le). It HAS an alpha plane — verify with:

  ```sh
  ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt \
    -of default=nw=1 OUT.mov
  ```

  The `pix_fmt` must contain `yuva`. `yuv422p12le` means alpha was lost.

## Driven by vean

You normally never run `remotion render` by hand — `vean remotion render
<composition>` (the `remotion.render` action) computes the cache key, runs the
exact command with all the alpha flags, ffprobes the result, and returns the
clip path. The defaults in `remotion.config.ts` keep a hand-run render
alpha-correct too.

## Compositions

- `LowerThird` — a dark bar lower-third (accent border, title/subtitle, spring
  slide-in, text fade). Registered at the demo profile resolution (1080×1920@30).
  Its root has a transparent background so alpha survives.
