# Check-contract / TDD verifier

## Verdict

The roadmap's tier boundaries are directionally strong, but the completion contract is not yet adversarially closed. The truth manifest can still be implemented as a command-and-ledger validator that reports green while the exercised product, platform, or release artifact is not the one named by the claim.

This is a specification audit only. No implementation command exists yet, so the exploits below describe conforming-but-false implementations that the current roadmap text would permit.

## Findings

### HIGH — The completion oracle is self-referential

- **Affected unit/claim:** H00; `claim-harness-oracle`; roadmap completion oracle (`tauri-react-remotion-harness-roadmap.md:341-353`); truth manifest lines 27-42.
- **Exploit / false-positive path:** `verify:harness` is both the evaluator and one of the claims it must see as `verified`. An implementation can special-case its own claim, ignore it, trust a prior self-produced record, or require a fixed point that can never be bootstrapped. All four implementations can plausibly satisfy “exit=0 and every in-scope claim ... verified” without an independent proof that the evaluator rejects false evidence.
- **Exact amendment:** Remove `claim-harness-oracle` from the set evaluated by its own aggregate. Define it as a meta-contract proven only by `tests/harness-contract.test.ts` against a fixed corpus of valid and invalid evidence bundles. `verify:harness` must evaluate the remaining 20 claims and emit `evaluator_contract_version`; the meta-test must execute the real evaluator binary on that corpus and assert exact exit/status/reason codes. The final completion rule must require both the meta-test result and the 20-claim evaluation.

### HIGH — Negative controls have no executable semantics

- **Affected unit/claim:** H00 and every truth-manifest claim; roadmap evidence invariants (`roadmap.md:46-54`) and manifest `negative_control_command` fields.
- **Exploit / false-positive path:** The manifest records only a command string. It does not say whether the command should exit zero after detecting a seeded defect, exit nonzero because the product is bad, which defect must be active, which oracle predicate must flip, or what evidence proves the defect was actually introduced. A no-op `--scenario` implementation can print “negative control passed” and satisfy every current entry. Several controls are especially ambiguous: `parent-kill`, `pointer-only-clip`, `corrupt-golden`, and `tampered-bundle` could mean either a successful detection test or an intentionally failing product run.
- **Exact amendment:** Replace each string with a structured negative-control object containing `control_id`, `setup_command`, `mutation_or_fixture_hash`, `oracle_command`, `expected_oracle_exit`, `expected_status`, `expected_reason_code`, `cleanup_command`, and `evidence_paths`. Require a paired sensitivity assertion: baseline fixture passes; the one named mutation fails for the named reason; reverting only that mutation restores pass. The evaluator must reject controls whose setup did not change the declared input hash or whose failure reason is unrelated.

### HIGH — Evidence freshness is not bound to the tested tree and artifact

- **Affected unit/claim:** H00, H05, H07, H08, H09; all runtime/release claims; roadmap evidence invariants (`roadmap.md:48-54`, `341-353`).
- **Exploit / false-positive path:** A result can report the current `sourceSha` while being produced from a dirty worktree, stale `viewer/dist`, a previously built Tauri binary, a different DMG, changed lockfile resolution, or an artifact copied from another run. `generated_at`, run ID, and source SHA alone do not prove input or binary identity. The roadmap itself calls out production-asset refresh but does not specify a machine-checkable binding.
- **Exact amendment:** Define an immutable evidence envelope with `git_sha`, `git_tree_hash`, `git_status_clean=true`, lockfile hashes, generated-asset hashes, command implementation hash, fixture hash, executable/app/DMG/update SHA-256, platform image/runtime versions, start/end timestamps, and monotonic run ID. Every downstream result must name the exact parent artifact hash it exercised. `verify:harness` must recompute locally available hashes, reject dirty/untracked production inputs, reject results older than their inputs, and reject cross-run artifact substitution.

### HIGH — `verify:all` has no claim, profile, or composition contract

- **Affected unit/claim:** H00/H09; roadmap M3 exit gate and definition of done (`roadmap.md:197-203`, `378-391`).
- **Exploit / false-positive path:** `verify:all` may omit macOS, package, signing, updater, or performance tiers and still “compose.” Conversely, requiring release-secret lanes makes it impossible as an ordinary local command, encouraging silent skips. No truth-manifest claim asserts the aggregate's membership, failure propagation, skip policy, or profile.
- **Exact amendment:** Add `claim-aggregate-composition`. Define explicit profiles such as `developer`, `macos`, `release-candidate`, and `release`, each with an ordered required claim set and permitted `not_applicable` conditions. `verify:all --profile <name>` must emit child run IDs, propagate any non-verified required child, and reject implicit skips. The release profile must require package/signing/updater evidence; the developer profile must never be described as product completion.

