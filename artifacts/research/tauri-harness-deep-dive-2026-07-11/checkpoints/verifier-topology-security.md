# Verifier checkpoint — topology, worktrees, and security

Date: 2026-07-11  
Lens: dependency graph, lane collisions, PM gates, worktree safety, runtime isolation,
CI topology, secrets, test-only authority, and terminal states  
Verdict: **amend before execution**

The roadmap has the right layered architecture and mostly sensible dependency
ordering. Execution should not begin yet: four control-plane gaps can make the
program impossible to complete safely even if every worker follows its card.

## Findings

### TS-01 — Critical — H05, H06, H07, H08, H09: the WDIO fallback is not an executable graph branch

**Failure mode:** H05 is described as a stop/go spike with a safe fallback to
browser tests plus Mac2 if embedded WDIO cannot drive Vean's final localhost
viewer. The graph nevertheless requires H05 to merge before H06/H07/H08, the
truth manifest still requires `claim-tauri-wkwebview` and Chrome+WKWebView live
media to become `verified`, and program completion requires all 21 claims. An
H05 result of `discarded_with_reason` therefore leaves no legal route to H06,
H07, H08, H09, or “done.” Prose says fallback; topology says dead end.

**Exact amendment:** Split H05 into `H05A compatibility/security probe` and one
of two PM-selected successor edges:

- `H05B embedded-WDIO suite` when the result is `embedded_basic_safe` or
  `embedded_advanced_safe`;
- `H05C fallback native-lifecycle suite` when the result is
  `embedded_unsupported_safe`, using browser editor proof plus bounded Mac2
  lifecycle/package proof without remote Tauri authority.

Add these allowed H05A decision results to the manifest, identify which claims
H05C can verify, and require a user/PM scope decision for claims that genuinely
cannot be proven (especially actual WKWebView DOM/media). Do not allow a
discarded H05 lane to satisfy dependencies implicitly. Update H06/H07/H08/H09
start conditions to reference the selected successor, and add an oracle test for
each branch.

### TS-02 — Critical — H08: release secrets and release proof are assigned to a worker that is forbidden to receive them

**Failure mode:** The global worker contract forbids release secrets, but H08's
completion criteria require Developer ID signing, notarization, stapling, and a
signed updater. H08 also begins before the packaged-core format and key-custody
decisions are frozen. The lane can neither complete nor safely own the final
release claim as written.

**Exact amendment:** Split H08 into:

1. `H08A packaged-core design gate` (`pm_owned`) — records the selected format,
   asset closure, GPL boundary, and clean-machine oracle before implementation;
2. `H08B package implementation` (`persistent_thread`, no secrets) — produces
   the unsigned/ad-hoc download-equivalent artifact and package tests;
3. `H08C signed-release/updater proof` (`pm_owned`, protected environment) —
   imports Apple/updater secrets only after H08B is reconciled, signs the exact
   hashed artifact, notarizes/staples it, executes the updater test in an
   expendable environment, and records proof.

Make `claim-self-contained-package` owned by H08B and `claim-signed-release` /
`claim-updater` owned by H08C. H08C may start only after explicit key-custody and
release-authority approval.

### TS-03 — Critical — H09: CI arrives after the whole implementation program

**Failure mode:** H09 depends on H01/H03/H04/H05/H07/H08, so no push gate exists
while those large lanes are landing. The program can regress H00/H01/H02 for
multiple waves before CI exists. H09 also omits H06 even though it owns the
Mac2 lane assignment and the final `--require-ci` mapping.

**Exact amendment:** Split CI into two PM-owned units:

- `H09A CI bootstrap`, after H00+H01+H02, installs read-only workflow
  permissions, `verify:fast`, manifest validation, fixture/isolation checks,
  artifact schema checks, concurrency groups, and controlled-failure upload;
- `H09B CI expansion/final mapping`, incrementally adds H03–H08 commands only
  after each canonical command lands, and depends explicitly on H06 plus the
  selected H05 successor and H08C.

Require every merge batch to add its command to CI before the next dependent
wave starts. The final `claim-ci-enforcement` remains H09B-owned.

### TS-04 — Critical — H05: the production-authority negative gate is under-specified

