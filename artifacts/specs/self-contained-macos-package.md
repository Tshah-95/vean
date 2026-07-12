# Self-contained Vean macOS package implementation spec

Status: PM-approved; implementation authorized after H07 verification  
Roadmap units: H08 unsigned candidate; H08R signed release  
Decision basis: package audit on `b416c8a5f26730a838a3e847aaab44e3e4772508`

## Outcome and phase boundary

H08 ships an arm64 Vean `.app`/DMG candidate that launches through
LaunchServices on a sealed consumer macOS 26 VM without externally installed
Bun or Node, Homebrew, Xcode, a Vean checkout, media shares, network access, or
pre-existing Vean state. The only Node is the manifest-bound copy inside the
candidate. It edits and renders a guest-local synthetic project using only
hashed package resources.

H08 is explicitly ad-hoc signed, not Developer ID signed, notarized, or
stapled. H08R is a separately implemented and
separately TDD-reviewed release phase: signing, notarization, quarantine and
Gatekeeper, updater behavior, package-bound H05/H06, installed WKWebView policy,
manual VoiceOver evidence, and legal approval for public distribution. H08
cannot claim any H08R property.

## Fixed architecture decisions

1. **Initial platform is arm64/macOS 26.** Every nested Mach-O must support that
   tuple. The false `minimumSystemVersion: 11.0` declaration is removed. A lower
   floor requires rebuilding and testing the entire closure, not editing metadata.
2. **The core is a compiled Bun executable.** The pinned H08 compiler is Bun
   1.3.14 with a manifest-recorded artifact hash. Bundled Bun plus source is not
   an acceptable terminal package.
3. **One generated runtime contract serves TypeScript and Rust.** A versioned
   `runtime-layout.json` schema defines immutable package, writable project, and
   development-checkout roots. Package mode is selected by a compile-time Rust
   feature and compiled-core constant recorded in `runtime-manifest.json`, never
   by an environment variable. Rust and core must agree or launch fails with
   `E_RUNTIME_MODE_MISMATCH` before a child/listener exists. Rust and TypeScript
   consume the same generated resource inventory.
4. **Remotion stays in the installed-product claim.** The package contains Node
   24.15.0, a pinned Remotion CLI/runtime, a pinned browser and helpers, and the
   built-in workspace. Production invokes exact absolute package paths—packaged
   Node + CLI JavaScript + entry + browser + `ffprobe`—not a `.bin` shebang,
   `/usr/bin/env`, PATH, a project executable, or a runtime download.
5. **Production discovery fails closed.** Packaged `melt`, `ffmpeg`, `ffprobe`,
   MLT data/modules/profiles, dylibs, Node/Remotion/browser resources, viewer,
   migrations, and skill/catalog data are mandatory. Development overrides are
   permitted only in development mode.
6. **Lineage is acyclic.** The embedded runtime manifest cannot hash its own app
   or DMG. H08 uses three canonical RFC 8785 JSON layers:
   - `runtime-manifest.json`, embedded, hashes staged runtime resources only;
   - `app-receipt.json`, external, hashes the completed `.app` tree and names the
     runtime-manifest hash;
   - `distribution-receipt.json`, external, hashes the completed DMG and names
     the app-receipt hash.
   Candidate ID is SHA-256 of canonical `distribution-receipt.json` with its
   `candidate_id` member omitted.
   The runtime inventory excludes `runtime-manifest.json` itself. The completed
   manifest is then hashed by `app-receipt.json`, whose app-tree hash also treats
   it as an ordinary file. Vectors prove that adding the manifest after resource
   hashing is stable and that changing a resource or completed manifest
   invalidates the correct parent.
7. **H07 is a hard lineage input.** The completion run must name a non-draft H07
   fixture-manifest hash, semantic-oracle version/hash, runtime-matrix hash, and
   approved expected-output set. Placeholder or different-parent H07 inputs fail.

## Release-mode environment policy