### HIGH — Hermeticity can pass by reporting disjoint descriptors while using shared state

- **Affected unit/claim:** H02; `claim-hermetic-runs`; manifest lines 63-78.
- **Exploit / false-positive path:** Two fixture descriptors can contain different HOME/DB/port strings while the spawned Bun, Vite, Tauri, or test driver ignores them and reads the developer's actual HOME or `.vean`. The current predicate checks what fixtures “report,” not what processes opened, bound, or mutated.
- **Exact amendment:** Require behavioral sentinels. Start fixtures under an environment with poisoned developer-state values and unique canary records; assert each child process environment, bound socket owner, DB file inode, project writes, and action results correspond only to its run. Afterward hash the real developer `.vean`, `~/.vean`, and active-project config and require no change. The concurrent test must perform conflicting writes with identical logical IDs and prove isolation through both API output and separate on-disk DB contents.

### HIGH — Descendant-count cleanup misses reparented or detached orphans

- **Affected unit/claim:** H02/H05/H09; `claim-process-cleanup`; manifest lines 81-96.
- **Exploit / false-positive path:** After a parent dies, a Vite/render child can be reparented and no longer appear in a descendant traversal. The oracle can report `descendant_count_after=0` while the tagged process, listening port, temp lock, or open file survives. A parent-kill scenario executed inside the parent cannot reliably attest to its own post-mortem cleanup.
- **Exact amendment:** Make an independent outer watchdog own the scenario. Stamp every process with an unforgeable run marker and record process start time/executable/PGID. After normal exit, assertion failure, timeout, SIGTERM, SIGKILL, and test-runner interruption, scan by marker, PGID, executable/start tuple, owned ports, and open fixture files; require zero matches after a bounded grace period and reap status for known children. Seed a detached/reparenting child as the negative control and require detection.

### HIGH — Loopback authorization can be proven in-process while the real server remains vulnerable

- **Affected unit/claim:** H02; `claim-loopback-authority`; roadmap security invariants (`roadmap.md:67-75`); manifest lines 99-114.
- **Exploit / false-positive path:** `tests/preview-auth.test.ts` can call a handler directly with ideal headers while Bun's bound server, Vite proxy, redirects, GET endpoints with side effects, WebSocket/HMR path, or actual WKWebView token transport behaves differently. The manifest omits the roadmap's Host check and does not pin token replay after restart, token leakage, an Origin-less native request, or hostile browser simple requests.
- **Exact amendment:** Require black-box tests against the bound production-mode server from (1) the launch-authorized viewer, (2) a different localhost origin, (3) a non-loopback Host/DNS-rebinding simulation, (4) missing/`null`/wrong Origin, (5) missing/wrong/replayed prior-launch token, and (6) form-encoded simple requests. Enumerate every mutating or process-starting route and require uniform rejection before body parsing. Assert tokens never appear in URLs, screenshots, logs, result JSON, or persisted files.

### HIGH — Broad browser and native claims lack canonical scenario ledgers

- **Affected unit/claim:** H03-H06; `claim-react-components`, `claim-dom-accessibility`, `claim-browser-editor`, `claim-tauri-wkwebview`, and `claim-native-macos-shell`.
- **Exploit / false-positive path:** Predicates such as “component scenario ledger current,” “all canonical browser scenarios,” “all core scenarios,” and “serialized Mac2 scenario ledger” never enumerate required scenario IDs or assertions. A runner can define its canonical ledger as the one easiest happy path and pass. H04's prose asks for one-to-one migration of five live scripts, but neither the manifest nor a checked mapping names them.
- **Exact amendment:** Add versioned scenario manifests per tier. Each must list stable scenario ID, source requirement, fixture, engine/platform, user action, domain assertion, semantic assertion, forbidden substitution, negative control, and artifact set. Seed the five existing live scenarios explicitly and enumerate the required action/diagnostic/HMR/prod-dist flows. The completion evaluator must compare executed IDs to the required ledger version and reject missing, renamed, duplicate, or skipped scenarios.

### HIGH — Production instrumentation absence can pass with an insensitive detector

