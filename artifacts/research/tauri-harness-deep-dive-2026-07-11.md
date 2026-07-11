# Deep dive: the correct Tauri harness for Vean

Date: 2026-07-11  
Confidence: high on staying with Tauri/React/Remotion; medium-high on the exact
embedded-WDIO integration until the Wave-0 compatibility spike passes.

## Decision

Vean should stay on Tauri, React, and Remotion.

That is not a concession to sunk cost. It is the architecture that preserves
Vean's strongest solved subsystem: a browser-native live video pipeline using
WebCodecs, workers, WebGL2, Web Audio, and React-based Remotion compositions.
Replacing those pieces would create a new media engine without improving the
typed MLT core, edit algebra, diagnostics, or export fidelity.

The original concern—poor usability and testability—is real but belongs to the
harness, not the framework. Vean currently proves its headless core well and its
browser editor selectively, but does not continuously prove the React workspace,
actual WKWebView, native shell, process lifecycle, accessibility, or installed
package. All of those gaps have credible tools without abandoning Tauri.

## What changed after deeper verification

### The Tauri recommendation is correct, but WDIO is not a magic switch

Tauri now officially recommends `@wdio/tauri-service`. Its embedded provider
drives Tauri on macOS without an external WKWebView driver, and upstream runs it
on GitHub-hosted macOS ARM runners. It can launch the real binary, drive DOM,
capture logs, inspect windows, execute Tauri APIs, and mock invokes.

However:

- the service reached v1.0 only on 2026-05-03 and v1.2 on 2026-06-25;
- its embedded server is an unauthenticated localhost WebDriver endpoint capable
  of script evaluation;
- Vean navigates away from its bundled splash to a random localhost viewer, so
  the stock advanced-plugin recipe does not automatically survive navigation;
- WebDriver controls WebView content, not native AppKit menus or Finder dialogs;
- a debug/instrumented app passing WDIO is not proof that the production `.app`
  is self-contained, signed, or safe.

Therefore the first implementation step must be a compatibility/security spike,
not a broad test rewrite. The preferred result is embedded WebDriver with basic
DOM control and no elevated remote Tauri capability. If advanced WDIO features
are required, they must exist only behind a test Cargo feature and test Vite mode,
on an exact fixed loopback origin. A release negative control must prove that no
WDIO plugin, permission, listener, or port ships.

### Two drivers are required

1. **Embedded Tauri WebDriver** proves the actual Tauri process, WKWebView,
   localhost navigation, editor DOM, and shutdown behavior.
2. **WebdriverIO + Appium Mac2** proves a thin set of native macOS behavior via
   Apple's XCTest accessibility stack: menus, file panels, window close/quit,
   and native accessibility exposure.

Mac2 is intentionally narrow and serialized. It requires Accessibility/XCTest
setup and cannot replace DOM-level tests. Embedded WDIO cannot replace it either.

### Remotion needs two different readiness oracles

`delayRender()` controls server-side frame capture but is a no-op in Player and
Studio preview. Live Player buffering uses `useBufferState()` and Player events.
Consequently:

- production-frame goldens must use `renderStill()` in a pinned environment;
- live preview tests must separately assert buffering, waiting/resume, seeking,
  error isolation, and autoplay/user-gesture behavior in a real browser;
- a passing render golden does not prove Player interactivity, and a passing
  Player test does not prove exported pixels.

## Current Vean truth

### Strong assets to preserve

- 97 tracked root Vitest files cover the core, actions, CLI, diagnostics, state,
  and many pure viewer algorithms.
- Pure viewer logic is already separated enough to test layer resolution, audio
  placement, visibility, frame caching, clocks, keyframes, and composition
  selection without a browser.
- `scripts/drive.ts` is a strong agent/developer lifecycle primitive: free ports,
  health checks, per-worktree identity, spawn locking, PID journaling, and cleanup.
- Five live-browser scripts already test overlays, dynamic compositions, HMR,
  multiple overlays, and Remotion fault isolation.
- Cross-origin isolation and media-file allowlisting are already tested.
- Renderer-sidecar assembly already checks relocatability, code signatures, and a
  scrubbed-environment render.
- React/Remotion version parity is deliberately pinned between live preview and
  production rendering.

### Material gaps

- `viewer/` is excluded from root typecheck and lint and declares no test command.
- The standard `bun run test` covers only Vitest; browser, media, native, package,
  and release gates are unrelated opt-in scripts.
- No CI workflow runs any gate on push.
- Browser proof uses Chromium against the loopback server, not actual WKWebView.
- App doctor checks structure/build but never launches or drives the app.
- The 447-line Rust supervisor has no unit tests despite owning process, path,
  environment, menu, and navigation behavior.
- Native menus/dialogs and the accessibility tree are untested.
- `window.__veanPerf` exposes useful data but no budget is enforced.
- timeline clips are pointer-driven `div`s without a complete keyboard/semantic
  interaction model.
- browser screenshots/recordings are ephemeral rather than standardized CI
  evidence.
- tests can touch the real repo-local SQLite state; a full run exposed transient
  lock contention that passed in isolation.
- the `.app` is not self-contained: it still defaults to external `bun` and the
  source checkout even though MLT/FFmpeg sidecars are portable.
- no signing, notarization, updater, or installed-artifact workflow exists.
- the mutation API is unauthenticated loopback HTTP and Tauri sets CSP to null.
- Rust kills only the direct Bun child; process-group teardown and orphan checks
  are not proven.

## The target assurance stack

