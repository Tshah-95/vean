# Domain/source-of-truth verifier

Date: 2026-07-11  
Lens: document truth, browser/WKWebView media truth, live/export parity,
accessibility, package/release truth, and current tool capability boundaries  
Disposition: amendments required before roadmap approval

## Result

- High: 9
- Medium: 6
- Low: 0

The roadmap gets the overall layer model right. Its main remaining failure mode
is not a missing tool; it is a predicate that can turn green while observing a
derived UI, a test-instrumented binary, or a comparator rather than Vean's
canonical document and exact distributed artifact.

## Findings

### VDT-01 — High — Browser editor can pass while the canonical `.mlt` is wrong

**Affected unit/claim:** H04; `claim-browser-editor`; secondarily H03 component
action mocks.

**Overclaim path:** H04 says to assert “DOM plus timeline/action/diagnostic
truth,” but neither the unit nor manifest names the authoritative value for each
flow. Vean's own invariant is that MLT XML is the placement source of truth,
typed IR is its deterministic model, `.vean/vean.db` is coordination only, and
UI mutations must route through the action registry. A test can click a control,
see the expected derived DOM, and pass even if the action used the wrong ID,
touched the wrong URI, failed to persist the `.mlt`, or wrote placement only to
viewer state/database. Screenshots and DOM text cannot close that gap.

**Exact amendment:** Add a canonical H04 scenario ledger. Every mutating
scenario must declare `actionId`, validated input, expected action envelope,
expected `touchedUris`, pre/post `.mlt` hash, parsed-IR domain predicate, expected
diagnostic set, and whether coordination DB state may change. Have
`verify:browser` read the `.mlt` independently through the production parser
after the UI action and compare the result to the action output; do not consume
viewer stores as the oracle. Add two negative controls: (1) update the visible
timeline without executing/persisting the action, which must fail document
truth, and (2) persist the expected edit to a different timeline URI, which must
fail touched-URI/current-document truth. Extend `claim-browser-editor`'s
predicate to require this ledger, not merely “all canonical scenarios.”

### VDT-02 — High — Timeline keyboard completion is possible before the product contract exists

**Affected unit/claim:** H03; `claim-react-components`;
`claim-dom-accessibility`.

**Overclaim path:** Current evidence says clips and ruler are pointer-only and
the roadmap correctly lists timeline keyboard semantics as a user escalation.
Nevertheless, both claims are allowed to become `verified` with generic
“state/keyboard” and “zero keyboard failures” predicates. An implementer can
encode whichever shortcuts are easiest, or cover only transport buttons, and
declare the timeline accessible.

**Exact amendment:** Before H03 implementation, create a canonical timeline
interaction contract approved by Tejas (focus model, clip/ruler roles and names,
selection, range extension, move/trim/blade commands, modifier semantics,
focus restoration, announcements, undo/redo, and pointer parity). Reference its
version/hash from the unit and truth manifest. Until approved, mark the two
timeline-dependent claim cells `blocked_with_user_decision`; they may not be
silently scoped out. The negative control must complete one representative edit
keyboard-only and then verify the canonical `.mlt`/IR outcome, not merely focus
or DOM state.

### VDT-03 — High — “Live media passes” lacks a codec- and output-level oracle

**Affected unit/claim:** H07; `claim-live-media`.

**Overclaim path:** `required runtime matrix reports verified, not mocked` does
not define the matrix or what “playback” proves. `isConfigSupported()`, a playing
flag, Player time advancement, or an `AudioContext` state can all pass without
proving decoded video content, correct timestamps, non-silent audio signal,
seek landing, or expected fallback. WebCodecs support is explicitly
codec/config/device dependent; audible speaker output is outside browser
automation. A blanket claim that codec capability “passes in Chrome and
WKWebView” also misclassifies an explicitly expected unsupported cell as a
failure or invites a mocked pass.

**Exact amendment:** Version a representative media manifest containing exact
bytes/hashes, containers, codecs/profiles, dimensions, time bases, alpha/audio
expectations, and per-runtime expected `supported`, `unsupported`, or
`fallback` outcomes. For supported cells, require actual decode of the fixture,
timestamp/seek assertions, nonblank frame evidence or a stable content
signature, and non-silent analyser/offline sample evidence where audio is in
scope. For unsupported cells, require the intended user-visible fallback and no
crash. Record OS, WebKit/browser, hardware-acceleration choice, and exact app
binary hash. Rename the claim to “declared live-media matrix behaves as
specified on tested runtimes”; explicitly state it does not prove physical
speaker output or untested devices. Negative controls must include a corrupt
chunk, unsupported profile, wrong seek timestamp, and silent/wrong-channel
audio—not only a stalled buffer.

### VDT-04 — High — Live/export separation is present, but live/export parity is unclaimed and untested

