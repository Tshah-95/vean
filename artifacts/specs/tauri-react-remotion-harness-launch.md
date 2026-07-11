# Launch companion: Vean harness program

Use with `pm-execution` after roadmap approval. All implementation lanes use
private worktrees and return `ready_to_reconcile`; the PM owns canonical merge,
oracle execution, evidence refresh, and completion status.

## Global worker contract

- Read `AGENTS.md`, the roadmap, unit registry, and truth manifest first.
- Do not mutate developer `.vean` state, user HOME, release secrets, or canonical
  roadmap status.
- Stay within owned surfaces. Report unexpected overlap before editing.
- Run the unit's positive gates and negative controls.
- Negative controls use the structured sensitivity contract: baseline pass,
  setup mutation with changed input hash, oracle failure for the exact reason
  code, cleanup, restored hash, and restored pass.
- Every result binds the source/tree/locks/generated assets/command/fixture/
  scenario and tested binary/app/DMG/update hashes required by the evidence
  envelope.
- Return changed paths, exact commands/results, evidence paths, remaining
  uncertainty, and one of: `ready_to_reconcile`, `equivalent`, `no_delta`, or
  `discarded_with_reason`.
- `ready_to_reconcile` is not completion. PM re-runs proof on canonical `main`.

## H00 — harness oracle

- Dispatch: `pm_owned`
- Worktree: `pm/harness-h00-oracle`
- Starts: immediately after approval
- Owns: command facade, result schema, truth evaluator, contract tests
- Escalate: only if a proposed claim has no observable proof boundary
- Ready when: manifest parses; current evidence cannot be stale/implicit; missing
  commands remain open; stale/missing negative controls fail.
- First canonical post-merge proof: `bun run test
  tests/harness-contract.test.ts`; the developer aggregate remains open until its
  downstream claims actually exist and verify.

## H01 — static workspace gates

- Dispatch: `persistent_thread`
- Worktree: `lane/harness-h01-static`
- Starts: H00 merged
- Owns: viewer/Remotion/Rust static configs and package scripts
- Escalate: generated code needing an intentional exclusion
- Ready when: viewer type/lint/build and Cargo fmt/clippy/test are in
  `verify:fast` on platform-neutral and pinned macOS targets, including
  cfg-specific defect-seeding negative controls.

## H09A — early CI bootstrap

- Dispatch: `pm_owned`
- Worktree: `pm/harness-h09a-ci-bootstrap`
- Starts: H00 merged, before implementation fanout
- Owns: push-main workflow, evaluator meta-test, cleanup/evidence skeleton
- Escalate: runner availability/cost only
- Ready when: current M0 commands run automatically and workflow/evidence hashes
  are part of the envelope; it is extended after every merge batch.

## H02 — hermetic runtime

- Dispatch: `persistent_thread`
- Worktree: `lane/harness-h02-isolation`
- Starts: H00 merged
- Owns: secret-safe fixture descriptor, behavioral state/socket canaries,
  independent watchdog, black-box loopback authority, CSP/navigation policy
- Escalate: transport/security change that affects non-app public surfaces
- Ready when: children behaviorally use separate DB inodes/sockets and leave
  developer-state hashes unchanged; unauthorized route matrix rejects without
  secret leakage; detached child is detected; release policy blocks hostile
  navigation/resource/eval.

## H03K — timeline keyboard/accessibility contract

- Dispatch: `pm_owned`
- Worktree: `pm/harness-h03k-interaction-contract`
- Starts: H00 merged
- Owns: focus, roles/names, selection, keyboard edit/modifier, announcement,
  undo/redo, pointer-parity and focus-restoration contract
- Escalate: Tejas approves the product interaction semantics
- Ready when: approved version/hash is referenced by H03/H06 scenario ledgers.

## H03 — React browser components

- Dispatch: `persistent_thread`
- Worktree: `lane/harness-h03-components`
- Starts: H01 and H02 merged
- Owns: viewer component tests and browser test config
- Escalate: timeline keyboard semantics requiring product judgment
- Ready when: semantic state/keyboard/error/cleanup tests pass in a real browser
  and accessibility negative controls fail as designed.

## H04 — browser editor E2E

- Dispatch: `persistent_thread`
- Worktree: `lane/harness-h04-browser-e2e`
- Starts: H02 and H03 merged
- Owns: browser E2E, live-script migration, drive integration
- Escalate: proposed removal of agent-browser/drive UX
- Ready when: all existing live scenarios map one-to-one into the canonical suite,
  dev and production-dist paths are distinct, every mutation independently
  proves action/touched URI/persisted `.mlt`/parsed IR/diagnostics, and
  evidence/cleanup are structured.

## H05 — Tauri/WKWebView spike and suite

- Dispatch: `persistent_thread`
- Worktree: `lane/harness-h05-tauri-wdio`
- Starts: H02 merged
- Owns: test-only Tauri plugins/config, WDIO suite, release exclusion
- Escalate immediately: if localhost navigation requires production remote Tauri
  authority; dispatch H05F instead of dead-ending