- **Affected unit/claim:** H05; `claim-test-instrumentation-absent`; manifest lines 189-204.
- **Exploit / false-positive path:** Checking three reported booleans and an empty port array does not prove the inspected release lacks test plugins, capabilities, frontend globals, alternate listeners, or embedded dependencies. Connection failure may simply target the wrong port. Using a debug binary as the negative control does not prove the release scanner would detect a release-shaped instrumented artifact.
- **Exact amendment:** Specify independent static and dynamic checks over the exact release artifact hash: Cargo feature/dependency graph, compiled symbols/strings where reliable, capability/resource manifests, frontend bundle globals/imports, plugin registration, child listeners, and a bounded full loopback-listener inventory owned by the app process tree. Build a release-profile mutant with one test feature/capability enabled and require the same scanner to fail with a specific reason. Then scan and attempt connection against the exact DMG-installed app used by H08.

### HIGH — The live-media runtime matrix can redefine unsupported cells away

- **Affected unit/claim:** H07; `claim-live-media`; roadmap media invariants and H07 sections (`roadmap.md:77-87`, `286-298`); manifest lines 225-240.
- **Exploit / false-positive path:** “Required runtime matrix” is not enumerated. An implementation can mark WKWebView codec/autoplay cells unsupported, remove them from `required`, and pass Chrome only, even though the claim says Chrome and WKWebView. It can also test synthetic canvas frames instead of actual decoded fixture media.
- **Exact amendment:** Predeclare the required matrix: exact macOS version/build, hardware class, Chrome version, WKWebView/WebKit version, codec/container/audio fixtures, source/proxy path, autoplay gesture state, seek points, and expected observable events/frames/audio clock. A required unsupported cell must produce `blocked_with_user_decision`, never reduce the denominator. Evidence must include actual engine identity and media probe/hash, and the negative control must disable one real capability while leaving the rest intact.

### HIGH — Render and performance predicates permit post-hoc thresholds

- **Affected unit/claim:** H07; `claim-render-fidelity` and `claim-performance-budget`; manifest lines 243-258 and 279-294.
- **Exploit / false-positive path:** “Meet thresholds in pinned environment” and “approved p50/p95/max policy after warmup” do not name threshold values, sample counts, warmup, fixture hashes, color pipeline, machine load, or approval artifact. The implementation can choose a permissive threshold after seeing results, use one sample, or compare output against a golden regenerated by the same broken code.
- **Exact amendment:** Before acceptance runs, commit a versioned budget/golden policy containing independent reference provenance, fixture and golden hashes, render tool/runtime versions, color/pixel normalization, exact metrics, warmup, sample count, percentile estimator, machine/load constraints, thresholds, retry policy, and approval identity/date. Golden generation and comparison must be separate commands; acceptance may not regenerate. Negative controls must introduce a known pixel delta and calibrated latency/resource regression that crosses the pre-registered threshold.

### HIGH — “Clean machine” can still access the source or developer runtime

- **Affected unit/claim:** H08; `claim-self-contained-package`; roadmap package truth (`roadmap.md:300-313`); manifest lines 297-312.
- **Exploit / false-positive path:** Scrubbing PATH/HOME on the build Mac does not make the source checkout unavailable, prevent absolute-path fallback, remove Homebrew dylib resolution, simulate LaunchServices environment behavior, or prove DMG installation/quarantine. A shell-launched build-tree `.app` can pass while the downloaded app fails.
- **Exact amendment:** Exercise the exact release artifact hash after DMG installation into a clean macOS user/VM or equivalent sandbox where the checkout path is unmounted/denied, Homebrew paths are absent, no Bun exists, HOME begins empty, and quarantine/Gatekeeper applies. Launch through `open`/LaunchServices, not directly from the shell. Record executable and loaded-library paths, opened runtime assets, created state, project open, playback/scrub, still/video hashes, quit, and post-quit process/port scan.

### HIGH — Package, signing, notarization, and updater claims are not joined by artifact identity

- **Affected unit/claim:** H08; `claim-self-contained-package`, `claim-signed-release`, `claim-updater`; roadmap M3.
- **Exploit / false-positive path:** Package smoke can run an unsigned app A, signing can inspect app B, notarization can staple DMG C, and updater can verify archive D. Each claim can independently pass while no single downloadable artifact has all properties. Signing nested binaries can also break an app after the earlier smoke.
- **Exact amendment:** Introduce a release-artifact lineage manifest. Every stage records input/output hashes and parent relationship: core bundle -> signed `.app` -> notarized/stapled DMG -> updater archive/signature. The final package smoke must rerun after signing/notarization on the installed DMG hash, and updater proof must install/update to a hash whose signed app payload matches the release lineage. Completion requires one closed lineage, not independent green records.

### HIGH — Updater proof can stop at signature verification