**Affected unit/claim:** H07; `claim-live-media`;
`claim-render-fidelity`; roadmap definition of done.

**Overclaim path:** The roadmap properly prevents a Player test from
substituting for `renderStill()`/MLT, but no oracle proves that the same Vean
document, composition selection, input props, frame mapping, asset resolution,
and React/Remotion version produce semantically corresponding live and exported
content. Both independent sections can pass against different fixtures or an
off-by-one mapping. Exact cross-engine pixel identity would also be an invalid
replacement because WKWebView and Chromium rasterization differ.

**Exact amendment:** Add `claim-live-export-semantic-parity` to H07. For one
versioned end-to-end corpus, record the canonical `.mlt` hash, IR frame/time,
composition ID, input props hash, asset hashes, React/Remotion resolved versions,
and render frame. At curated boundary frames, compare semantic content markers,
geometry/time mapping, and stable image regions or perceptual features between
Player capture and `renderStill`; separately compare the final MLT/FFmpeg output
where the overlay is composited. Do not demand full-frame byte identity across
engines. Negative controls: offset live frame mapping by one frame, change one
prop only in export, and resolve one asset differently; each must fail parity
while the individual live and render suites may remain green.

### VDT-05 — Medium — Golden success can be circular and the negative control tests only the comparator

**Affected unit/claim:** H07; `claim-render-fidelity`.

**Overclaim path:** “Approved goldens” has no provenance/update authority.
Generating a golden from current broken output and approving it makes the claim
green. `corrupt-golden` proves that byte comparison runs; it does not prove that
a realistic visible production change exceeds the selected thresholds or that
frame selection and fixtures are correct.

**Exact amendment:** Add a golden manifest with source SHA, fixture/document and
asset hashes, composition/MLT command, frame number, renderer/browser/tool
versions, environment image, expected semantic annotations, threshold rationale,
and human approval record. Golden updates must emit old/new/diff and cannot occur
in ordinary verification. Add defect-seeding controls in the render source:
visible transform/color change, omitted layer/audio stream, and one-frame
boundary shift. Require each intended region/stream oracle to fail. Keep
`corrupt-golden` only as a comparator-integrity test.

### VDT-06 — High — Scrubbed environment on the build host is not clean-machine/download truth

**Affected unit/claim:** H08; `claim-self-contained-package`; roadmap phrases
“downloaded-equivalent” and “clean-machine.”

**Overclaim path:** Changing `PATH`/`HOME` while running a locally built `.app`
does not exclude absolute source paths, mounted checkout access, dyld resolution
from build-machine locations, existing caches, extended-attribute differences,
or Gatekeeper quarantine. It can pass without installing the DMG or exercising
the artifact users download.

**Exact amendment:** Make the package oracle consume the exact hashed
distribution artifact in a clean macOS VM/ephemeral host or a separately
provisioned clean user with no repository mount, Bun, Homebrew, Vean caches, or
developer state. Apply/preserve quarantine, mount the DMG, drag/install to
`/Applications`, launch via LaunchServices, and run project open, live
play/scrub, still/video render, quit, and descendant cleanup. Capture filesystem
and network access evidence so a source-tree fallback fails loudly. Rename a
same-host scrubbed run to `package-preflight`; it cannot satisfy
`claim-self-contained-package`. The remove-core negative control must run on the
same installed artifact path, and add one injected absolute source dependency.

### VDT-07 — High — Release, instrumentation, package, and updater claims can inspect different binaries

**Affected unit/claim:** H05/H08/H09; `claim-test-instrumentation-absent`;
`claim-self-contained-package`; `claim-signed-release`; `claim-updater`.

**Overclaim path:** The manifest names commands but does not require an
artifact-identity chain between production Vite assets, packaged core, sidecars,
Tauri executable, `.app`, DMG, notarized/stapled artifact, updater payload, and
the artifact each smoke actually launched. The release-negative command could
inspect one release binary while signing and package smoke certify another.
Static feature/permission checks and “no open port” also miss dormant WebDriver
code compiled into the shipped binary.

**Exact amendment:** H08 must emit one immutable release bill of materials with
SHA-256 for every input and nested executable/resource, resolved dependency and
feature trees, bundle/app/DMG/updater hashes, signing identities/entitlements,
notary submission ID, and source SHA. Every package/release oracle must accept
this manifest and refuse any other path/hash. `claim-test-instrumentation-absent`
must run against the exact final signed/stapled app and combine Cargo feature and
dependency inspection, capability/config inspection, binary symbol/string
inspection for both WDIO plugins/routes, an environment-triggered runtime port
probe, and a failed session-creation attempt. Recheck the hash after every
mutation/sign/notary step; evidence from an instrumented debug binary can never
be attached to a release claim.

