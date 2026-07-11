# Vean Tauri harness deep dive

## Mission

Determine whether Vean should remain on Tauri + React + Remotion and, if so,
define the development, test, CI, packaging, and evidence harness required to
make that choice effective rather than merely conservative.

## Timebox

One focused research and PM-planning pass on 2026-07-11. Synthesis begins after
the three initial evidence shards land; gap-directed verification follows before
the roadmap is considered ready.

## Scope

Included:

- current Vean app/viewer/test/build/release harness;
- Tauri 2 desktop testing on macOS, especially embedded WebdriverIO;
- React/Vite/Vitest/Testing Library boundaries;
- Remotion Player and browser media verification;
- packaged-app, native-shell, accessibility, security, process lifecycle, and CI;
- migration from the current harness to a layered assurance model.

Excluded:

- replacing Tauri, React, Remotion, MLT, or FFmpeg;
- implementing harness changes in this planning pass;
- product feature work unrelated to harness quality;
- private or authenticated sources.

## Guardrails

- Public primary sources first; secondary sources only for a clearly labeled gap.
- Read-only research agents; no source, dependency, configuration, or database
  mutations.
- Treat mutable web documentation as retrieved on 2026-07-11.
- Existing product invariants in `AGENTS.md` remain binding.
- No roadmap unit is complete without a post-integration proof command and a
  negative control that would fail if the old gap returned.

## Quality bar

- Complete codebase inventory with file/line evidence.
- Official documentation for each recommended Tauri/React/Remotion tool.
- Explicit separation of unit, browser, native-shell, packaged-app, media,
  accessibility, performance, and release proof.
- Dependency graph, collision-safe implementation lanes, completion oracle, and
  independent verifier amendments.
- Clear answer to: why staying on Tauri is correct, what it does not solve, and
  what must change next.

## Stop conditions

Finalize when all initial shards are present, evidence JSONL parses, material
claims have sources, the PM roadmap and truth manifest parse, and three verifier
lenses leave no unabsorbed high-confidence findings. Escalate only if evidence
shows the Tauri choice itself is invalid or a recommendation requires a product
decision outside the stated scope.

## Finding schema

Each line under `shards/*.jsonl` is one object:

```json
{
  "id": "short-stable-id",
  "collected_at": "ISO-8601",
  "source_timestamp": "YYYY-MM-DD or unknown",
  "source_timestamp_basis": "published_at|updated_at|commit_date|retrieved_at|unknown",
  "source_type": "official_docs|github_code|repo_file|github_issue|other",
  "source_url": "URL or absolute file path",
  "source_title": "title or path",
  "subject": "normalized subject",
  "area": "normalized area",
  "claim": "one-sentence finding",
  "evidence_quote": "compact supporting excerpt or exact code behavior",
  "impact": "why this matters",
  "implication": "specific implication for the roadmap",
  "confidence": "high|medium|low",
  "notes": "optional"
}
```

## Shards

1. `shards/vean-current.jsonl` — current harness, gaps, reusable assets, and
   product invariants.
2. `shards/tauri-wdio.jsonl` — Tauri 2, embedded WebdriverIO, macOS native-shell
   testing, CI, security, and packaging.
3. `shards/react-remotion.jsonl` — React/Vite/Vitest, browser E2E, Remotion,
   media correctness, accessibility, and visual/performance testing.

