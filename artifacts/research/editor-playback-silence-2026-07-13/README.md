# Editor playback silence deep dive

Status: complete. The decision brief is [`../editor-playback-silence-2026-07-13.md`](../editor-playback-silence-2026-07-13.md).

## Mission

Determine why audible timeline media is not heard during editor playback, distinguish document/media/routing/decode/clock/audio-graph failures, and produce a verified root-cause brief with the smallest correct next action.

## Timebox and checkpoints

- Run to causal confidence in this investigation turn; do not stop at the first plausible explanation.
- Checkpoint after independent code-path, harness-coverage, and regression-history shards.
- Finalize only after reproducing the symptom or explicitly documenting why the active project cannot reproduce it.

## Scope

- Included: current `main`, active project/timeline state, timeline A/V metadata, viewer playback and routing code, preview server media endpoints, Chromium loopback behavior, WKWebView-relevant assumptions, recent audio-related history, and existing tests.
- Excluded: changing product code, opening visible/native windows, system-wide audio-device mutations, and unrelated renderer/export audio behavior unless it explains preview playback.

## Guardrails

- Read-only diagnosis unless Tejas separately asks for a fix.
- Headless browser only; do not take over the desktop.
- No private/authenticated web sources are needed; prefer repository and runtime evidence.
- Do not persist timeline edits or alter system audio routing.

## Evidence schema

Shard findings use JSONL records with: `id`, `collected_at`, `source_timestamp`, `source_timestamp_basis`, `source_type`, `source_url`, `source_title`, `subject`, `area`, `claim`, `evidence_quote`, `impact`, `implication`, `confidence`, and optional `notes`.

## Shards

- `shards/audio-runtime.jsonl`: playback/decode/audio-graph code path and runtime hypotheses.
- `shards/audio-harness.jsonl`: what existing tests prove and what they miss.
- `shards/audio-history.jsonl`: regression history and change attribution.

## Quality bar and stop conditions

- Trace source media → timeline IR → visible clip resolution → media element/audio graph → output device.
- Inspect at least one audio-bearing fixture and the currently active timeline.
- Verify mute/volume/sink state and browser autoplay/audio-context state in the running loopback editor.
- Finalize when one causal explanation accounts for the observed symptom and alternatives are evidence-rulled-out; otherwise present bounded competing causes and the missing evidence needed.