- **Affected unit/claim:** H08; `claim-updater`; manifest lines 333-348.
- **Exploit / false-positive path:** A helper can report “authentic accepted, tamper rejected” by checking signatures without exercising Vean's configured updater, version selection, download, install, relaunch, state preservation, or failure atomicity. The user-visible updater can remain absent or broken.
- **Exact amendment:** Define an end-to-end two-version test: install signed/notarized N, serve an authenticated N+1 manifest/artifact from an isolated fixture server, invoke Vean's production updater path, assert download and signature verification, relaunch, exact version/artifact hash, preserved fixture project, and no orphan. For tampered metadata, archive, signature, interrupted download, and rollback/version-replay cases, assert N remains runnable and unchanged.

### HIGH — CI enforcement checks mapping, not execution

- **Affected unit/claim:** H09; `claim-ci-enforcement`; manifest lines 351-366.
- **Exploit / false-positive path:** `verify:harness --require-ci` may validate only that every claim names a YAML/manual lane. A disabled workflow, non-triggering path filter, `continue-on-error`, skipped matrix cell, stale successful run, or manual-only assignment can pass the mapping while required gates never enforce `main`.
- **Exact amendment:** Add a machine-readable CI policy per claim: required workflow/job, trigger/event, branch/path policy, platform, required/non-required status, maximum evidence age, and whether manual is allowed. The oracle must inspect actual GitHub check runs for current `main` SHA and require expected conclusion, non-skipped status, matching workflow blob hash, and protected release/tag context where relevant. Negative controls must cover removed trigger, skipped job, `continue-on-error`, stale SHA, and missing required check.

### HIGH — One controlled failure cannot prove evidence retention for every tier

- **Affected unit/claim:** H09; `claim-failure-evidence`; manifest lines 369-384.
- **Exploit / false-positive path:** A local `harness-evidence.test.ts` can manufacture a complete directory for one fake failure while actual Chrome, WKWebView, Mac2, media, package, and release jobs lose logs or skip `always()` upload. “Every failing integration tier” is broader than the proposed oracle.
- **Exact amendment:** Define a required evidence schema per integration tier and run one controlled, reason-coded failure in the actual CI job for each tier. After the job fails, an independent verifier must retrieve the uploaded artifact by run/job ID and validate result JSON, logs, engine identity, DOM/accessibility snapshot where applicable, screenshot, process audit, and media diff where applicable. A missing artifact must remain a failing claim even if the test failure itself was expected.

### MEDIUM — Static “all owned code” proof is not platform-complete

- **Affected unit/claim:** H01; `claim-static-owned-code`; CI topology (`roadmap.md:315-325`).
- **Exploit / false-positive path:** The primary fast/static lane is Ubuntu, while the Tauri shell contains macOS-specific menu/dialog/window paths and conditional dependencies. `cargo clippy --all-targets --all-features` on one host cannot prove code compiled only for another target; a Linux-only green result can satisfy the broad claim.
- **Exact amendment:** Split the predicate into platform-neutral TS/Remotion/Rust and macOS-target Rust. Require macOS `cargo fmt`, `cargo check/test`, and clippy for the actual app feature set on the pinned macOS toolchain; record target triple and cfg/features. Narrow the claim if some code is intentionally runtime-only and covered by H05/H06 instead.

### MEDIUM — Timeline keyboard/accessibility truth is unresolved but appears gate-ready

- **Affected unit/claim:** H03; `claim-dom-accessibility`; escalation boundary `roadmap.md:367-369`.
- **Exploit / false-positive path:** The user-facing keyboard semantics for clips, trims, ruler, focus, selection, and announcements are explicitly deferred to product judgment, yet the claim can be implemented as “axe has zero blocking issues” plus toolbar shortcuts. The pointer-only editing workflow can remain unusable while the broad machine-detectable accessibility claim passes.
- **Exact amendment:** Before H03 completion, record a user-approved accessibility/keyboard acceptance matrix for the timeline: focus order, clip/ruler roles and names, selection state, seek/edit keys, modifier behavior, focus preservation, error/status announcements, and unavailable-operation feedback. `blocked_with_user_decision` must block M1 accessibility completion until that matrix exists; axe alone is insufficient.

### MEDIUM — Guidance drift can pass while semantic advice contradicts reality

- **Affected unit/claim:** H10; `claim-guidance-current`; manifest lines 387-402.
- **Exploit / false-positive path:** Tests that reject removed command names can still pass if docs use valid commands but claim the wrong evidence tier, say production uses a dev snapshot, omit required platform constraints, or present `verify:browser` as native proof.
- **Exact amendment:** Give each documented verification recipe a structured tier/claim annotation and validate it against the truth manifest. Add curated forbidden-overclaim fixtures and assertions for engine, platform, package, and release boundaries. Require a human-readable source-of-truth table generated from (or checked against) the manifest rather than only lexical command discovery.