`src/runtime/environment.ts` owns the allowlist and emits the sanitized child
environment. In package mode, `VEAN_REPO`, `VEAN_BIN`, `VEAN_PREVIEW_MODE`, all
`VEAN_MELT*`, `VEAN_FFMPEG*`, `VEAN_FFPROBE*`, `VEAN_REMOTION*`, `DYLD_*`,
`MLT_*`, `NODE_OPTIONS`, browser/cache/download variables, proxy variables, and
package-manager/network variables are ignored or rejected. Renderer variables
are then populated only from verified package paths. `/opt/homebrew`,
`/usr/local`, a checkout, and user package-manager roots are forbidden in child
process environments and executable/data resolution.

`tests/runtime-environment.test.ts` enumerates this table. Each hostile override
points to a marker executable or directory; package-mode unit and integration
tests assert no marker executes and the emitted environment contains only the
expected package-derived values. Development-mode tests retain the documented
overrides.

## Ordered implementation and isolated proof

### 1. Freeze runtime layout and containment

Add:

- `src/runtime/layout-schema.ts`, `src/runtime/layout.ts`, and
  `src/runtime/environment.ts`;
- `app/src-tauri/src/runtime_layout.rs`, generated schema fixtures, and Rust
  package-mode tests;
- `artifacts/specs/packaged-runtime-contract.md`;
- `tests/runtime-layout.test.ts` and `tests/runtime-layout-ratchet.test.ts`.

Inventory every package-reachable `import.meta`, `CARGO_MANIFEST_DIR`, bare tool
resolver, CLI `open` path, preview/viewer path, migration path, skill/catalog
path, renderer path, and Remotion path. The ratchet fails on any unclassified
new resolver.

Containment uses component-wise `lstat`, rejects non-regular executable/data
targets, absolute or escaping symlinks, loops and dangling links, canonicalizes
the existing final target beneath the canonical immutable root, and revalidates
device/inode/mode/hash immediately before open/spawn. Runtime resources require
`st_nlink == 1` unless a fixed policy explicitly inventories an internal
hard-link group. Package ownership/modes are verified, and an opened descriptor
is held through identity verification and read/execute (or the verified app is
staged into a non-user-writable root). Tests require exact failure codes for
`..`, relative and absolute escapes, loop, dangling link, case variant, external
hard link, package-root replacement, and post-verification link swap. Package mode ignores all environment
attempts to switch mode or roots; the renderer resolver throws a stable error
rather than returning a bare name.

Isolated gate:

```sh
bunx vitest run tests/runtime-layout.test.ts tests/runtime-layout-ratchet.test.ts tests/runtime-environment.test.ts
cargo test --manifest-path app/src-tauri/Cargo.toml runtime_layout
```

### 2. Compile and execute the real core

Add `scripts/package-core.ts` and `tests/package-core-contract.test.ts`. Compile
the exact production entry and expose the stable package argv contract:
`vean-core preview --no-open --prod --runtime-layout <absolute-resource-path>`.
The manifest records source SHA, compiler path/version/hash, lockfile and all
input hashes, compile argv, platform, deployment target, modes, staged-resource
hash, and observed executable hash.

The test performs a real `bun build --compile`, deletes/renames its checkout,
and runs the result from a non-repository cwd with empty HOME and hostile/empty
PATH. It proves `--version`, clean state initialization/migrations, skill list,
and production preview retrieval of a hashed viewer asset. Each resource-class
mutation produces a stable attributed error.

Two clean builds use different absolute checkout/TMPDIR/HOME values. Canonical
manifests must be byte-identical. Executable hashes must match before Vean calls
the binary byte-reproducible; otherwise the manifest explicitly enumerates the
observed nondeterministic fields and candidate identity includes the observed
output hash without a reproducibility claim.

Isolated gate: `bunx vitest run tests/package-core-contract.test.ts`.

### 3. Package renderer, Remotion, and compliance closures

Extend `scripts/bundle-sidecars.ts`; add `scripts/package-remotion.ts`,
`scripts/package-compliance.ts`, `scripts/harness/required-closure-policy.ts`,
`tests/remotion-runtime-layout.test.ts`, and `tests/package-closure.test.ts`.

