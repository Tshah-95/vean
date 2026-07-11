# Run log

- 2026-07-11T23:03:59Z — Started on `main` at
  `d71e9f4555e77734bb3b9e08b4706a472af5ae85`; canonical worktree clean.
- 2026-07-11T23:03:59Z — Existing detached worktrees observed:
  `jolly-gagarin-91ea0f` and `stoic-haibt-ce5d05`. Research agents are read-only
  outside their assigned shard artifacts.

## Agents

- `/root/vean_harness_inventory` — current Vean harness/codebase evidence;
  assigned `shards/vean-current.jsonl`.
- `/root/tauri_wdio_research` — official Tauri/WebdriverIO evidence; assigned
  `shards/tauri-wdio.jsonl`.
- `/root/sdk_research` (reused completed research thread) — official
  React/Vite/Vitest/Remotion/browser evidence; assigned
  `shards/react-remotion.jsonl`.

## Validation

- 2026-07-11 — Initial shards landed: 31 Vean findings, 28 Tauri/WDIO
  findings, and 26 React/Remotion/browser findings.
- 2026-07-11 — All 85 finding lines parsed as JSON and satisfied the required
  schema.
- 2026-07-11 — Normalized 62 unique source records into `sources.jsonl`;
  line-specific local references remain in the finding shards.
- 2026-07-11 — Check-contract verifier reported 16 high and 6 medium findings;
  all high-confidence amendments were absorbed: independent evaluator meta-test,
  structured pass-fail-pass controls, immutable evidence binding, scenario
  ledgers, explicit profiles, behavioral isolation, artifact lineage, clean-host
  package proof, current CI runs, and per-tier evidence retrieval.
- 2026-07-11 — Topology/security verifier reported 4 critical, 7 high, and 4
  medium findings; absorbed executable H05F fallback, early H09A CI, secret-free
  H08 vs PM-owned H08R split, collision ledger, safe authority transport,
  identity-safe cleanup, runner concurrency, and claim/status ownership.
- 2026-07-11 — Domain/source-of-truth verifier reported 9 high and 6 medium
  findings; absorbed independent `.mlt`/IR browser oracles, approved keyboard
  contract, exact media matrix, live/export semantic parity, golden provenance,
  clean DMG installation, production CSP/navigation claim, package-bound manual
  accessibility, release performance, and packaged Mac2 proof.
- 2026-07-11 — Amended unit registry parses with 16 units; truth manifest parses
  with 26 downstream claims, one independent meta-contract, four profiles, and
  structured sensitivity controls for every claim. Dependency, owner, profile
  coverage, and diff-whitespace validation pass.
