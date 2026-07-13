# Editor playback silence — decision brief

## Bottom line

The Carlo editor is **not digitally silent before the output device**. On the exact project open in the desktop app, vean resolves the correct detached A1 clip, fetches and decodes it, resumes a 48 kHz `AudioContext`, schedules one source at unity master gain, and produces nonzero PCM after the real master bus.

The immediate, evidence-backed explanation for “I hear nothing” is that the source recording is extraordinarily quiet: **−37.14 LUFS integrated**, with the opening around **−45.3 dBFS RMS** at the product master. That is about 21 dB below a conventional −16 LUFS spoken-word target and about 15 dB quieter than vean’s committed demo-tone control. macOS itself reports 61% output, unmuted, to the default Razer Nommo Chroma device.

There is still one bounded uncertainty: the already-running native app does not expose its actual WKWebView destination signal or applied device route. A second WKWebView/CoreAudio/hardware-output failure cannot be disproved from the current app. The larger product defect is that vean currently gives neither the user nor its tests enough telemetry to distinguish these cases.

## What was proved

| Layer | Result | Evidence |
|---|---|---|
| Document | healthy | Carlo `timeline.mlt` has full-span `mock-audio` on A1; the paired video half explicitly disables audio. |
| Source media | valid but severely quiet | 48 kHz mono AAC; −37.14 LUFS integrated, −16.11 dBTP; first five seconds about −40.99 dBFS RMS. |
| Preview HTTP | healthy | Exact source request returns 200 and the product graph buffers it. |
| Resolver | healthy for this timeline | Exactly the audio-only half is eligible; the picture half is skipped. |
| Web Audio graph | healthy in exact loopback product path | `running`, one buffered resource, one scheduled clip, master gain 1. |
| Product PCM | nonzero but very low | Post-master RMS 0.005435 (about −45.3 dBFS) and peak 0.059689 in the opening sample. |
| macOS default state | apparently healthy | Output 61%, not muted, Razer Nommo Chroma default at 48 kHz. |
| Native destination / physical speakers | unproven | Current non-instrumented WKWebView exposes no applied sink or post-destination signal. |

## Causal diagnosis

### 1. Immediate incident: under-level source

This is the strongest demonstrated cause. The source has real speech, but the product output is so low that it can sound absent at ordinary speaker settings. The normalized timeline waveform is not counter-evidence: its normalization is display-only and intentionally does not change playback gain.

For Carlo specifically, a static gain increase of roughly **+12 to +14 dB** would make the recording materially audible while preserving about 2–4 dB of peak headroom. Reaching a full −16 LUFS spoken-word target requires loudness normalization/dynamics rather than blindly adding +21 dB, because the existing −16.11 dBTP peaks would clip.

### 2. Systemic diagnostic failure: the editor cannot explain silence

`AudioGraph` erases fetch/decode/resume/sink failures, records a requested sink even when applying it fails, and exposes no effective mute/volume, applied device, error, or signal level. The output menu tests `HTMLMediaElement.setSinkId`, while actual playback uses `AudioContext.setSinkId`; those capabilities need not match.

As a result, these materially different states look identical to the user:

- source is quiet;
- source fetch/decode failed;
- context never resumed;
- mixer is muted or at zero gain;
- requested output was not applied;
- signal reaches the master but not WKWebView/CoreAudio/device;
- physical USB speakers are off or locally muted.

### 3. Systemic loading/synchronization defects amplify the symptom

The mixer downloads and decodes the entire **188 MB** H.264/AAC camera `.mov` before it can schedule audio. In development StrictMode, graph teardown does not abort the first fetch, so this work can happen twice. If Play is pressed before decode completes, scheduling retains the old playhead offset and starts late/out of sync after the await. Any decode failure is silently treated as “no clip.”

These are not needed to explain the measured low level, but they are concrete defects on the same symptom path and should be fixed with the observability work.

## Why the green harness missed it

- The full browser editor oracle has no audio-playback scenario.
- Product media coverage waits for `audio.playing === true`, a flag set before resume/decode/scheduling succeeds.
- Performance coverage proves a running context and A/V clock relationship, not a scheduled source or nonzero signal.
- Native WKWebView coverage decodes standalone WAV/M4A/MP3 fixtures and measures their buffers; it does not drive the product mixer, decode AAC from a camera `.mov`, resume, schedule, route, or measure output.
- Headless Playwright adds `--mute-audio`, so physical emission is intentionally unavailable as an oracle.

## Recommended fix sequence

1. **Fix the Carlo content level.** Apply a safe +12 to +14 dB clip gain for the current edit, or create a loudness-normalized audio derivative with a true-peak ceiling. Verify with a post-master meter, not waveform height.
2. **Make audio health first-class.** Track per-resource `loading/ready/error`, context transitions, effective master gain/mute, requested and applied sink, and a post-master RMS/peak meter. Surface a compact monitor meter plus an actionable error state.
3. **Fix routing truth.** Feature-test and enumerate the API the graph actually uses; never present a sink as applied when `AudioContext.setSinkId` is absent or rejects. Show “System default — Razer Nommo Chroma” when that is the only honest route.
4. **Remove whole-container decode as the steady-state path.** Use an audio-only proxy or streaming decoder. At minimum abort in-flight loads on graph disposal, expose load latency/error, and recompute the current playhead after async decode before scheduling.
5. **Add product-signal gates.** In Chromium and the embedded WKWebView provider, load an explicit audio-track timeline, perform a real Play gesture, require `running + buffered + scheduled`, and measure nonzero PCM after the product master. Negative controls must mute/disconnect the real graph and make the assertion fail.

## Decision

Treat the current report as **under-level source plus missing audio observability**, not as a proven universal mixer failure. Fixing only the Carlo gain will restore this edit but preserve an opaque failure class; fixing only routing without leveling the source may still sound silent. The correct implementation unit should do the content-level repair and the systemic health/test work together, while keeping physical speaker emission outside automated gates.

## Evidence inventory

- Charter, coverage, and run log: [`artifacts/research/editor-playback-silence-2026-07-13/`](editor-playback-silence-2026-07-13/)
- Consolidated findings: [`sources.jsonl`](editor-playback-silence-2026-07-13/sources.jsonl)
- Independent shards: [`audio-runtime.jsonl`](editor-playback-silence-2026-07-13/shards/audio-runtime.jsonl), [`audio-harness.jsonl`](editor-playback-silence-2026-07-13/shards/audio-harness.jsonl), [`audio-history.jsonl`](editor-playback-silence-2026-07-13/shards/audio-history.jsonl)