| Tier | What it proves | Primary tool | What it must not claim |
|---|---|---|---|
| 0. Static | All owned TS/TSX/Rust/config compiles and lints | `tsc`, Biome, Cargo fmt/clippy | Runtime behavior |
| 1. Pure logic | IR, ops, diagnostics, reducers, timeline math | Node Vitest | DOM/media/platform fidelity |
| 2. React components | Semantics, state, errors, keyboard contracts | Vitest Browser Mode + semantic queries | Tauri/Rust or codec support |
| 3. Browser editor | Real server, actions, WebCodecs/WebGL/WebAudio/workers | WDIO/Chrome plus existing `drive` proof | Exact WKWebView/native shell |
| 4. Tauri WKWebView | Real app launch, navigation, DOM, sidecar, shutdown | WDIO embedded provider | AppKit menus/dialogs or distributable package |
| 5. Native macOS | Menus, Finder panels, window/quit, accessibility | WDIO + Appium Mac2/XCTest | Detailed web DOM/media correctness |
| 6. Media/render | Player buffering and deterministic exported frames | Browser Player tests + Remotion `renderStill` + MLT/FFmpeg goldens | Cross-machine pixel identity |
| 7. Package/release | Clean-machine app, no source/Bun dependency, signatures, updater | packaged smoke + macOS tools | Development build correctness alone |

No tier substitutes for the next. The harness should make overclaiming difficult
by naming each command after the evidence it actually produces.

## Tooling principles

1. Keep Node Vitest for pure code. Do not move deterministic math into browser
   tests.
2. Do not use jsdom as proof of layout, canvas, WebGL, media, workers, or playback;
   it does not implement a visual browser.
3. Run React component tests in an actual browser and query by role, name, and
   label before using test IDs.
4. Keep `agent-browser` + `drive` as the agent-facing demonstration workflow. It
   is excellent for exploration, HMR, recordings, and human evidence; it is not
   the native-shell oracle.
5. Use actual WKWebView for the codec/lifecycle cases where Chrome is an invalid
   proxy. Playwright WebKit is useful cross-engine evidence but is not the OS
   WKWebView embedded by Tauri.
6. Treat visual goldens as pinned-environment evidence. Always combine pixels
   with semantic or domain assertions.
7. Use explicit waits on observable state; never use arbitrary sleeps as a
   correctness mechanism.
8. Fail on unhandled errors and unexpected frontend/backend error logs.
9. Give every test a unique temporary HOME, project, database, ports, and artifact
   directory. No automated test may use the developer's repo DB or user config.
10. Run desktop/native suites serially unless each app, port, state directory, and
    process tree is explicitly isolated.
11. Capture screenshots, DOM/accessibility snapshots, logs, process state, and
    rendered artifacts on failure.
12. Pin the young WDIO Tauri packages exactly and upgrade them only through a
    dedicated compatibility run.

## Recommended command surface

The implementation should converge on a small contract:

```text
bun run verify:fast       # static + pure logic
bun run verify:component  # real-browser React component tests
bun run verify:browser    # loopback editor/browser media suite
bun run verify:tauri      # actual Tauri + WKWebView embedded-driver suite
bun run verify:macos      # Appium Mac2 native surface smoke
bun run verify:media      # Player, renderStill, MLT/FFmpeg, perf budgets
bun run verify:package    # clean installed .app / process / signature proof
bun run verify:all        # orchestrated local/release aggregate
bun run verify:harness --json  # machine-readable completion oracle
```

Each command needs a deterministic fixture contract, timeout, teardown in a
`finally`/`always()` path, and a structured result. `verify:all` should orchestrate
commands; it should not hide duplicated ad hoc implementations.

## What Tejas should do next

Approve the PM roadmap beside this brief, then execute only Wave 0 first:

1. create the independent evaluator meta-contract, immutable evidence envelope,
   structured sensitivity controls, scenario ledgers, and aggregate profiles;
2. put that control plane under push-main CI immediately;
3. create the isolated fixture/runtime/security foundation and close
   viewer/macOS-Rust static gates;
4. spike embedded WDIO against Vean's real localhost navigation, with an
   executable Mac2/self-test fallback if the safe path fails;
5. prove the exact final release lineage contains none of the WDIO
   instrumentation.

If that spike fails, stay on Tauri anyway and use the existing browser harness
plus Appium/native smoke while the official integration matures. The framework
decision does not depend on one new plugin succeeding; the media architecture is
still the stronger reason to keep Tauri/React/Remotion.

## Coverage and remaining risk

The deep dive contains 85 normalized findings across Vean code, official Tauri
and WebdriverIO documentation/source, React/Vitest/Testing Library, browser
standards, and Remotion documentation. The evidence corpus and blind spots live
under `artifacts/research/tauri-harness-deep-dive-2026-07-11/`.

Three adversarial verifier passes then found and closed the main ways a harness
could lie: self-referential completion, no-op negative controls, stale/substituted
artifacts, browser UI diverging from canonical `.mlt`, unsupported matrix cells
shrinking away, post-hoc goldens/budgets, debug evidence standing in for an
installed DMG, independent release stages inspecting different binaries,
cryptographic-only updater proof, CI mapping without current execution, and
automated accessibility overclaiming manual VoiceOver truth.

The amended roadmap now has 16 launch/PM lanes, 26 downstream claims plus an
independent evaluator meta-contract, four explicit aggregate profiles, an
immutable source-to-release artifact lineage, and an executable H05F fallback.

The biggest remaining risk is operational, not architectural: embedded WDIO's
interaction with Vean's random localhost navigation must be proven on the exact
pinned versions. The roadmap makes that the first reversible branch, prevents it
from contaminating production builds, and no longer lets its failure dead-end the
rest of the assurance program.