### MEDIUM — CI arrives too late to protect most implementation waves

- **Affected unit/claim:** H09 sequencing; dependency graph and lane table (`roadmap.md:89-108`, `205-219`).
- **Exploit / false-positive path:** H09 depends on H08 and starts only after every canonical command exists. H00-H08 can therefore be implemented and merged with no automatic push enforcement, even though the program's purpose is a durable harness. Late CI may discover environment and orchestration failures after most work has stacked.
- **Exact amendment:** Split H09 into incremental units. H09a lands after H01/H02 with fast/unit/fixture jobs and evidence schema; H09b adds component/browser after H04; H09c adds WKWebView/media/package/release as their commands land. Each milestone exit must require current-main CI evidence for every automated tier available at that milestone.

### MEDIUM — Native Mac evidence does not identify the prepared machine state

- **Affected unit/claim:** H06; `claim-native-macos-shell`.
- **Exploit / false-positive path:** “Prepared Mac” and a serialized ledger do not pin OS build, Appium/Mac2/Xcode versions, Accessibility authorization, display/session state, app hash, or cleanup baseline. A ledger from a different machine/app or a manually repaired permission state can be reused.
- **Exact amendment:** Require the Mac2 result envelope to include machine ID class, macOS build, Xcode/XCTest/Appium/Mac2 versions, authorization doctor output, console session/display facts, app artifact hash, pre/post app/dialog/window inventory, and run timestamp. Reject evidence not tied to the current app hash and approved prepared-runner profile.

### MEDIUM — Resilience can report recovery while showing stale or synthetic output

- **Affected unit/claim:** H07; `claim-media-resilience`.
- **Exploit / false-positive path:** A WebGL-restored flag or bounded JS object counter can pass while the canvas remains on the last good frame, audio/clock diverges, or native GPU resources leak outside JavaScript instrumentation. “Resources return within bounds” is undefined.
- **Exact amendment:** For each injected failure, require a post-recovery seek to multiple known frames, pixel/domain comparison to independent references, advancing audio/master clock agreement, no unexpected error logs, and bounded process/GPU-memory proxy over repeated loss/recovery cycles. Define exact resource counters/bounds and seed a stale-frame recovery mutant.

## Claim-by-claim coverage

| Truth-manifest claim | Result | Findings that must be absorbed |
|---|---|---|
| `claim-harness-oracle` | GAP | self-reference; negative-control semantics; evidence binding |
| `claim-static-owned-code` | GAP | platform-complete static proof |
| `claim-hermetic-runs` | GAP | reported descriptors do not prove observed isolation |
| `claim-process-cleanup` | GAP | reparented/detached orphan detection |
| `claim-loopback-authority` | GAP | real bound-server/Host/replay/leakage coverage |
| `claim-react-components` | GAP | canonical component scenario ledger |
| `claim-dom-accessibility` | GAP | canonical ledger; unresolved timeline keyboard contract |
| `claim-browser-editor` | GAP | explicit one-to-one scenario ledger |
| `claim-tauri-wkwebview` | GAP | explicit core scenario ledger; artifact identity |
| `claim-test-instrumentation-absent` | GAP | detector sensitivity and exact release artifact |
| `claim-native-macos-shell` | GAP | scenario ledger and prepared-machine identity |
| `claim-live-media` | GAP | immutable Chrome/WKWebView runtime matrix |
| `claim-render-fidelity` | GAP | pre-registered independent goldens/thresholds |
| `claim-media-resilience` | GAP | user-visible recovery and exact resource bounds |
| `claim-performance-budget` | GAP | pre-registered measurement/budget protocol |
| `claim-self-contained-package` | GAP | genuine installed clean-machine boundary |
| `claim-signed-release` | GAP | closed release artifact lineage |
| `claim-updater` | GAP | actual N -> N+1 product updater flow |
| `claim-ci-enforcement` | GAP | current-SHA execution, not YAML mapping |
| `claim-failure-evidence` | GAP | controlled failure/upload proof per tier |
| `claim-guidance-current` | GAP | semantic tier-overclaim drift |

## Required TDD disposition

The spec is **not clean**. All findings are closeable through roadmap/manifest/unit amendments except two intentionally user-gated values already recognized by the roadmap: the exact timeline keyboard interaction contract and the performance budgets after baseline measurement. Those two must remain blocking decisions, not be silently narrowed or marked verified.

After amendments, rerun this verifier against the updated manifest. The next pass should be able to answer, for each claim: which exact artifact was exercised, which exact required scenarios ran on which engine/platform, what independent mutation proved the oracle sensitive, and why no stale or substituted evidence could satisfy it.