The closure records every relative path, content hash, mode, symlink target,
Mach-O architecture/deployment target, linked dylib/rpath, source/bottle/build
input and version, exact license hash, and corresponding-source/build-recipe
reference. The Mach-O scanner rejects wrong architecture/floor and proves the
Vean executable does not link MLT/FFmpeg libraries.

Every non-system `LC_LOAD_*`, `LC_RPATH`, nested helper/plugin, and executable
dependency must resolve with dyld token semantics from its final app location to
a manifest-listed package file. Only a hashed Apple system framework/library
allowlist is exempt. Absolute non-Apple paths and unresolved, ambiguous, or
escaping resolution fail. Controls cover absolute Homebrew loads, escaping
`@rpath`, missing transitive dylibs, duplicate resolution, and otherwise
unexercised browser-helper and MLT-module dependencies.

`required-closure-policy.json` is generated before mutation from lockfiles,
build outputs, tool manifests, and compliance inputs, then bound to the source
and H07 lineage. Candidate inventory must be a superset-exact match for the
applicable fixed policy. A coherent mutant may regenerate receipts but may not
regenerate this policy; changing its hash or using a mutant-generated policy
fails parent/policy identity.

Policy entries declare `startup-required`, `operation-lazy`, or
`distribution-only`. A missing startup resource fails the app's own runtime
preflight; an operation-lazy resource fails its named operation; distribution-
only/compliance resources fail external candidate preflight without a runtime-
dependency claim. Coherent mutants regenerate receipts but not the fixed policy.
The harness records the expected external policy rejection and then invokes the
applicable internal startup/operation oracle.

Remotion production argv is the exact packaged Node executable, exact CLI JS,
exact built-in or project entry, explicit packaged browser/cache path, packaged
`ffprobe`, and download/network-disabled flags. Process-exec evidence plus marker
binaries first on PATH prove that no fake node/remotion/ffprobe runs.

Custom workspaces implement `vean.remotion-workspace/1`: canonical manifest,
entry beneath canonical project root, exact supported Node/Remotion/React
versions, dependency-tree hash, no escaping links, lifecycle scripts, network
imports, or project-local executables. A valid vendored fixture exports offline.
Missing/mismatched/hostile fixtures return `E_REMOTION_WORKSPACE_UNSUPPORTED`,
create no process/socket/output, and do not break the next built-in export.

H08 verifies a mechanically complete candidate compliance payload (SPDX,
license text, corresponding source/build recipe/source-offer data and hashes)
but does not claim public-distribution legal approval.

Isolated gate:

```sh
bunx vitest run tests/remotion-runtime-layout.test.ts tests/package-closure.test.ts
```

### 4. Assemble app, DMG, manifests, receipts, and mutation harness

Update Tauri configuration and Rust launch logic. Add:

- `scripts/harness/package-manifest.ts`;
- `scripts/harness/package-lineage.ts`;
- `scripts/verify-package.ts`;
- `tests/package-lineage.test.ts`;
- `tests/package-preflight-mutation.test.ts`;
- `artifacts/specs/harness-scenarios/package.json`.

The Tauri builder consumes only the staged runtime tree. Final release-
instrumentation scanning runs on the candidate app with hostile WDIO variables.
All canonical JSON uses RFC 8785 serialization. App-tree hashing defines raw
UTF-8 byte ordering, rejects invalid UTF-8 plus NFC/NFD or case-fold collisions,
pins entry type/mode and normalized uid/gid, records symlink targets and fixed
internal hard-link groups, includes approved signing xattrs/resource forks, and
rejects unclassified xattrs, ACLs, devices, FIFOs, sockets, and transient Finder
files. Shared conformance vectors cover reordered traversal, normalization/case
collisions, xattr/resource fork, hard link, special file, and exclusions. The
independent verifier reimplements the algorithm against those vectors and does
not import producer hashing code.

