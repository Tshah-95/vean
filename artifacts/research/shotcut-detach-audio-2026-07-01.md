# Shotcut "Detach Audio" + MLT stream model — 2026-07-01

Mined from Shotcut + MLT source (the spec vean lifts). Implementer reference for the
A/V-split build. The synthesis (what vean's IR/ops/diagnostics need) is in DESIGN-UI.md
§"Appendix: modeling linked A/V".

## Shotcut mechanics (the answer key)
`DetachAudioCommand::redo()` (`src/commands/timelinecommands.cpp`) is a **one-way split**,
not a link:
1. Build TWO `Mlt::Producer` from the same clip XML → `audioClip`, `videoClip`.
2. Save the clip's `shotcut:group` int if present (does NOT create one).
3. **video-only:** `videoClip.set("astream",-1); videoClip.set("audio_index",-1);` +
   detach audio filters. Stays on the original track.
4. **audio-only:** `audioClip.set("vstream",-1); audioClip.set("video_index",-1);` +
   detach video filters.
5. Find an audio track blank across the span; else `model->addAudioTrack()`.
6. `overwrite(targetTrack, audioClip, pos)` + `overwrite(originalTrack, videoClip, pos)`
   (replaces the original combined clip).
7. Restore the saved group number onto the new video clip if any.
Undo: re-`overwrite` the original combined clip; remove the track if it created one.
Wiring: `TimelineDock::detachAudio` (`src/docks/timelinedock.cpp`); enabled iff one clip
selected and `audio_index >= 0`; saves `shotcut:defaultAudioIndex` for reattach.

## MLT stream selectors (`src/modules/avformat/producer_avformat.yml`)
| prop | meaning | detach |
|---|---|---|
| `audio_index` | ABSOLUTE audio stream; `-1`=off (default 0) | `-1` on video-only |
| `video_index` | ABSOLUTE video stream; `-1`=off | `-1` on audio-only |
| `astream` | RELATIVE audio stream; `-1`=off; **overrides `audio_index`** | `-1` on video-only |
| `vstream` | RELATIVE video stream; `-1`=off; **overrides `video_index`** | `-1` on audio-only |
Shotcut sets BOTH absolute + relative (belt-and-suspenders, since relative overrides).
In `.mlt`: two `<producer>` on the same `resource`, one with `audio_index/astream=-1`,
one with `video_index/vstream=-1`; the original single producer is gone.
Audio track marked `<property name="shotcut:audio">1</property>` (`kAudioTrackProperty`).
`shotcut:defaultAudioIndex` stored for reattach. (`test_audio`/`test_image` are NOT used
by detach — those are color/blank capability flags.)

## Linkage — there is NO real A/V link
Only association = generic `shotcut:group` INT on a clip's cut (Group/Ungroup feature).
`getGroupForClip` reconstructs a group by scanning all tracks for clips with the same int.
Detach does NOT create a group. "Move together" = selection expansion (grab one → select
all group members → one shared delta in `MoveClipCommand`). **Trim / split / ripple-delete
are NOT group-aware** → a detached pair silently DESYNCS on trim/ripple (the footgun).

## vean synthesis (typed IR — be BETTER than the spec)
1. Per-producer stream selectors on the clip source: `audioIndex`/`videoIndex` (abs,
   -1=off) + `astream`/`vstream` (rel, -1=off, override abs), + optional
   `defaultAudioIndex`, + derived `hasAudio`. Serialize/parse + golden round-trip for
   audio-only/video-only producers.
2. A TYPED link on the clip (better than a loose int): `link: { id; role:"video"|"audio";
   partnerIds }` — so the IR distinguishes an A/V pair from an arbitrary group and can
   diagnose desync.
3. `detachAudio` op: guard `hasAudio`; clone → set audio/video selectors; find-or-create
   audio track (report in consequences); preserve `defaultAudioIndex`; auto-create the
   link group (prevent the silent desync Shotcut allows); inverse = re-merge + remove any
   created track. Companions: `reattachAudio`, `linkClips`, `unlinkClips`.
4. Diagnostics unlocked: dangling link; A/V desync (in/out or pos drift after trim/split);
   redundant selector (`audioIndex=-1` on a file with no audio); ripple hazard (per-track
   ripple that desyncs a partner); invalid selector (index beyond stream count — needs probe).
5. Link-aware ops: move (shift both), trim (diagnose desync, ideally "trim both" action),
   split (split both halves), ripple/lift (ripple both or flag). Link-awareness lives in
   the op + diagnostics layer ONCE.

## Sources
- Shotcut `DetachAudioCommand` — github.com/mltframework/shotcut/blob/master/src/commands/timelinecommands.cpp
- `detachAudio`/grouping/`getGroupForClip` — .../src/docks/timelinedock.cpp
- MLT avformat props — github.com/mltframework/mlt/blob/master/src/modules/avformat/producer_avformat.yml ; mltframework.org/plugins/ProducerAvformat/
- Shotcut property keys (`shotcut:audio`/`shotcut:group`/`shotcut:defaultAudioIndex`) — .../src/shotcut_mlt_properties.h
