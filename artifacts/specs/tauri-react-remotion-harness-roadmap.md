# Vean Tauri/React/Remotion harness roadmap

Status: proposed for execution  
Research basis: `artifacts/research/tauri-harness-deep-dive-2026-07-11.md`  
Unit registry: `artifacts/specs/tauri-react-remotion-harness-units.jsonl`  
Completion oracle: `artifacts/specs/tauri-react-remotion-harness-truth-manifest.json`

## Outcome

Keep Tauri, React, and Remotion, and replace the current collection of useful but
disconnected checks with a layered, hermetic assurance harness.

This roadmap is complete when agents and CI can answer all of these separately:

1. Does every owned file compile and lint?
2. Are the typed document/edit/action invariants correct?
3. Do React components expose correct state, semantics, and keyboard behavior?
4. Does the real browser editor work with its actual server and media APIs?
5. Does the actual Tauri/WKWebView application launch, navigate, and shut down?
6. Do native macOS menus, dialogs, windows, and accessibility work?
7. Are live Player behavior, exported pixels, media recovery, and performance all
   independently correct?
8. Does the downloaded, signed app work without Bun, source, Homebrew, or existing
   user state?

No green result may be promoted to a broader claim than the tier it exercised.

## Why this architecture is correct

- Vean's live preview is natively a browser-media application. WebCodecs,
  workers, WebGL2, Web Audio, and Remotion Player are capabilities, not accidental
  baggage.
- Tauri preserves those capabilities while providing a native window, menu,
  dialog, packaging, and process boundary.
- The headless TypeScript core is already well tested and shared by CLI/LSP/MCP;
  a native rewrite would add risk without improving that source of truth.
- The missing piece is evidence across boundaries. Tauri now has a plausible
  official macOS WebDriver path, and Appium Mac2 supplies the small native tier it
  cannot cover.
- Staying does not mean preserving the current harness unchanged. Viewer static
  gates, actual WKWebView tests, hermetic state, process cleanup, security,
  package proof, and CI are mandatory parts of the decision.

## Target invariants

### Evidence invariants

- Every claim is declared in the truth manifest.
- Every claim names a current oracle command and a negative control.
- Evidence is associated with a run ID, source SHA, platform/runtime versions,
  fixture ID, and artifact directory.
- A missing, skipped, stale, or wrong-platform result never evaluates as passed.
- Screenshots supplement semantic/domain assertions; they never stand alone.
- Development binaries never count as installed-package proof.

### Isolation invariants

- Tests never read or mutate the developer's `.vean/vean.db`, `~/.vean`, active
  project, or media library.
- Each run owns HOME, project root, DB, loopback port, WebDriver port, Vite port,
  temporary artifacts, and process group.
- All descendants are terminated and reaped after success, assertion failure,
  timeout, runner interruption, or parent termination.
- Desktop/native suites default to one instance unless complete isolation is
  explicitly proven.

### Security invariants

- Loopback binding is not treated as authentication. Mutations require
  launch-scoped authority and validated origin/host.
- WDIO plugins, permissions, global APIs, and the embedded WebDriver listener are
  test-only and mechanically absent from release builds.
- The random localhost viewer receives no production Tauri authority merely to
  simplify tests.
- CI test jobs never receive release signing or updater secrets.

### Media invariants

- Pure timeline math stays in Node tests.
- Browser component tests do not mock their way into codec/render claims.
- Live Remotion Player readiness uses buffering/events, not `delayRender()`.
- Production frame truth uses `renderStill()` and MLT/FFmpeg comparisons in a
  pinned environment.
- Chrome evidence does not stand in for WKWebView where codec, autoplay, or
  WebKit behavior matters.
- Performance budgets have warmup, sample counts, percentiles, and failure
  artifacts.

## Dependency graph