H08 assembly order is fixed: assemble runtime; ad-hoc sign every nested code
identity inside-out; verify each nested identity and the app; compute external
app receipt; build DMG; compute external distribution receipt. Neither external
receipt is embedded in an artifact it hashes. Re-signing after the app receipt
or rebuilding the DMG after the distribution receipt must fail stale-artifact
verification.

`tests/package-lineage.test.ts` proves two serialization passes are identical
and rejects self-reference, wrong parent, stale app/DMG, path/content/mode/
symlink mutation, and different H07 lineage with stable codes. Verification
mounts the DMG read-only, requires exactly one `.app`, recomputes that app tree,
reads its embedded runtime manifest, and requires content-parent equality through
all three layers. Coherent mutants that place another valid app in the DMG or
substitute a valid embedded runtime tree fail content-parent mismatch.

Mutation testing has two distinct oracles:

1. **Integrity mutant:** alter each manifest entry without updating the manifest;
   preflight rejects the exact relative path and class.
2. **Coherent dependency mutant:** remove/substitute one resource, regenerate a
   coherent unsigned candidate/receipts, run the affected operation, and require
   an attributed missing-resource failure with no fallback.

The generated inventory covers core, every viewer chunk, migration,
skill/catalog file, executable, dylib, MLT module/profile/data file, Node,
Remotion, browser/helper, built-in composition, and compliance file. The
verifier is outside the mutant tree and hashes its own schema/policy.
Integrity mutants cover every entry; coherent dependency mutants cover every
startup-required and operation-lazy class; fixed-policy controls cover every
distribution-only class.

Canonical build facade:

```sh
bun run package:core
bun run package:sidecars
bun run package:remotion
bun run package:candidate
bun run verify:package --suite candidate-preflight --lineage <distribution-receipt>
bunx vitest run tests/package-lineage.test.ts tests/package-preflight-mutation.test.ts
```

`candidate-preflight` refuses completion evidence unless it names the currently
passing lineage-test and fixed mutation/closure policy hashes. Both commands and
their runner/evidence identities are mandatory in `scripts/ci/harness-policy.json`.

### 5. Build a distinct sealed consumer-VM harness

Add `scripts/vm/macos-package-vm.ts`, `config/vm/macos-package.json`,
`tests/macos-package-vm.test.ts`, `scripts/harness/package-fixture-extraction.ts`,
`tests/package-fixture-extraction.test.ts`,
`scripts/harness/build-package-ui-driver.ts`,
`scripts/harness/package-ui-driver.swift`,
`tests/package-ui-driver-contract.test.ts`, and
`scripts/harness/verify-clean-package-evidence.ts`.

The config requires an immutable digest for a non-Xcode arm64 macOS 26 base, a
unique VM/SSH/known-host identity, zero shares, and no clone/bootstrap command.
The harness creates an ephemeral clone/reset for every baseline and mutant. The
attestation records base digest, Tart config, VM UUID and hardware identity, OS
build, snapshot hash, mounts, users, pre-run filesystem/process/listener state,
and verifier identity. Dev-VM UUID/image/mount evidence or a reused dirty
consumer fails `E_NOT_CLEAN_CONSUMER`.

The UI driver is a separately compiled and hashed Swift verifier, copied beside
the DMG but never into it. It uses AXUIElement/CGEvent semantic accessibility,
never screen coordinates, product instrumentation, WebDriver, or Xcode at run
time. A sealed test-only TCC grant is part of the base-image attestation. The
driver binds bundle ID, PID, main window, control accessibility identifiers,
and final owned localhost preview URL. Wrong bundle/PID, standalone browser,
splash-only, coordinate-only, or producer-authored synthetic telemetry fails.
The build receipt records Swift compiler path/version/hash, SDK/deployment
target, argv, source hash, binary hash, ad-hoc signature, and designated
requirement. Protocol tests use a fixture AX app: every action requires the
expected semantic identifier and observed state transition; CGEvent-only input
cannot satisfy it. TCC is scoped to the exact verifier identity/hash, privileged
collectors are pre-attested, and Vean runs unprivileged.
`tests/macos-package-vm.test.ts` also proves the profile cannot resolve the dev
VM, repository/share commands, or dev evidence.

