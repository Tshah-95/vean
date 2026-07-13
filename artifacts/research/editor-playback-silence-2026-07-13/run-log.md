# Run log

- 2026-07-13: Started orchestrator investigation on `main`; active timeline resolved to `corpus/demo/demo.mlt`.
- 2026-07-13: Planned independent shards for runtime code, harness coverage, and recent history; orchestrator owns reproduction and synthesis.
- 2026-07-13: Found the running native dev app's sidecar at port 52421 rooted at `projects/carlo-demo`; corrected the incident target from the repository's CLI-active demo fixture to the timeline actually open in the desktop app.
- 2026-07-13: Confirmed Carlo A1 is a detached full-length audio clip over `20260713_040019_product-launch-mock.mov`; its picture half disables audio, so no duplicate source is expected.
- 2026-07-13: Probed the source: 48 kHz mono AAC, −37.14 LUFS integrated, −16.11 dBTP; first five seconds are about −40.99 dBFS RMS. The media is non-silent but severely under-level.
- 2026-07-13: Drove the exact Carlo loopback route headlessly. The product graph resumed, buffered one resource, scheduled one source, and advanced the playhead.
- 2026-07-13: Injected a diagnostic analyser after the real product master gain without changing source or timeline. It measured RMS 0.00544 (about −45.3 dBFS) and peak 0.0597 in the opening sample window with master gain 1. The same method measured the committed demo tone at about −30.4 dBFS RMS, roughly 15 dB louder.
- 2026-07-13: Read macOS output state without mutation: Razer Nommo Chroma is default, system output volume is 61, and output mute is false.
- 2026-07-13: Audited code/history/tests. Found erased fetch/decode/sink errors, a whole-188 MB decode path, late-decode stale-offset scheduling, duplicate development fetches under StrictMode, and no browser/native product-signal oracle.
- 2026-07-13: Stopped the dedicated drive session and retained only research artifacts; no timeline, app, or system audio state was changed.