```text
H00 Harness oracle
 ├── H09A Early CI bootstrap
 ├── H01 Static workspace gates ───────────────┐
 ├── H02 Hermetic runtime/security ────────────┼── H03 React components
 │       └── H05 safe embedded spike ──────────┤      └── H04 Browser E2E ──┐
 │            └─ success: embedded suite       │                           │
 │            └─ safe failure: H05F fallback ──┘                           │
 └── H03K approved timeline keyboard contract ─────────────────────────────┘

H04 + actual-app branch ── H07B approved media/golden/perf policies ── H07 Media/perf
H02 + actual-app branch + H07 ── H08 package candidate ── H08R PM release lineage
all canonical commands + H09A ── H09 final CI/current evidence ── H10 guidance
```

H00 is PM-owned and lands first. H09A, H01, and H02 may then run in parallel.
H05 is a branch gate, not a dead end: safe embedded control continues in H05;
unsafe/incompatible control dispatches H05F, which proves a narrower actual-app
contract through Mac2/LaunchServices and run-scoped self-test telemetry without
granting production remote Tauri authority. If neither branch can prove a
required claim, that claim remains `blocked_with_user_decision`.

## Milestones

### M0 — trustworthy foundation

Units: H00, H09A, H01, H02, H05 spike (or H05F fallback).

Deliverables:

- manifest-driven command/evidence contract;
- honest viewer/Remotion/Rust static gates;
- hermetic fixture runtime and process-group cleanup;
- launch-scoped loopback authorization;
- enforced dev/test/release CSP and navigation policy;
- push-main CI immediately protecting the control plane and each subsequently
  merged canonical command;
- actual proof of what embedded WDIO can and cannot do after Vean's localhost
  navigation;
- release negative control for all test instrumentation.

Exit gate:

```text
bun run verify:fast
bun run verify:fixture --json
bun run verify:tauri
bun run verify:tauri-release-negative
bun run verify:harness --json
```

Do not build broad E2E suites until this milestone freezes the fixture and WDIO
contracts.

### M1 — developer and browser confidence

Units: H03K, H03, H04.

Deliverables:

- real-browser React component suite;
- semantic/keyboard/accessibility contracts;
- a Tejas-approved, hashed timeline keyboard/focus/announcement contract;
- consolidated real-server browser E2E;
- existing overlay/HMR/multi/error scenarios preserved;
- production-dist freshness proof;
- standardized failure evidence;
- `drive` remains the agent-facing live demonstration surface.

Exit gate:

```text
bun run verify:component
bun run verify:browser
bun run verify:harness --json
```

### M2 — platform and media confidence

Units: completed actual-app branch, H06, H07B, H07.

Deliverables:

- actual WKWebView editor/lifecycle suite;
- narrow Appium Mac2 menu/dialog/window smoke;
- Chrome + WKWebView live media matrix;
- Player buffering/seek/autoplay/error oracles;
- deterministic Remotion and MLT frame goldens;
- worker/resource/context-loss resilience;
- measured scrub/play/edit performance budgets.
- pre-registered codec/runtime matrix, golden provenance, performance policy,
  and curated live/export semantic-parity frames before acceptance runs;

Exit gate:

```text
bun run verify:tauri
bun run verify:macos
bun run verify:media
bun run verify:harness --json
```

### M3 — distributable product confidence

Units: H08, H08R, H09, H10.

Deliverables:

- packaged Vean core service, viewer assets, and renderer sidecars;
- clean-VM/user DMG installation through LaunchServices with checkout unmounted;
- one immutable release lineage joining source, nested binaries/resources,
  signed app, notarized/stapled DMG, updater payload, and every smoke result;
- end-to-end vN to vN+1 updater proof, not signature verification alone;
- package-bound Mac2 smoke and manual keyboard/VoiceOver assessment;
- push-main, macOS, native, and release CI lanes;
- failure evidence retention;
- current AGENTS/skills/roadmap command vocabulary with drift tests.

Exit gate:

```text
bun run verify:package
bun run verify:all
bun run verify:harness --json --require-ci
```

## Lane plan