Fixture archives have a canonical manifest of allowed relative paths, modes,
sizes, hashes, and media semantics plus a fixed expansion cap. Extraction
rejects absolute/traversal/duplicate paths, escaping links, devices/FIFOs, and
oversized expansion. Tests cover every rejection.

Clean means: no shares; no `~/Github/vean*`; empty Vean app support/container/
preferences/cache/database; no externally installed Bun/Node/Brew binary or
canonical install root; no `/Applications/Xcode.app`, active CLT/Xcode developer
directory, or toolchain payload. Stock Apple developer command stubs and the
candidate-owned Node are explicitly allowed. Canonical path, ownership, package
provenance, execution, and open-file evidence are required—not only `command -v`.
The first run may create only allowlisted app-support
and project state; the reset second scenario proves clean init. A separate
relaunch without reset proves migrations are idempotent and project edits persist.

Offline evidence has two rotated, timestamped phases. In
`offline-boundary-sensitivity`, known DNS, IPv4, and IPv6 probes must be caught
by an enforced deny-all non-loopback firewall/no-route boundary. Collectors then
reset. In `product-offline-proof`, only the app-owned `127.0.0.1`/`::1` listener
and owned loopback flows are allowed, with zero non-loopback attempts or
successes. Missing/overlapping/forged phase boundaries fail.

Observed paths are classified by a hashed policy: candidate resource; fixture/
project or expected writable state; approved immutable Apple OS framework,
WebKit, font, locale, or system-library path. Any checkout, Homebrew, user
package-manager, unexpected binary/dylib/browser/data/media path fails. Process,
`lsof`, VM-region/image, filesystem-event, socket, and packet collectors are
named in the scenario and independently interpreted by
`verify-clean-package-evidence.ts`.

The exact product scenario is generated from the approved H07 fixture. It pins
initial timeline hash, expected playhead advancement, exact seek frame, action
ID/arguments, inverse, touched URI, semantic post-save XML projection, render
frames and H07 markers. The driver launches with `/usr/bin/open`, drives those
named controls, quits semantically, independently parses the disk after exit,
reopens to prove persistence, and proves zero residual process/listener.

Additional scenarios cover first launch without active project; spaces/Unicode/
shell metacharacters in the path; read-only project; stale active-project path;
clean DB and second-launch migration idempotence; corrupt DB non-destructive
failure; and no writes within `.app` or mounted DMG. Their exact oracles are:

- no active project: named welcome/project-picker state, no checkout fallback,
  preview child, or project creation;
- unusual path: the full workflow passes and the persisted URI exactly matches;
- read-only project: attributed `E_PROJECT_READ_ONLY` before mutation/render,
  byte-identical project and no output/child/listener;
- stale active path: `E_ACTIVE_PROJECT_STALE`, no creation/fallback, followed by
  successful explicit fixture selection;
- corrupt DB: stable `E_STATE_CORRUPT` recovery guidance, original bytes/hash
  preserved, no partial replacement or silent reset;
- second launch: same schema version and row counts, no duplicate migration,
  prior semantic edit and project choice preserved;
- app/DMG immutability: before/after canonical tree and approved xattrs equal.

`tests/package-consumer-scenario-contract.test.ts` requires every scenario to
declare setup, action, raw observable, oracle/reason, cleanup, and baseline
restoration.

Installation mounts the exact DMG, copies its sole app with the canonical system
copy tool to a clean allowlisted install root, unmounts before launch, and
recomputes the installed tree against `app-receipt.json`. `/usr/bin/open` receives
that absolute installed path. PID executable/bundle URL must equal it. Mounted-
volume execution, stale install, translocation, or copied-tree mismatch fails.

Canonical consumer gate:

```sh
bunx vitest run tests/macos-package-vm.test.ts tests/package-fixture-extraction.test.ts tests/package-ui-driver-contract.test.ts tests/package-consumer-scenario-contract.test.ts
bun run vm:package:create -- --profile config/vm/macos-package.json
bun run vm:package:verify -- --lineage <distribution-receipt> --fixture <fixture-manifest>
bun run verify:package --suite clean-consumer --evidence <archive>
```