### VDT-08 — High — Updater proof is cryptographic-only while roadmap prose implies a working updater

**Affected unit/claim:** H08; `claim-updater`; M3/definition of done.

**Overclaim path:** “Authentic update accepted and tamper rejected” can be
satisfied by a signature verifier test without proving feed selection, current
version comparison, download, platform/architecture choice, atomic installation,
relaunch, state preservation, failed-update recovery, or that the old installed
app trusts the configured key. The roadmap and release conclusion call this an
updater path, which is broader.

**Exact amendment:** Either rename/scope the claim to “updater signature
verification” or implement an end-to-end release oracle: install signed vN from
the exact DMG, serve signed metadata and vN+1 from a controlled HTTPS endpoint,
check/download/apply, relaunch, verify executable/version hash changed and
project state remained valid, then test no-update, downgrade rejection,
wrong-platform metadata, interrupted install/rollback, tampered metadata, and
tampered payload. Record the public-key fingerprint from the vN binary and
require explicit user approval/key custody before this claim can leave
`blocked_with_user_decision`.

### VDT-09 — High — CSP/navigation security is diagnosed but has no roadmap unit or truth claim

**Affected unit/claim:** H02/H05/H08; no current truth-manifest claim.

**Overclaim path:** The deep dive identifies `csp: null`, and the evidence shard
requires production CSP and unexpected-network negative controls. The units
close loopback mutation authority and test-only WDIO authority, but none owns or
verifies the shipped viewer's CSP, navigation, resource origin, WebSocket/dev
server separation, or injected-script/eval policy. The program could report all
21 claims verified while shipping the known production browser hardening gap.

**Exact amendment:** Add a unit-owned `claim-production-webview-policy` before
H05/H08 completion. Define separate dev/test/release CSP and navigation policy
for the local viewer and Tauri window, including exact connect/media/worker/font
sources and the test-only exceptions. Verify response headers plus effective
policy in final WKWebView and the installed package. Negative controls must
attempt unexpected external navigation/resource load, inline script/eval,
cross-origin mutation, bad Host/Origin/token, and reuse of a token after
restart. Release truth must reject `csp: null` unless a narrower, documented
mechanism provides equivalent enforced policy.

### VDT-10 — High — Automated accessibility claims do not absorb the acknowledged manual/VoiceOver requirement

**Affected unit/claim:** H03/H06/H08/H09; `claim-dom-accessibility`;
`claim-native-macos-shell`; coverage ledger and definition of done.

**Overclaim path:** DOM axe/semantic tests and Mac2 accessibility locators can
prove machine-detectable names, roles, states, focus, and selected keyboard
flows. They cannot prove VoiceOver announcements, rotor behavior, timeline
comprehension, focus recovery across WebView/native dialogs, contrast in all
states, or usability. The coverage ledger explicitly says manual accessibility
remains required, but the truth manifest has no required manual artifact and
`claim-native-macos-shell` broadly says “shell accessibility pass.” Thus the
program can claim accessibility completion without the acknowledged evidence.

**Exact amendment:** Narrow automated claim wording to machine-detectable
contracts. Add a release-gated manual accessibility claim/checklist tied to the
exact package hash: keyboard-only core workflow, VoiceOver navigation and
announcements across AppKit/WKWebView boundaries, dialog return focus, timeline
edit comprehension, zoom/reflow, reduced motion, contrast, and media controls.
Store assessor/date/OS/VoiceOver version, findings, and evidence; this claim may
be manual but must still be current and cannot be inferred from axe or Mac2.
Seed separate DOM label and keyboard/focus defects for automation; manual proof
must explicitly exercise an announcement/focus behavior automation does not
claim.

### VDT-11 — Medium — Performance claim can measure a debug test harness rather than shipped behavior

**Affected unit/claim:** H07; `claim-performance-budget`.

**Overclaim path:** H07 owns `viewer/src/test-bridge/` and depends on the
test-instrumented WKWebView app. WebDriver, debug Rust/React builds, test bridges,
logging, screenshots, and tracing can materially alter scrub/play/edit latency
and memory. A pinned host improves repeatability but does not make the result
representative of the shipped package, nor does one ARM host establish general
user performance.

**Exact amendment:** Scope the claim to named hardware/OS/runtime and split
`performance.browser-ci` from `performance.release-package`. Measure the latter
using production assets and optimized final-package code with only bounded
telemetry; record and budget instrumentation overhead. The driver may initiate
and collect but must not continuously trace/screenshoot the measured window.
Define fixture, warmup, power/thermal state, sample count, percentile estimator,
outlier policy, cache state, resolution, and absolute plus regression budgets.
Add an injected long task/cache leak control in both Chrome and release
WKWebView. Report untested hardware as unknown, not globally “meets budget.”