| Lane | Dispatch | Owns | Starts when | Independent verifier |
|---|---|---|---|---|
| H00 Oracle | `pm_owned` | command facade, evidence envelope, structured controls, profiles, meta-tests | roadmap approved | check-contract |
| H09A Early CI | `pm_owned` | immediate push-main workflow and evidence skeleton | H00 merged | topology |
| H01 Static | `persistent_thread` | viewer/Remotion/Rust configs and static scripts | H00 merged | static-boundary |
| H02 Isolation | `persistent_thread` | fixtures, state/ports/process groups, loopback authority | H00 merged | security/lifecycle |
| H03K Keyboard contract | `pm_owned` | approved timeline focus/keyboard/announcement semantics | H00 merged | product/accessibility |
| H03 Components | `persistent_thread` | viewer browser component tests | H01 + H02 + H03K merged | React/accessibility |
| H04 Browser E2E | `persistent_thread` | browser runner, existing live scenario migration, drive integration | H02 + H03 merged | scenario-parity |
| H05 Tauri | `persistent_thread` | test-only plugins/config, actual WKWebView suite, release exclusion | H00 + H02 merged | security/native-WebView |
| H05F Fallback | `persistent_thread` | actual-app black-box/self-test proof if H05 safely fails | H05 branch decision | security/native-WebView |
| H06 macOS | `persistent_thread` | Appium Mac2 native smoke and doctor | H05 or H05F branch merged | native accessibility |
| H07B Media policies | `pm_owned` | runtime matrix, goldens, baselines/budgets, parity cases | H04 + actual-app branch | check-contract/media |
| H07 Media | `persistent_thread` | Player/render/media/resilience/perf oracles | H04 + actual-app branch + H07B | media correctness |
| H08 Package | `persistent_thread` | unsigned candidate BOM, packaged core, clean-host proof | H02 + actual-app branch + H07 | clean-machine/package |
| H08R Release | `pm_owned` | secrets, final lineage, sign/notary/updater/manual a11y | H08 merged | release/domain |
| H09 CI | `pm_owned` | final tier policy, current-run proof, per-tier failure artifacts | H09A + upstream commands + H08R | topology/secrets |
| H10 Guidance | `pm_owned` | AGENTS/roadmap/skills/docs/drift tests | H09 + H08R merged | source-of-truth |

Persistent lanes use private worktrees. Workers do not update canonical roadmap
status, generated final evidence, release secrets, or completion claims. PM
integrates in dependency order and reruns each oracle on canonical `main` after
merge.

### Collision and ownership ledger

| Shared surface | Potential lanes | Serialization rule |
|---|---|---|
| `package.json` / command facade | H00, H01, H09 | H00 lands first; H01 adds leaf commands; H09 changes workflows only unless PM reconciles facade |
| `app/src-tauri/Cargo.toml` / Rust bootstrap | H01, H02, H05, H05F, H08 | H01/H02 land before H05; only one actual-app branch writes afterward; H08 starts after branch freeze |
| `src/preview/` | H02, H04, H07 | H02 freezes security/fixture API; H04/H07 consume it and coordinate any extension through PM |
| viewer test bridges/instrumentation | H03, H04, H05, H07 | H03 owns semantic test utilities; H04 owns browser runner; H05/H07 use bounded adapters after prior merge |
| `.github/workflows/` | H09A, H09, H08R | PM-owned only; H09A skeleton is extended, not replaced; H08R supplies release job requirements without editing ordinary jobs |
| release evidence and truth status | all workers, H08R/H09/PM | Workers emit candidate evidence only; PM binds lineage and is the sole claim/status writer |
| AGENTS/ROADMAP/skills | H10 only | No worker edits guidance mid-program; PM records temporary truth in artifacts until H10 |

Control-plane artifacts land on `main` before dependent private worktrees are
created, so every worker sees the same manifest/schema. Workers may not edit the
truth manifest, claim status, profile membership, threshold approval, scenario
requirements, or release lineage. Their terminal state describes code
reconciliation only and never sets a claim terminal state.

## Lane requirements

Implementation-grade details, negative controls, surfaces, prompts, and risks are
canonical in `tauri-react-remotion-harness-units.jsonl`. The following policies
apply to all lanes.

### H00 — oracle first, independently proven

The evaluator is orchestration only. It must not reimplement test logic, and it
must not evaluate a claim about itself. Its meta-contract is proven separately by
executing the real evaluator against a fixed corpus of valid and adversarial
evidence bundles. Its downstream inputs are structured result files produced by
named commands. It validates:

- schema, source SHA, git tree, and clean status;
- lockfile, generated-asset, command implementation, fixture, scenario-ledger,
  executable/app/DMG/update, and parent artifact hashes;
- runtime/platform/fixture/workflow identity and timestamps;
- evidence freshness;
- claim-to-command mapping;
- expected predicates;
- structured sensitivity controls with a real setup mutation, before/after hash,
  expected reason code, cleanup, and pass-fail-pass restoration;
- terminal state.

`verify:all` has explicit `developer`, `macos`, `release-candidate`, and
`release` profiles. Each profile has a versioned required-claim set and forbids
implicit skips. A green developer profile is never product-release completion.

Until H00 lands, downstream worker dispatch is not safe because proposed oracle
commands do not yet exist. H09A lands immediately afterward so later waves are
protected as they arrive, rather than adding CI at the end.

### H02 — one fixture contract

All browser, WKWebView, Mac2, media, and package tiers consume the same run
descriptor. It should contain at least:

```json
{
  "runId": "...",
  "sourceSha": "...",
  "home": "...",
  "projectRoot": "...",
  "database": "...",
  "previewPort": 0,
  "vitePort": 0,
  "webdriverPort": 0,
  "authorityHandle": "reference to mode-0600 file or inherited descriptor",
  "artifactDir": "...",
  "processGroup": "..."
}
```

The general descriptor and result envelope never contain the authority secret.
Secrets are passed by a mode-0600 file or inherited descriptor, scanned out of
URLs/screenshots/logs/results/persisted files, and destroyed at teardown.

Isolation proof is behavioral: poisoned developer-state canaries, child process
environments, DB inodes, socket owners, conflicting writes, and unchanged hashes
of real developer state. Process cleanup is owned by an independent outer
watchdog that scans run markers, PGIDs, executable/start tuples, sockets, and
open fixture files; descendant count alone is insufficient after reparenting.

### H05/H05F — least-privilege WDIO decision tree

1. Build a debug/test-feature app with only
   `tauri-plugin-wdio-webdriver` and drive DOM after final localhost navigation.
2. If basic WebDriver is sufficient, do not install/expose the advanced frontend
   plugin.
3. If `@wdio/tauri-service` requires advanced support for essential evidence,
   load it only in a test viewer mode with an exact fixed localhost origin and
   minimal capability.
4. Never enable `withGlobalTauri` or WDIO permissions for the production random
   localhost viewer.
5. Inspect the release artifact and attempt a connection as negative proof.
6. If safe embedded control fails, dispatch H05F. H05F uses Mac2/LaunchServices
   user input plus a run-nonce- and binary-hash-bound self-test telemetry channel
   to prove the final viewer, media/action result, and lifecycle without remote
   Tauri authority. It cannot overclaim detailed DOM coverage.
7. If neither branch proves a required actual-app claim, mark it
   `blocked_with_user_decision`; do not shrink the denominator or silently use
   standalone Chrome.

Actual-app evidence is assembled outside page-controlled state: exact binary
path/hash/profile, app PID and bundle ID, driver/session capabilities, window,
macOS/WebKit version, final localhost URL, run nonce, canonical action result,
and independent `.mlt`/IR result.

### H07B/H07 — pre-register policy, then separate live and render truth

H07B first measures baselines and freezes a versioned, Tejas-approved codec
matrix, golden provenance, performance policy, and live/export semantic-parity
cases. Acceptance cannot regenerate those inputs or choose thresholds after
seeing results. The media result then reports distinct sections:

- `live.chrome`
- `live.wkwebview`
- `render.remotion`
- `render.mlt`
- `resilience`
- `performance`
- `performance.release-package`
- `live-export-parity`

One section cannot substitute for another. Required supported, unsupported, and
fallback cells are declared before execution. A required unavailable cell is a
reported blocker, never removed from the denominator or mocked green.

