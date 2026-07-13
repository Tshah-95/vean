# Coverage ledger

| Area | Status | Evidence |
|---|---|---|
| Active timeline contains audible media | covered | The running native dev sidecar is rooted at `projects/carlo-demo`; `timeline.mlt` contains full-span detached A1 clip `mock-audio`, while `mock-picture` explicitly disables embedded audio. |
| Media files contain decodable audio streams | covered | `ffprobe` finds 48 kHz mono AAC; `ffmpeg` measures nonzero signal, but only −37.14 LUFS integrated / −16.11 dBTP. |
| Preview server serves audio-capable bytes/ranges | covered | Exact source request returned HTTP 200; a fresh product page decoded and buffered it. |
| Viewer creates and starts an audio path | covered | Exact Carlo route reached `contextState=running`, `bufferedResources=1`, `scheduledClips=1`; injected post-master analyser measured nonzero PCM. |
| Mute, volume, sink, autoplay, and AudioContext state | partially covered | Product master gain was 1, context resumed, macOS output was 61/unmuted/default Razer Nommo. Actual WKWebView applied sink/destination signal is not exposed. |
| Timeline clock and audio element synchronization | covered with defect | Clock advances from the AudioContext; late decode uses a stale captured playhead offset and can start late/out of sync. |
| Existing automated coverage | covered | Browser and native gates prove decode or clock state, not product post-master signal; Playwright headless runs are explicitly `--mute-audio`. |
| Recent regression attribution | covered | Resolver omissions and StrictMode scheduling were previously fixed. Recent subject-compositor commits do not touch the mixer; the current resolver selects the correct audio half. |

## Known blind spots

- The already-running native app is not an instrumented WebDriver build. Its actual WKWebView `AudioContext`, applied sink, post-master signal, and physical USB-speaker output cannot be observed safely from this session.
- Current `window.__veanAudio` state omits decode errors, effective volume/mute, requested-versus-applied sink, and PCM level, so the native app cannot explain its own silence.
- Physical output is intentionally not used as an automated oracle. Headless Chromium launches with `--mute-audio`; deterministic tests should measure the product signal before the device.
