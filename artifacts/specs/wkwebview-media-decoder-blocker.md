# WKWebView media decoder blocker and bounded implementation contract

Status: implementation blocked by a measured product-decoder incompatibility  
Evidence subject: `c34c776dce2a029de73b3b9b77534fe2511a36d8`  
Fixture manifest: `7e8a9684ccd86de9af5564636401f424e5c3709be4eca9ad305e57987aa81cd5`

## Measured result

The hidden Tart guest ran macOS build `25E246` and the actual instrumented Tauri
WKWebView. Two distinct paths were measured:

1. WKWebView `<video>` decoded the exact H.264 and VP9 fixtures. H.264 was
   nonblank and seekable. VP9 was nonblank and seekable but canvas readback was
   fully opaque (`alpha_ratio = 0`).
2. Vean's real product path fetched the same exact committed proxy and sent it
   through the bundled decode worker, Mediabunny, and
   `CanvasSink({ alpha: true })`. The first H.264 cell failed at
   `CanvasSink.getCanvas()` with Mediabunny's `Decoder failure`; no ImageBitmap
   was produced. This happened before the VP9-alpha cell could execute.

The second result rules out implementing dual H.264 color/matte proxies on top
of the current worker as a bounded fix: that design would require two instances
of the decoder that already fails its simplest H.264 input in WKWebView. It also
means the earlier HTML-video result cannot be substituted for product evidence.

Raw product-path evidence is retained outside Git at
`.vean/vm-harness/evidence/h07-wk-product-c34c776/current/`. Its
`native-session.json` SHA-256 is
`f417478add7ae99b49a48ba5dae860dc047207dd6e31c57a1a27a67109caf7dc`.
No verified evidence envelope was emitted.

## Required architecture if WKWebView remains supported

Implement a decoder backend boundary rather than a codec-only patch:

```text
FrameProvider
├── MediabunnyFrameProvider        Chrome and runtimes where the worker proves support
└── WkVideoMatteFrameProvider      actual WKWebView
    ├── color: short-GOP H.264/yuv420p MP4
    ├── matte: short-GOP H.264/yuv420p MP4, luma = source alpha
    └── combine: one compositor operation, RGB from color and A from matte luma
```

The WK provider must use two pooled, muted, `playsInline` HTMLVideoElements,
wait for both exact seeks, draw both into owned canvases, and create one RGBA
ImageBitmap. It must never display the color stream while the matte is missing,
late, stale, or undecodable. HEVC-with-alpha is not the fallback: it does not
solve the measured Mediabunny failure and adds an unproven WK/WebCodecs,
encoder, and distribution surface.

The source-proxy layer must generate the pair atomically from one source probe:

- one content address binds source identity, color hash, matte hash, dimensions,
  fps, frame count, timestamps, encoder argv, and alpha-probe result;
- color and matte have identical CFR timestamps, dimensions, GOP boundaries,
  and frame counts;
- alpha-probe unknown, missing matte, lineage mismatch, or pair drift fails
  closed; there is no opaque fallback;
- opaque sources continue to use one H.264 stream and an implicit all-255 alpha.

The compositor consumes a single synchronized frame object. Backend selection is
based on a startup capability proof, not user-agent sniffing, and is recorded in
evidence. Both providers share cache limits, generation cancellation, owned
bitmap close rules, and resource-ledger accounting.

## Check contract

Implementation is not complete until all of these pass:

- Chrome and actual hidden-guest WKWebView decode the exact fixture manifest.
- Both alpha cells report `alpha_ratio >= 0.2`, nonblack content, and seek error
  `<= 0.12s` through the selected product provider.
- H.264 opaque, all three audio formats, attributed failures, explicit fallback,
  and alpha-probe fail-closed cells still pass; all 13 remain in the denominator.
- A one-frame color/matte timestamp mutation fails with a synchronization code.
- Replacing the matte with an opaque stream fails the alpha oracle.
- Missing/corrupt/swapped matte, wrong pair manifest, and unknown alpha probe all
  fail before presentation; none silently show color-only output.
- Repeated seek/context-loss/dispose balances every video, canvas, bitmap,
  worker, and listener handle, and leaves no app, sidecar, port, or dialog.
- Evidence records backend, both artifact hashes, pair-manifest hash, app and
  WK identity, raw per-cell observations, and the negative-control result.

Until that contract is implemented and proven on both runtimes, H07 remains
open and H08 must not treat WKWebView alpha media as release-ready.