Every mutating/browser scenario independently verifies the canonical `.mlt`
hash and parsed IR, action ID/input/envelope, touched URI, and diagnostics. Viewer
stores and screenshots are not the document oracle. Live/export parity binds one
document/frame, composition, props, assets, and resolved React/Remotion versions
and compares semantic/perceptual markers rather than demanding cross-engine byte
identity.

Resource proof splits deterministic application ownership from browser stress:
an owned-handle ledger must close every frame/bitmap/decoder/worker/context, while
a separate pinned runtime stress checks queue, process memory, latency, and crash
bounds. Performance is measured separately in browser CI and the optimized final
package with bounded telemetry and recorded instrumentation overhead.

Current H07 implementation truth: the repo-authored synthetic corpus, candidate
goldens, headless-Chrome live/resilience runner, and baseline distribution command
exist. That baseline is deliberately `baseline_only`; it does not approve the
draft policies or promote candidate goldens. The five H07 acceptance claims remain
open until their exact claim commands pass with approved policies. In particular,
Chrome cannot substitute for the actual-WKWebView matrix, and development-host
timings cannot substitute for optimized installed-package measurements from H08.

### H08/H08R — package candidate, then canonical release lineage

The package lane is not complete when `tauri build` succeeds or when PATH/HOME
are merely scrubbed on the build Mac. H08 emits an immutable candidate BOM and
installs the exact DMG through LaunchServices on a clean VM/ephemeral user with
quarantine, checkout unmounted/denied, no Bun/Homebrew/caches, and empty HOME. It
records loaded/opened paths, network, state, project open, playback/scrub,
still/video hashes, quit, and port/process cleanup.

H08 receives no release secrets. PM-owned H08R creates one immutable lineage:

```text
source/tree/locks
  -> packaged core + viewer + sidecars
  -> unsigned app/DMG candidate
  -> signed app
  -> notarized/stapled DMG
  -> updater payload/signature
  -> installed final smoke + packaged Mac2 smoke + manual accessibility
```

Every stage records input/output/parent hashes. Final smoke reruns after signing
and notarization on the installed DMG hash. The updater proof installs vN,
serves signed vN+1, applies/relaunches, preserves project state, and proves
tamper/interruption/replay/downgrade failure atomicity; signature verification
alone is not enough. Manual keyboard/VoiceOver evidence is bound to the same
package, OS, VoiceOver version, assessor, and date.

The packaged-core format requires a short design decision before implementation:

- preferred: compiled Bun Vean service if dynamic imports, SQLite, viewer assets,
  and project Remotion resolution can be made explicit;
- fallback: bundled Bun runtime plus versioned source/assets;
- do not port the core to Rust merely to simplify packaging.

## CI topology

H09A establishes CI immediately after H00 and initially runs the independent
evaluator meta-contract plus whatever canonical commands already exist. It grows
after every merge batch. H09 later closes the final policy and current-run
evidence; implementation waves are not left unprotected until M3.

| Lane | Trigger | Runner | Parallelism | Secrets |
|---|---|---|---|---|
| Fast/static/unit | push to `main`, manual | Ubuntu | normal | none |
| Component/browser | push to `main`, manual | Ubuntu/Chrome | fixture-isolated | none |
| Tauri/WKWebView or H05F | push to `main` or scheduled after M2 | pinned macOS ARM | serial initially | none |
| Media WKWebView/perf | scheduled/manual, release candidate | pinned macOS ARM | serial | none |
| Mac2 native | scheduled/manual on prepared Mac | prepared/self-hosted Mac if hosted permissions fail | exactly 1 | none |
| Package smoke | manual/release candidate | pinned macOS ARM | serial | no signing for ordinary smoke |
| Sign/notary/updater | explicit release/tag | protected macOS lane | serial | Apple + updater keys only |

Every job calls the same `verify:*` command used locally. Workflow YAML may set up
dependencies, caches, runner permissions, and artifact upload; it may not contain
a second implementation of a test scenario.

The CI oracle validates actual check runs, not merely YAML mappings: exact current
`main` SHA or release-lineage hash, workflow blob hash, trigger/branch/path,
runner/platform, required conclusion, and non-skipped status. `continue-on-error`,
stale green runs, previous SHAs, different DMGs, cancelled/neutral jobs, and
manual mapping without a required execution do not verify a claim.