- Ready when: externally identified actual binary/PID/bundle/window/WebKit/final
  URL core flow passes and exact final-lineage inspection rejects all WDIO
  instrumentation.

## H05F — WKWebView black-box fallback

- Dispatch: `persistent_thread`, conditional
- Worktree: `lane/harness-h05f-tauri-blackbox`
- Starts: H05 records safe embedded incompatibility
- Owns: Mac2/LaunchServices user input and nonce/binary-bound self-test telemetry
- Escalate: only if this branch also cannot prove required actual-app outcomes
- Ready when: actual WKWebView lifecycle/media/action/document result is proven
  without remote Tauri authority; detailed DOM claims stay with H03/H04.

## H06 — native macOS smoke

- Dispatch: `persistent_thread`
- Worktree: `lane/harness-h06-macos`
- Starts: H05 or H05F actual-app branch merged
- Owns: Appium Mac2 config, doctor, menu/dialog/window/accessibility scenarios
- Escalate: hosted runner cannot obtain required permissions; propose a prepared
  Mac lane with exact operational cost
- Ready when: thin native suite runs serially and cleans app/dialog state.

## H07 — media and performance

- Dispatch: `persistent_thread`
- Worktree: `lane/harness-h07-media`
- Starts: H04, actual-app branch, and H07B merged
- Owns: Player, render, resilience, codec, and performance oracles
- Escalate: threshold approval after baseline distributions; hardware codec gaps
- Ready when: declared Chrome/WKWebView matrix, render Remotion/MLT,
  live-export semantic parity, handle ledger/stress resilience, and separate
  browser/release performance sections pass against pre-approved policies.

## H07B — media policies and baseline approval

- Dispatch: `pm_owned`
- Worktree: `pm/harness-h07b-media-policy`
- Starts: H04 and actual-app branch merged
- Owns: exact runtime/codec fixture matrix, golden provenance, baseline
  distributions, performance budgets, curated parity frames
- Escalate: Tejas approves thresholds and required unsupported/fallback cells
- Ready when: acceptance policies are versioned/hashed and cannot be regenerated
  by the verify command.

## H08 — package candidate

- Dispatch: `persistent_thread`
- Worktree: `lane/harness-h08-package`
- Starts: H02, actual-app branch, and H07 merged
- Owns: packaged core format, candidate BOM, DMG installation on clean host/VM,
  LaunchServices smoke with checkout unmounted/no Bun/Homebrew
- Escalate: compiled-core format tradeoff
- Ready when: exact candidate hash passes path/network/state/media/render/quit
  and cleanup proof; worker receives no release secrets.

## H08R — canonical release lineage

- Dispatch: `pm_owned`
- Worktree: `pm/harness-h08r-release`
- Starts: H08 candidate merged
- Owns: signing/notary/staple, updater E2E, final post-sign package/Mac2 smoke,
  manual keyboard/VoiceOver assessment, immutable lineage
- Escalate: Apple/updater key custody, release authority, assessor availability
- Ready when: all results reference one source-to-final lineage; vN to vN+1 and
  tamper/interruption/replay/downgrade cases pass; manual evidence binds exact
  package/OS/VoiceOver version.

## H09 — CI and evidence

- Dispatch: `pm_owned`
- Worktree: `pm/harness-h09-ci`
- Starts: H09A plus all required canonical commands and H08R merged
- Owns: workflows, tier assignment, artifact upload, secrets isolation
- Escalate: runner availability/cost or secret exposure
- Ready when: mapping and actual current-SHA/release-lineage runs verify;
  controlled failures in every integration job are independently retrieved and
  validate complete tier-specific evidence; workflows call only canonical
  `verify:*` commands.

## H10 — guidance convergence

- Dispatch: `pm_owned`
- Worktree: `pm/harness-h10-guidance`
- Starts: H09 merged
- Owns: AGENTS, ROADMAP, README, drive/view skills, contributor docs, drift tests
- Escalate: none for ordinary stale guidance
- Ready when: one command/tier vocabulary remains and drift tests reject stale or
  overbroad proof claims.

## Execution verifiers

After each merge batch, launch three read-only verifier lenses against canonical
state:

1. `check-contract`: attempt to make each new oracle pass while its claim is
   false; inspect negative controls and evidence freshness.
2. `topology-security`: inspect worktrees, state/port/process isolation, test-only
   authority, CI permissions, and secrets.
3. `domain-source-truth`: inspect whether mocks/screenshots/browser engines
   overclaim document, media, package, or release correctness.

Final verifier prompt:

> Disprove completion of the Vean harness program from current canonical files,
> commands, running processes, packaged artifacts, and evidence. Do not use PM
> prose or roadmap status as evidence. For every truth-manifest claim, run or
> inspect its oracle and negative control, then report false positives, stale
> evidence, unsupported platform substitutions, or missing canonical artifacts.