### VDT-12 — Medium — Browser resource reclamation is not directly observable or deterministic

**Affected unit/claim:** H07; `claim-media-resilience`.

**Overclaim path:** The proposed `leak-frame-resource` control assumes omitting
`VideoFrame.close()` will reliably exceed a measurable bound. The WebCodecs spec
says resources may be reclaimed and hardware limits vary; browser GPU memory
return is not a stable cross-runtime assertion. The test can fail to detect the
defect or flake, then overclaim actual GPU resource reclamation.

**Exact amendment:** Split the oracle into deterministic application ownership
and runtime stress. Wrap production resource acquisition/close paths with
test-observable outstanding-handle counters that cannot alter ownership; assert
all frames, data, bitmaps, decoders, workers, and contexts close after seek,
project switch, error, and teardown. Separately run a long actual-runtime stress
with queue, process memory, frame latency, and crash bounds on pinned systems.
Rename the claim to “application releases owned media handles and remains bounded
under the tested stress,” not “browser resources return.” The deterministic
negative removes one close call and must fail the handle ledger even if the UA
reclaims memory.

### VDT-13 — Medium — `actual_engine=WKWebView` may be self-asserted rather than externally proven

**Affected unit/claim:** H05; `claim-tauri-wkwebview`.

**Overclaim path:** The expected predicate accepts an `actual_engine` field but
does not define its source. A test bridge or user-agent-derived string can claim
WKWebView while the driver is attached to the splash, a standalone browser, or a
stale binary. The existing splash-only negative helps only navigation timing.

**Exact amendment:** Require evidence assembled outside page-controlled state:
absolute binary path/hash/build profile, Tauri app PID/bundle ID, window/session
handle, driver provider and session capabilities, macOS/WebKit version, and the
final random localhost URL after navigation. Then execute a nonce-bearing action
through that exact window and independently verify the canonical action/document
result. Refuse stale binary hashes before session creation. Keep the splash-only
control and add a standalone-browser substitution control that must fail Tauri
lifecycle/native-process predicates.

### VDT-14 — Medium — CI lane assignment can pass without current execution evidence

**Affected unit/claim:** H09; `claim-ci-enforcement`; H00 freshness policy.

**Overclaim path:** The predicate requires every claim to have a “current
assigned CI/manual lane,” but assignment is configuration, not execution.
Manual/release/package/accessibility tiers can remain mapped yet never run
against the release hash. “Required automated lanes are green” is also undefined
for scheduled/manual claims and can reuse an unrelated source SHA.

**Exact amendment:** Separate `claim-ci-mapping` from
`claim-release-evidence-current`. Mapping verifies trigger, runner, secrets, and
command coverage. Release readiness requires a successful run ID for every
release-required tier whose source SHA and release-artifact manifest hash match
the candidate, with explicit maximum age only for environment/tool doctor
checks—not product results. A skipped, cancelled, neutral, unavailable runner,
or manually waived job is not verified. Negative controls: correct mapping with
no run, green run for previous SHA, and green package run for a different DMG
hash; all must block release completion.

### VDT-15 — Medium — Native Mac2 smoke on a test app does not prove the packaged shell

**Affected unit/claim:** H06/H08; `claim-native-macos-shell`;
`claim-self-contained-package`.

**Overclaim path:** H06 depends on the H05 instrumented app and may drive native
menus/dialogs only there. H08's package flow lists project/media operations but
does not explicitly rerun native menu/dialog/window/accessibility smoke on the
exact installed release candidate. Bundle identifiers, entitlements,
LaunchServices, sandbox/path behavior, menu projection, and dialogs can differ
after packaging/signing.

**Exact amendment:** Keep H06 as fast native-shell development evidence, but add
a bounded Mac2/LaunchServices package smoke consuming the exact H08 artifact
manifest after installation: app/menu identity, Open Project panel cancel and
select, window close/reopen or activation, quit, native labels/roles, and return
focus into the WKWebView. Record bundle/app hash and native driver session.
Break or rename a packaged-only menu resource/entitlement as the negative
control; the H05 debug suite may remain green while the package claim must fail.

## Approval gate

The roadmap should not be approved until VDT-01 through VDT-10 are absorbed into
the unit registry and truth manifest. VDT-11 through VDT-15 may be absorbed in
the same edit; none requires new product scope, except the already-recognized
timeline keyboard decision, performance thresholds after baseline collection,
and release/updater key authority.

The most important structural amendment is to make every integration result
carry two identities:

1. the canonical domain input/output identity (`.mlt`, parsed IR, action ID,
   touched URIs, assets and frame/time); and
2. the exact executable/package identity (source SHA, binary/app/DMG/updater
   hashes, runtime/OS versions).

Without both, the harness can be internally green and still certify the wrong
document or the wrong product artifact.