The VM verification envelope binds the exact VM-profile, fixture-extractor,
driver-contract, and consumer-scenario policy hashes from that test gate. The
test and VM commands are separately mapped in `scripts/ci/harness-policy.json`.

The host resolves a non-artifact verification input set from the distribution
receipt: DMG, app receipt, fixed closure policy, referenced H07 manifests and
policies, fixture archive/manifest, scenario/policy, and verifier/driver receipts.
It verifies every hash before transfer; the guest independently verifies every
hash before mounting. Nothing is fetched implicitly. Omitting or substituting
each external input fails `E_LINEAGE_PARENT_MISSING` or
`E_LINEAGE_PARENT_HASH` before the DMG is mounted.

The mode-0600 archive is bound to candidate ID, fixture/H07 lineage, VM/base
identity, driver/policy/scenario hashes, and producer command results. A
versioned evidence manifest enumerates every required raw file/hash. The guest
hashes the archive, host transport re-hashes it, extraction uses the safe archive
policy, and verification checks permissions, completeness, and absence of
credentials/private keys/tokens. Missing evidence, driver/TCC substitution,
in-transit mutation, loose permissions, or a seeded secret fails a stable code.

### 6. H08R release implementation (separate approval gate)

Before H08R implementation, create and TDD-review
`artifacts/specs/signed-macos-release.md`. It must decompose and name exact tests
and commands for:

- synchronized nonzero versions and updater public configuration;
- enumeration and verification of every nested signable identity, Team ID,
  hardened runtime, timestamp, entitlements, and designated requirement;
- notarization, stapling, deliberate quarantine attachment before first launch,
  `spctl`, installed smoke, and post-sign lineage;
- a local authenticated updater fixture with exact vN/vN+1/vN-1 artifacts,
  archive/metadata/signature tampering, same-version/replay/downgrade policy,
  interruption before/mid download, after verify, during atomic replace, and
  before relaunch; every outcome leaves a complete old or new app, never a mix;
- explicit rollback semantics (or removal of the rollback claim), user/project
  preservation hashes, and baseline restoration after every mutant;
- final-hash-bound H05/H06, installed WKWebView policy, manual keyboard/
  VoiceOver evidence schema, and a package-bound manual legal approval artifact.

Minimum named tests are `tests/version-sync.test.ts`,
`tests/release-lineage.test.ts`, and `tests/updater-policy.test.ts`; minimum facade
is `bun run verify:release --suite signing|quarantine|updater|package-bound-native`.

## Adversarial-control protocol

Every negative follows the same contract:

1. canonical baseline passes;
2. exactly one named mutation is applied;
3. the canonical verifier exits nonzero with a stable `SENSITIVITY_*` or `E_*`
   reason and exact affected identity/path;
4. independent evidence proves it failed for that intended reason;
5. the mutation is restored;
6. the same canonical baseline passes again.

No test may satisfy a dependency control merely by causing an unrelated manifest
hash failure.

## Check Contract

### H08 build-host gates

- [ ] The step 1–4 isolated commands pass in a clean checkout and emit hashed
  reports under `.vean/package-evidence/<candidate-id>/build/`.
- [ ] `candidate-preflight` reports one exact, acyclic
  source→runtime-manifest→app-receipt→distribution-receipt candidate lineage.
- [ ] Integrity mutants cover every manifest entry; coherent dependency mutants
  cover every startup/operation class; fixed-policy mutants cover every
  distribution-only class; all pass the adversarial-control protocol.
- [ ] Two-path core builds make only claims justified by observed byte equality;
  checkout deletion, hostile cwd/HOME/PATH/environment controls pass.
- [ ] Compliance manifest-to-file/hash/license/source-recipe coverage and Mach-O
  architecture/floor/linkage scans pass; public legal approval is not claimed.