**Failure mode:** The manifest's predicate (`wdio_features=false,
wdio_permissions=false, webdriver_ports=[]`) could pass while production still
ships the WDIO guest bundle, `withGlobalTauri`, a broad remote localhost
capability, a dormant plugin crate, or an environment-triggered listener on a
different port. Current Vean also has `csp: null`; no claim owns restoring a
production CSP or ensuring the test fixed-origin capability is absent.

**Exact amendment:** Expand `claim-test-instrumentation-absent` into a release
artifact inspection contract that checks all of the following on the exact
package hash:

- Cargo metadata/SBOM excludes both WDIO plugin crates and the feature is off;
- bundled JS contains no `@wdio/tauri-plugin`, `wdioTauri`, or mock registry;
- production config has no `withGlobalTauri`, WDIO permission, test remote URL,
  or test capability file;
- production CSP is explicit and passes its own policy test;
- launching with `TAURI_WEBDRIVER_PORT=<leased-port>` and every documented WDIO
  trigger still produces no listener;
- a localhost client cannot create a WebDriver session or invoke a WDIO command.

Seed one test-enabled package and require this inspector to reject it. Assign
production CSP/config ownership explicitly to H05 or H08B rather than leaving it
between their surfaces.

### TS-05 — High — H02: the run descriptor risks becoming a credential artifact

**Failure mode:** The sample descriptor contains `authorityToken` while the same
descriptor/evidence system is intended for retained CI artifacts. “Redacted in
logs” does not prevent the token from entering JSON, screenshots, URLs,
subprocess argv, crash reports, or uploaded manifests. A fixed token or leaked
query parameter defeats launch-scoped loopback authority.

**Exact amendment:** Separate public run metadata from secret runtime state.
The public descriptor stores only a token ID/fingerprint. Put the random
high-entropy token in a mode-0600 per-run secret file or inherited pipe/env that
is never uploaded; never place it in a URL or argv. Bind it to run ID, exact
origin/Host, method/scope, and expiry; rotate every run; compare safely; delete
it during teardown. Add a recursive evidence-redaction gate that scans JSON,
logs, screenshots metadata, and process argv for the seeded token and fails if
found. Run wrong-token, stale-token, wrong-Origin, wrong-Host, and DNS-rebinding
negative cases.

### TS-06 — High — H02/H05: port ownership and fixed-origin testing conflict

**Failure mode:** The fixture schema initializes ports to `0`, yet every run is
said to own explicit ports and H05 may require one exact fixed localhost origin
for Tauri capability safety. “Find a free port, close, then launch” is a TOCTOU
race. Parallel local sessions can connect to a stale or wrong app, while a fixed
H05 port can collide across workflow runs.

**Exact amendment:** Define a port-leasing protocol in H02: reserve sockets
until the child accepts handoff, record allocated nonzero ports plus expected
PID/start time, and verify endpoint run ID before use. For H05's fixed-origin
mode, allocate a documented test-only port range and hold an exclusive
machine/workflow lock; native suites remain serial. Reject port reuse, wrong
run ID, wrong PID owner, and pre-bound-port cases. Do not let `0` leave the
allocator boundary or appear in evidence as if it were the used port.

### TS-07 — High — H02: process cleanup needs identity-safe mechanics, not only a zero-count predicate

**Failure mode:** Vean currently owns a Tauri → Bun → Vite/media descendant
tree. Upstream WDIO sends SIGTERM/SIGKILL and itself uses broad `pkill` cleanup.
A naive process-name cleanup can kill developer processes; PID reuse can make a
stale journal dangerous; killing only Tauri can orphan Bun/media children.

**Exact amendment:** Make H02's process contract explicit: each child joins a
run-owned process group/session, is tagged with run ID, and is journaled with
PID, parent PID, executable, start time, and bound ports. Teardown sends TERM to
the owned group, waits/reaps, escalates to KILL, then audits descendants and
port owners. Never use unqualified `pkill vean`, `pkill bun`, or port-owner kill
on a developer machine. Negative controls must cover assertion failure, timeout,
SIGTERM, SIGKILL, runner cancellation, detached grandchild, and PID-journal
reuse without harming an unrelated sentinel process.

### TS-08 — High — H08/H09: no immutable artifact lineage joins build, smoke, signing, updater, and evidence

**Failure mode:** Separate lanes can test an unsigned build, rebuild for signing,
notarize another artifact, and publish an updater made from a third while every
local command reports green. The roadmap mentions source SHA but not a
content-addressed package handoff.

**Exact amendment:** Add a PM-owned release artifact manifest containing source
SHA, lockfile hashes, runner image, app version/build number, bundle hash,
nested-code/resource hashes, entitlements, sidecar manifest hash, updater hash,
and every proof result. H08B emits one immutable artifact; H08C signs/notarizes
that artifact without rebuilding; clean-machine smoke and updater acceptance
refer to the same lineage. H09 verifies artifact attestations/digests on
download. A negative control substitutes a same-name artifact with a different
hash and must fail before launch/sign/publish.

### TS-09 — High — H07: performance baseline and approval are hidden mid-lane terminal gates

**Failure mode:** H07 cannot satisfy `claim-performance-budget` until baseline
distributions exist and Tejas approves product budgets. The current single lane
also owns media correctness, so it can sit indefinitely `ready_to_reconcile` or
mix an unresolved product decision into otherwise finished work.

**Exact amendment:** Split H07 into `H07A media/resilience + performance
instrumentation`, then a `G07 budget approval` PM/user gate that records pinned
hardware/runtime, warmup, sample count, p50/p95/max policy and allowed variance,
then `H07B performance enforcement`. Let H08B depend on the media/package-relevant
parts of H07A, while final performance and program completion depend on H07B.
Do not allow `blocked_with_user_decision` to count as verified performance.

### TS-10 — High — H06/H09: macOS runner identity and cross-run serialization are not enforceable yet

**Failure mode:** The CI table says “pinned macOS ARM” but uses conceptual runner
names; `macos-latest` is mutable. “Exactly 1” does not serialize two workflow
runs on one prepared Mac. Cancellation can interrupt teardown and leave dialogs,
TCC state, Appium, or applications for the next run.

**Exact amendment:** Record an exact supported runner label/image/Xcode/WebKit
tuple and emit it in evidence. Give Tauri, media/perf, Mac2, package, and release
jobs explicit GitHub concurrency groups; self-hosted Mac2 uses a machine-level
lease and `cancel-in-progress: false`. Add preflight/after-always cleanup and a
clean-state doctor before acquiring the app. Define a hosted-failure branch to a
named self-hosted label with TCC/bootstrap documentation, not an informal
“prepared Mac.” Pin performance comparisons to one hardware class.

### TS-11 — High — H09/H08C: secret-bearing CI trust boundaries are only prose

**Failure mode:** “Protected macOS lane” and “secrets only” do not define GitHub
permissions, trusted refs, reusable-workflow inheritance, cache/artifact trust,
or environment approval. A public OSS workflow that inherits secrets broadly or
consumes an untrusted artifact/cache could expose Apple/updater keys or sign
unreviewed bytes.

**Exact amendment:** Specify a protected GitHub Environment with required human
approval for H08C/release; restrict it to canonical tags/commits; set default
`permissions: contents: read` and grant only minimal per-job permissions; never
use `pull_request_target` or broad `secrets: inherit`; do not expose secrets to
fork/untrusted jobs; disable untrusted caches for signing; verify artifact digest
and source SHA before secrets are loaded; mask and post-scan logs; use ephemeral
keychains and delete imported credentials in `always()`. Keep updater private-key
backup/custody outside CI and record the public key fingerprint in the release
manifest.

### TS-12 — Medium — H00/H01/H02/H04/H05/H08/H09/H10: overlapping files lack a collision ledger

**Failure mode:** Dependencies serialize most overlaps, but the launch companion
does not name them. `package.json` is shared by H00/H01/H09; Cargo/app surfaces
by H01/H02/H05/H08; `.agents/skills/drive/SKILL.md` by H04/H10. A lane created
too early from an old base can reintroduce prior command/config content during
reconciliation.

**Exact amendment:** Add a collision table with file family, ordered owners, and
final integrator. Create worktrees just in time only after dependencies are on
canonical main; record base SHA in the lane card; require workers to stop on
unexpected overlap. Before reconciliation, PM records expected main SHA,
rebases/merges in dependency order, reviews only the lane diff, reruns that
unit's oracle, and deletes the worktree/branch after landing. H09 is the final
`package.json` owner; H08B is the final app packaging/runtime owner before H08C;
H10 is the final guidance/drive-skill owner.

### TS-13 — Medium — H00/control plane: execution artifacts are not yet visible to new worktrees

**Failure mode:** At audit time all roadmap/research/spec files are untracked on
main at `d71e9f4`, while two detached worktrees already exist. A new H00 worktree
created from current main would not contain the truth manifest or unit registry
it is instructed to validate.

**Exact amendment:** Before execution, reconcile verifier amendments, validate
JSON/JSONL, commit the complete planning artifact set as one canonical unit,
record the new SHA, rerun `git status` and `git worktree list --porcelain`, and
create H00 from that SHA. Inventory the two detached worktrees and remove them
only if their owners confirm they are stale. The launch log must record each
worktree path, branch, base SHA, owner, and terminal cleanup.

### TS-14 — Medium — all lanes: terminal states do not fully constrain claim ownership

**Failure mode:** `discarded_with_reason` is a legal lane terminal state even
when it owns required open claims; `blocked_with_user_decision` is a legal claim
terminal state even though definition-of-done requires all verified. The prose
says blocked claims do not count, but the manifest does not encode the aggregate
predicate or reassignment requirement.

**Exact amendment:** Encode these rules mechanically:

- `ready_to_reconcile` is transitional only and never terminal;
- `discarded_with_reason` is legal only when all owned claims are reassigned,
  explicitly removed by an approved scope change, or already verified by an
  equivalent canonical implementation;
- `blocked_with_user_decision` makes program state `blocked`, never `complete`;
- `no_delta`/`equivalent` require a canonical proof result and verifier record;
- program `complete` requires every in-scope claim `verified`, no active
  worktree/lane, and no unconsumed artifact/evidence refresh.

Add contract fixtures for every invalid lane/claim combination.

### TS-15 — Medium — H00: phase-scoped oracle exit behavior is ambiguous

**Failure mode:** `claim-harness-oracle` expects `verify:harness` to exit zero
only when every in-scope claim is verified, while the first merge-batch command
is expected to show H00 verified and downstream claims open. Without an explicit
scope/exit contract, H00's own gate can be interpreted either as failing forever
until M3 or incorrectly treating open claims as out of scope.

**Exact amendment:** Define two machine modes: `--validate-plan` exits zero when
schema/commands/status transitions are valid while reporting open claims, and
`--require-complete` exits zero only when all in-scope claims are verified.
Define scope from an explicit milestone/claim set, never from which evidence
happens to exist. Use validate-plan after early merge batches and
require-complete only for final/release completion. Add a negative control where
a required claim is silently omitted from scope.

## Dependency and launch amendments

After absorbing the findings, the safe high-level topology is:

```text
planning commit + worktree truth reset
  -> H00 oracle/plan validator
  -> H01 static + H02 isolation (parallel, disjoint)
  -> H09A CI bootstrap
  -> H03 components + H05A WDIO probe (parallel)
  -> H04 browser E2E + selected H05B/H05C
  -> H06 native smoke + H07A media/baselines
  -> G07 budget decision -> H07B performance
  -> H08A package design decision -> H08B package implementation
  -> H09B CI expansion
  -> H08C protected signed release/updater proof
  -> H10 guidance and final canonical refresh
  -> three independent final verifiers -> require-complete
```

H08C and the final release job are PM-owned gates, not ordinary worker lanes.
Every new worktree is created from the post-dependency canonical SHA, and every
merge batch is proved on canonical main before the next edge opens.

## Counts and disposition

- Critical: 4
- High: 7
- Medium: 4
- Low: 0
- Total: 15

Execution is **not safe to start** until TS-01 through TS-04 are incorporated.
TS-05 through TS-11 should be absorbed before their affected lanes launch;
TS-12 through TS-15 belong in H00/control-plane mechanics before the first
parallel wave.
