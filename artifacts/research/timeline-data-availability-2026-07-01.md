# Timeline data availability (viewer) — 2026-07-01

What data the vean viewer can reach today, for building a rich timeline (waveforms,
transcripts, linked A/V, new tracks). Probe of `viewer/src` + `src/`. Implementer
reference for the Phase-3 build.

## Timeline shape (viewer side)
- `GET /api/timeline?route=…` → `TimelineResponse` (`viewer/src/types.ts:94-102`):
  `{ ok, resolvedPath, route, profile, fps, totalFrames, timeline }`.
- `Timeline` (`viewer/src/types.ts:86-91`): `{ profile, tracks: { video: Track[];
  audio: Track[] }, transitions, title }`.
- `Track` (`viewer/src/types.ts:70-76`): `{ kind:"video"|"audio"; id; name?; items:
  Item[]; hidden? }`.
- `ClipItem` (`viewer/src/types.ts:29-55`): `{ kind:"clip"; id; resource; service?;
  in; out; length?; gain?; filters?; label?; composition? }`. **No `hasAudio` /
  `audioChannels`/`audioStreams` field.**
- Positions are IMPLICIT — derived by `placeItems(track)` (`viewer/src/types.ts:222-231`),
  which walks items L→R accumulating a frame cursor → `PlacedItem { item, start, length }`.

## Embedded-audio detection — NOT in the viewer
- Audio stream count exists only server-side: `SourceProbe.audioStreams` (`src/driver/
  probe.ts:52-73`), populated by ffprobe, cached in the media catalog (`src/state/
  media.ts`). **Not sent in the timeline JSON.** → 3b must surface it (e.g. add
  `audioStreams`/`hasAudio` to the clip in the `/api/timeline` builder).

## Waveform / peaks — DOES NOT EXIST
- Zero `waveform`/`peaks`/`fft` hits in `viewer/src`. No endpoint.
- Related audio infra: WebAudio scheduler `viewer/src/audio/audioGraph.ts` (schedules
  decoded `AudioBuffer`s, cached by clip `resource`; no peak extraction); mediabunny
  decode worker `viewer/src/decode/decoder.ts` (video frames only); per-source H.264
  proxy `GET /api/source-proxy?path=&route=` (`src/preview/server.ts:612-642`).
- To PRODUCE peaks (3b): ffmpeg `-f f32le` PCM → bin to min/max peaks per pixel-bucket,
  cache under `.vean/`; OR mediabunny audio-sample extraction. Serve via a new
  `GET /api/peaks?path=&route=` returning a downsampled peak array + sampleRate/bins.

## Transcript — server-side only, NO viewer endpoint
- Types: `src/transcript/types.ts:28-75` (segments + words + stable word ids, frame-exact).
- Used by `removeWords` op (`src/ops/removeWords.ts`) and captions action
  (`src/actions/captions.ts`); word→frame map `src/query/transcript-map.ts:47-71`.
- No `/api/transcript`. 3b must add `GET /api/transcript?route=&clipId=` returning the
  `Transcript` (or the words overlapping a clip's source window). Transcript exists ONLY
  where a whisper job has run — absent otherwise (peek must render nothing, never fake).

## IR track/clip model (source of truth)
- Track schema `src/ir/types.ts:248-267`; Clip schema `src/ir/types.ts:165-211`
  (`{ kind:"clip"; id; resource; service?; in; out; length?; gain?; filters; extraProps?;
  label?; composition?; provenance? }`). **No `link`/`group`/stream-selector fields.**
- `addTrack` op EXISTS + is public (`src/ops/track.ts:65-89`): `{ kind; id?; name?;
  position?:"top"|"bottom" }` — video unshift/push, audio push; inverse `removeTrack`.
  → gutter→new-track wires straight to this.
- `removeTrack` `src/ops/track.ts:91-133`. Ops registry `src/ops/index.ts:161-208`,
  public names `:212`.

## Server routes
- Endpoint list `src/preview/server.ts:10-31`. `/api/timeline` builder
  `src/preview/server.ts:368-385`. `/api/media` (footage) `:579-598`.
  New 3b routes register alongside these.

## Buildable-now vs needs-backend
| Feature | Now? |
|---|---|
| Variable-height tracks, richer headers | ✅ viewer-only |
| gutter → new track (`addTrack`) | ✅ viewer-only |
| embedded-audio detection (linked lane) | ❌ expose `audioStreams` in `/api/timeline` |
| waveform lane | ❌ new `/api/peaks` (ffmpeg) |
| transcript peek | ❌ new `/api/transcript` |
| A/V split (detach) | ❌ IR + ops + serialize + diagnostics (see the split appendix in DESIGN-UI.md) |