- [ ] Every fixed-policy signable identity passes per-file `codesign --verify
  --strict`; the app passes `codesign --verify --deep --strict`; receipts bind
  CDHashes/designated requirements and prove `Signature=adhoc`, no Developer ID
  authority chain, no TeamIdentifier/timestamp, and no notarization ticket.

### H08 clean-consumer gates

- [ ] `tests/macos-package-vm.test.ts` passes, and the sealed attestation proves
  exact base/instance/reset provenance, no dev VM, checkout, runtimes, tools,
  shares, personal media, or prior Vean state.
- [ ] Fixture extraction controls pass; LaunchServices opens the installed app
  and approved synthetic project through the independently hashed semantic driver.
- [ ] The pinned play/scrub/seek/edit/save/quit/reparse/reopen workflow, still and
  video render, built-in Remotion export, and positive vendored-custom Remotion
  export pass under enforced offline conditions.
- [ ] Every UI action is proven by independent on-disk/semantic/output truth;
  superficial, wrong-process, splash-only, coordinate-only, and synthetic-
  telemetry controls fail.
- [ ] Path, process, listener, filesystem, socket, packet, and network evidence
  satisfies the hashed allowlists; all egress/Homebrew/checkout/unexpected-path/
  leaked-child/listener mutants fail; semantic Quit leaves zero residuals.
- [ ] First-launch, relaunch/idempotence/persistence, unusual-path, read-only,
  stale-project, corrupt-DB, and no-app/DMG-write scenarios pass.
- [ ] Candidate evidence records exact ad-hoc identity via `codesign -dv
  --verbose=4`, designated requirement/CDHash, absent Team ID/authorities/timestamp,
  and quarantine/notarization state;
  the H08 schema rejects Gatekeeper/notary/updater/manual-accessibility claims.

### Independent domain-truth gates

- [ ] `scripts/harness/package-domain-truth.ts` and
  `tests/package-domain-truth.test.ts` back `bun run verify:package-domain-truth
  -- --evidence <archive>`; it consumes raw
  manifests/process/filesystem/output evidence, hashes its scenario/policy code,
  and independently asserts runtime/resource and product-operation claims.
- [ ] `scripts/harness/package-lineage-domain-truth.ts` and its test back
  `bun run verify:package-lineage-domain-truth -- --lineage
  <distribution-receipt>` independently recomputes canonical receipts, candidate
  ID, all file/tree hashes, parent links, and H07 input identity.
- [ ] `scripts/harness/clean-machine-domain-truth.ts` and its test back
  `bun run verify:clean-machine-domain-truth -- --evidence <archive>`;
  independently asserts sealed-image provenance, pre-state, offline boundary,
  allowed paths/network, created state, and zero residuals; it never trusts a
  producer `ok` boolean.
- [ ] Domain-verifier tests delete/change raw evidence while leaving producer
  `ok:true` and require rejection; import ratchets prove they do not import
  producer oracle modules.
- [ ] Root, viewer, Rust, H07, package-build, and consumer commands are mapped to
  exact claim IDs/runner/evidence requirements in the canonical
  `scripts/ci/harness-policy.json`; `tests/harness-ci-mapping.test.ts` and
  `.github/workflows/harness.yml` invoke only mapped facades, with build-host and
  consumer-runner requirements distinct.

## Definition of done

H08 is done only when one exact ad-hoc-signed candidate passes all named
build-host, clean-consumer, negative-control, and independent-domain gates with
the approved H07 lineage. A dev VM, scrubbed host, source-tree build, successful
`tauri build`, producer-authored `ok`, or signature check alone is never proof.

H08R is not approved by this document. It requires its own clean TDD-reviewed
spec and exact signed/notarized/stapled/updater/manual evidence.

## TDD verification

Round 1 (2026-07-12): 27 raw findings consolidated into the amendments above.
Round 2 (2026-07-12): 17 targeted findings absorbed. Rounds 3 and 4 closed the
remaining composition ambiguities. Round 4: CLEAN, zero findings across all 18
Check Contract items (four total passes).