Mac2 and release lanes use repository/environment concurrency locks across runs,
not only `maxInstances: 1` within a job. Secret-bearing release jobs are PM-owned
and isolated from ordinary worker/test jobs.

On failure, `always()` cleanup runs before evidence upload. Each integration tier
has a tier-specific evidence schema and one controlled, reason-coded failure in
the actual CI job. An independent verifier retrieves the uploaded artifact by
run/job ID. Required evidence includes:

- result JSON and harness manifest;
- frontend/backend logs;
- DOM or accessibility snapshot as applicable;
- screenshot and focused render diff;
- process tree before/after teardown;
- fixture/runtime/version metadata;
- relevant timeline/action/diagnostic state.

## Completion oracle

The truth manifest defines 27 downstream claims plus an independently proven
evaluator meta-contract. A completion report is valid only after:

1. all implementation branches are reconciled to canonical `main`;
2. generated/static production assets are refreshed on `main`;
3. every in-scope oracle runs from `main` against current source/tree, scenario,
   command, fixture, lockfile, generated-asset, and tested-artifact hashes;
4. every structured sensitivity control proves baseline pass, named mutation
   with changed hash, failure for the exact expected reason, cleanup, and restored
   pass;
5. independent verifiers inspect observed files/results rather than PM prose;
6. each worker lane terminates as `merged`, `equivalent`, `no_delta`, or
   `discarded_with_reason`;
7. each claim terminates `verified` or is explicitly
   `blocked_with_user_decision`—blocked claims cannot be counted as complete.

Required verifier lenses before any “done” report:

- **check-contract:** can an oracle pass while the user-visible claim is false?
- **topology/security:** can worktree, port, process, CI, or secret state race or
  leak?
- **domain/source-of-truth:** can a mocked browser result overclaim media,
  document, package, or release truth?

## Escalation boundaries

Stop and ask Tejas only for:

- packaged-core format if the compiled Bun spike exposes a real product tradeoff;
- the intended keyboard semantics for timeline edit gestures;
- performance budget values after baseline distributions are available;
- self-hosted Mac/runner spend if hosted Appium permissions are inadequate;
- Apple signing/updater key custody and release authority;
- any proposal to expose remote Tauri authority in production.

Do not escalate ordinary dependency setup, fixture design, test refactors,
process cleanup, CI plumbing, or concrete static/runtime defects discovered while
making the gates honest.

## Definition of done

The harness program is done when:

- the evaluator meta-contract and all 27 truth-manifest claims are verified on
  canonical `main` or exact final release lineage;
- `verify:all` composes without accessing developer state or leaking processes;
- Chrome, actual WKWebView, and native AppKit evidence are clearly separated;
- Remotion Player and production render readiness are independently proven;
- performance and resilience negative cases fail for the intended reason;
- a DMG-installed app works on a clean host with Bun/source/Homebrew absent;
- live/export semantic parity and canonical `.mlt` truth are independently
  verified for every mutating acceptance scenario;
- package, sign/notary, updater, packaged Mac2, and manual VoiceOver evidence all
  reference one closed release lineage;
- production artifacts contain no test automation authority;
- CI runs the appropriate tiers and retains complete failure evidence;
- AGENTS, ROADMAP, skills, and contributor docs name the exact current commands;
- every identified, currently actionable harness issue is assigned to a lane and
  completion oracle.

## First PM-safe launch wave

Execution begins with H00 only. After its independent meta-contract and profile
oracle exist and validate this manifest, land H09A, then launch H01 and H02 in
separate persistent worktrees. H03K may be prepared for Tejas's decision. H05
begins only after H02 freezes fixture/process authority and is explicitly treated
as a reversible branch to H05F rather than a dead end.

The first canonical proof command after H00 is:

```text
bun run test tests/harness-contract.test.ts
```

This proves the evaluator independently against the fixed adversarial evidence
corpus. `bun run verify:harness --profile developer --json` is then expected to
remain nonzero/open until every required developer-profile oracle exists and is
verified; H00 must not manufacture a green aggregate for downstream work.
