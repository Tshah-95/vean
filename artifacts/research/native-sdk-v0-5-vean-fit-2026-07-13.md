# Native SDK v0.5 and VEAN: fit assessment

Date: 2026-07-13  
Decision: **Do not migrate VEAN's main Mac app from Tauri to Native SDK. v0.5's TypeScript core does not change that decision.**  
Confidence: high on the present decision; medium on Native SDK's trajectory because the project is moving unusually quickly and remains pre-1.0.

## Executive answer

Native SDK v0.5 changes one important thing: a **Native-rendered** app can now put its pure model/update core in a constrained TypeScript subset and compile it to native code. That makes the SDK materially more approachable for small apps whose UI can be expressed in Native markup and the SDK's retained components.

It does **not** change the part that makes Native SDK a bad migration target for VEAN:

- VEAN's strongest product subsystem is a browser-native media editor: React, `@remotion/player`, mediabunny/WebCodecs workers, WebGL2, Web Audio, and `ImageBitmap`/`OffscreenCanvas` composition. Replacing that UI with Native markup would mean building a new video UI and media runtime, not translating a shell.
- Native SDK can preserve that subsystem by embedding it as a web frontend, but v0.5's TypeScript-core feature does not apply to web-frontends. The official scaffold still writes `src/main.zig`, `src/runner.zig`, `build.zig`, and `build.zig.zon` for those apps.
- Once VEAN keeps its web frontend and compiled-Bun/Node/Remotion sidecars, the headline benefits—no JavaScript engine, no GC, ~83 ns update dispatch, zero Zig—do not describe the resulting VEAN application.
- Native SDK still lacks proven parity for one of VEAN's most important shell jobs: robustly respawning a sidecar on an ephemeral loopback port and navigating WKWebView from the supervising thread. The open upstream issue is almost a verbatim description of VEAN's architecture.
- VEAN's newest harness has exposed a real WKWebView product-decoder blocker: HTML `<video>` decodes the fixtures, but the actual Mediabunny/WebCodecs worker path fails before producing its first H.264 `ImageBitmap`, and VP9 canvas alpha is opaque. Native's default macOS engine is the same WKWebView, so its system-WebView route inherits—not solves—that blocker.
- Native's bundled Chromium/CEF host is the one strategically interesting alternative because it changes the browser engine. But v0.5's CEF host explicitly lacks app menus, native views/control commands, and file drops, and VEAN's exact codec/alpha path is unproven in the prepared CEF build. It also adds a second packaged Chromium closure alongside the Chrome VEAN already retains for Remotion export.
- VEAN has already built a substantial Tauri-specific package, runtime-closure, WKWebView, lifecycle, security, and media evidence harness. That harness has been valuable precisely because it found the decoder failure. A shell migration would reset the rest of that assurance without removing the Bun, Node, Chrome, MLT, or FFmpeg closure that dominates VEAN's complexity.

So the precise verdict is:

> **Native SDK is technically workable as an experimental WebView shell for VEAN, but it is not yet a release-capable replacement. Native SDK v0.5 does not make a migration rational. Keep Tauri canonical; Native/CEF is worth at most a narrow browser-engine experiment and cannot become the product host until its missing native-menu surface is accepted or fixed.**

## Hypotheses tested

| Hypothesis | Result |
|---|---|
| v0.5 can compile VEAN's existing TypeScript/npm application to native code | Rejected: it compiles only the constrained pure app core; VEAN's React viewer and Bun/npm core remain WebView/sidecar code |
| A Native web shell preserves VEAN and receives the new zero-Zig TypeScript path | Half true: it preserves the web app, but web scaffolds still generate/own Zig and keep JavaScript runtimes |
| Native's system engine fixes VEAN's current WKWebView decoder blocker | Rejected: the system engine is WKWebView, the same engine that failed |
| Native's macOS CEF engine could fix the decoder blocker | Plausible but unproven: it changes the engine, but the prepared codec build has not run VEAN's matrix and the CEF host lacks required native features |
| Switching shells eliminates VEAN's heavyweight runtime/package complexity | Rejected: Bun, Node, Chrome/Remotion, MLT, FFmpeg, assets, provenance, and update concerns remain; CEF adds another Chromium closure |
| Staying on Tauri is merely sunk-cost conservatism | Rejected: Tauri already satisfies the required native-menu, dynamic navigation, process-lifecycle, and security seams; its WK media problem has a bounded browser-layer fallback design |

## What v0.5 actually shipped

The release claim is real but narrower than the social post makes it sound. Native SDK transpiles an application core—`Model`, `Msg`, and a pure synchronous `update` function—from TypeScript to Zig/native code. The SDK runtime and widgets remain Zig, and custom widgets, host services, and render passes still require Zig ([TypeScript core docs](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/docs/src/app/typescript/page.mdx#L3-L7)).

The accepted language is explicitly a closed subset, not normal ecosystem TypeScript. Among the exclusions are npm packages, regex, `JSON`, Promises, `eval`, inheritance, `async`/`await`, `Map`/`Set`, module-level mutable state, runtime type tests, and ordinary indexable strings; dynamic text is `Uint8Array` bytes. Model/frame heaps are fixed-size and default to 1 MiB each ([subset and heap contract](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/docs/src/app/typescript/page.mdx#L124-L132)). This is an interesting native application language with TypeScript syntax, not a way to compile VEAN's existing TypeScript/npm application to native code.

The SDK's own package guidance draws exactly that boundary: an existing npm-heavy editor belongs in a WebView; a Node library belongs in a sidecar; neither runs in the native TypeScript core ([Where Packages Go](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/docs/src/app/typescript/packages/page.mdx#L18-L37)).

### Audit of the screenshot's claims

| Claim | Accurate for | What it means for VEAN |
|---|---|---|
| “Compiles to native” | The constrained TypeScript model/update core in a Native-markup app | Not VEAN's React viewer, npm core, Remotion renderer, or sidecars |
| “No JS engine, no GC” | A fully Native-rendered app that stays inside the native core/runtime | False for any VEAN-preserving design: WKWebView runs JavaScript; the packaged core is Bun; Remotion retains Node and Chromium |
| “83 ns update dispatch” | A 10,000-iteration, keystroke-shaped core dispatch microbenchmark | Not a measure of decode, seek, canvas composition, WebGL, IPC, sidecar startup, rendering, or UI latency |
| “Real TS” | A sophisticated but closed, deterministic subset | It cannot consume VEAN's existing packages or normal async/browser/server application code |
| “No Zig required” | The default Native frontend with built-in markup/widgets and no custom host integration | Web frontend scaffolds still own Zig; custom host services/widgets also remain Zig |
| “Half turns/cost/LOC” | Apparently Native SDK TypeScript-core versus Zig-core agent evals | Not a comparison with Tauri or a VEAN migration; the repository excludes the result corpus, so the headline cannot be independently reproduced from the tagged source alone |

The ~83 ns number comes from a Darwin timer with roughly 41 ns granularity around 10,000 direct update calls in a small inbox-like core ([benchmark source](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/packages/core/test/fixtures/bench.zig#L128-L187)). It may be a valid regression metric for the transpiler, but VEAN's shell does not perform its expensive work in an Elm-style update dispatch. It is therefore decision-irrelevant.

The agent-authoring harness is thoughtfully designed, and its own documentation warns that one stochastic trial is weak evidence while one trial is the default ([eval methodology](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/evals/README.md#L61-L77)). More importantly, `evals/results/` is gitignored ([result policy](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/evals/.gitignore#L1-L4)). The tagged OSS source lets us audit the harness, prompts, graders, and metric code, but not the observations behind “half.” The cases compare TypeScript and Zig implementations inside Native SDK; they do not measure the cost of retaining or migrating a large React video editor.

### Present release maturity

A clean packed-consumer smoke test found that the flagship v0.5.0 TypeScript path is broken on first install. On macOS 26.3 arm64 with Node 26.3.0/npm 11.16.0, a fresh `npm install @native-sdk/cli@0.5.0`, `native init`, then `native check` reports that the nested `@native-sdk/core` transpiler dependency is missing. Running the CLI's advised nested `npm ci` repairs it, after which `native check` succeeds. The package declares the transpiler's TypeScript compiler only in the nested core package's development dependencies while build/check hard-code that nested install location ([CLI manifest](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/packages/native-sdk/package.json#L10-L39), [core manifest](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/packages/core/package.json#L24-L30), [check path](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/src/tooling/ts_core.zig#L102-L112)).

An exact fix exists in open [PR #123](https://github.com/vercel-labs/native/pull/123) but was neither merged into current `main` nor published at the time of this audit. This is probably short-lived and is not the architectural reason to reject Native for VEAN. It is, however, useful evidence that v0.5 shipped without a clean packed-consumer test for its headline path.

The project itself is exceptionally young: the repository was created in May 2026, the README calls the API pre-1.0 and moving, and contribution history is overwhelmingly concentrated in Chris Tate ([README status](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/README.md#L129-L135), [contributors](https://github.com/vercel-labs/native/graphs/contributors)). That does not diminish the quality or ambition of the work; it raises the cost of adopting it at VEAN's release and package boundary right now.

## VEAN's actual architecture

VEAN deliberately separates four things:

1. a headless typed editing/action core;
2. an MLT/FFmpeg renderer driven as external processes;
3. a browser-native interactive preview/editor;
4. a thin native macOS shell.

The repository contract says the product depends on MLT/FFmpeg and Remotion rather than reimplementing them (`AGENTS.md:24-47`). The Mac app is intentionally an adapter over the same action runtime used by CLI/MCP/LSP (`AGENTS.md:49-73`, `AGENTS.md:97-121`).

The current Tauri shell owns little domain logic. It:

- spawns `vean preview` on a fresh `127.0.0.1` port;
- waits for readiness and navigates the main WKWebView;
- restarts and kills the whole sidecar process group on project switch/exit;
- exposes native folder dialogs and menus;
- sends every domain mutation through one generic action bridge; and
- restricts navigation to the current exact loopback origin.

Those are visible in `app/src-tauri/src/lib.rs:1-19`, `:40-65`, `:364-478`, `:500-550`, `:695-727`, and `:778-818`.

The viewer is not a replaceable HTML settings panel. It pins React/Remotion parity and depends on `@remotion/player`, mediabunny, and Radix (`viewer/package.json:14-31`). Its implementation uses WebCodecs through mediabunny workers, WebGL2, Web Audio, `ImageBitmap`, `OffscreenCanvas`, and worker pools (`viewer/src/decode/decode-worker.ts`, `viewer/src/decode/parallelDecoder.ts`, `viewer/src/components/FootageStage.tsx`, `viewer/src/components/PreviewPane.tsx`). The prior Tauri decision correctly identified that rebuilding this layer would create a new media engine without improving VEAN's typed MLT core or export fidelity (`artifacts/research/tauri-harness-deep-dive-2026-07-11.md:7-21`).

The newest actual-WKWebView result also has to remain explicit. In the hidden macOS guest, `<video>` decoded H.264 and VP9, but VP9 canvas readback lost alpha. More decisively, the real bundled worker + Mediabunny + `CanvasSink({ alpha: true })` path failed its first H.264 input with `Decoder failure`, before creating an `ImageBitmap` (`artifacts/specs/wkwebview-media-decoder-blocker.md:7-24`). The current bounded Tauri-compatible design is a provider boundary: keep Mediabunny where it proves support and use synchronized H.264 color/matte `<video>` elements in WKWebView (`:32-65`). This is an open product implementation item, not a reason to pretend current Tauri/WKWebView media is already release-ready.

The installed product also intentionally contains more than a desktop shell. The Bun-compiled core packages the built viewer and migrations (`scripts/package-core.ts:99-139`), and the self-contained runtime contract retains pinned Node, Remotion, a browser, MLT, FFmpeg, and their support files (`artifacts/specs/self-contained-macos-package.md:23-46`). Replacing Tauri cannot make those engines disappear.

## The three possible Native SDK migrations

### 1. Rebuild VEAN as a Native-markup application

This is the path that receives v0.5's full benefits: TypeScript model/update authoring, no application-written Zig, no WebView JavaScript engine, deterministic record/replay, and fast update dispatch.

It is also the wrong product architecture. VEAN would lose or have to rebuild:

- the React workspace and component ecosystem;
- `@remotion/player` live overlay parity with export;
- the mediabunny/WebCodecs worker decoder;
- the WebGL2 live compositor;
- Web Audio timing/mixing;
- existing browser and WKWebView verification; and
- normal npm/async code in the application tier.

Native SDK's built-in canvas/widgets do not provide equivalents for that video pipeline. Custom rendering and host extensions return the app to Zig. This route solves a shell-language preference by replacing VEAN's most valuable working subsystem. **Fit: bad.**

### 2. Use Native SDK as another WKWebView shell

This is technically plausible. Native SDK treats existing React/Vite/Next frontends as first-class WebView content, and on macOS its system engine is WKWebView. It can supply native windows, menus, dialogs, a JavaScript bridge, packaged assets, and sidecar processes. Apache-2.0 is compatible with VEAN's use; licensing is not a blocker.

But this route does not get the screenshot's new advantage. The v0.5 scaffold says the TypeScript core option applies only to the Native frontend; web frontends “have no core tier to scaffold” and always generate the full Zig shell (`src/main.zig`, `src/runner.zig`, build files) ([template source](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/src/tooling/templates.zig#L56-L62), [branch that writes the Zig web shell](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/src/tooling/templates.zig#L86-L152)).

It also has an exact unresolved mismatch with VEAN. [Native SDK issue #15](https://github.com/vercel-labs/native/issues/15) asks for a thread-safe API to navigate/reload a WebView after a Node/Python sidecar respawns on a new ephemeral loopback port. The issue explains that the watcher thread cannot safely navigate the single-threaded AppKit runtime and that the current workaround is fragile. VEAN's Tauri shell already implements this lifecycle (`app/src-tauri/src/lib.rs:437-478`) and verifies exact-port navigation policy (`:695-775`).

More importantly, Native system mode uses WKWebView ([web-engine matrix](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/docs/src/app/web-engines/page.mdx#L1-L32)). It therefore preserves VEAN's measured decoder failure. Changing the host framework does not change the browser/media implementation that failed.

Native SDK can package and sign a macOS app, but its updater is currently only a reserved manifest shape: applications must implement update UI, verification, artifact application, and platform-specific install behavior themselves ([Native update docs](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/docs/src/app/updates/page.mdx#L1-L13)). By comparison, Tauri has a cross-platform signed updater with generated update artifacts and install flows ([official Tauri updater](https://v2.tauri.app/plugin/updater/)). Native's Windows packaging is still labeled early and mobile experimental ([packaging matrix](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/docs/src/app/packaging/page.mdx#L281-L310)); macOS is the strongest platform, but VEAN would still be taking on a younger host and re-proving its complete runtime closure.

**Fit: possible shell, no solution to the active media blocker, poor migration.** It changes Rust glue to Zig glue while retaining every heavyweight runtime and invalidating a large amount of working assurance.

### 3. Use Native SDK's bundled Chromium/CEF host

This is the only Native path that might improve an actual VEAN problem. Native ships a prepared, pinned CEF runtime on macOS and describes the engine as appropriate for complex frontends needing predictable Chromium behavior ([CEF docs](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/docs/src/app/web-engines/page.mdx#L46-L85), [engine tradeoffs](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/docs/src/app/web-engines/page.mdx#L139-L169)). If VEAN's exact Mediabunny/worker/alpha matrix passes there, CEF could avoid the WK-specific fallback provider.

But v0.5 does not make that a release-capable host. Its own platform matrix marks macOS Chromium app menus, native views, native control commands, and file drops unsupported ([desktop-host matrix](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/docs/src/app/platform-support/page.mdx#L110-L171), [file-drop row](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/docs/src/app/platform-support/page.mdx#L245-L258)). VEAN's actual Mac shell requires native File/Edit/App menus, and the Native source deliberately rejects menu configuration when the engine is not `system` (`src/platform/macos/root.zig:1705-1709`). The prepared CEF distribution's H.264/VP9-alpha codec behavior also must be measured; generic “Chromium” support is not proof that its codec build matches Chrome or VEAN's path.

CEF also makes the distribution larger and more complex. VEAN already packages Chrome Headless for deterministic Remotion output; CEF adds a separate framework and helper processes that must be signed, notarized, inventoried, and tested. Native's packaging docs explicitly require verifying and signing the embedded framework ([CEF bundling](https://github.com/vercel-labs/native/blob/e2627ee07f40b467fd954576d0bc67502be4251e/docs/src/app/web-engines/page.mdx#L118-L137)).

**Fit: worthwhile only as a bounded engine falsification test; not presently a shippable replacement.** The CEF capability—not TypeScript authoring—is the reason to keep this path on the radar.

## Decision matrix

| Requirement | Native UI + TS core | Native + WKWebView | Native + CEF | Current Tauri + WKWebView |
|---|---:|---:|---:|---:|
| Preserve React/Remotion editor | No | Yes | Yes | Yes |
| Preserve browser media architecture | No | Yes | Yes | Yes |
| Pass current product decoder | New implementation required | Inherits measured failure | Unknown; must measure | Measured failure; bounded fallback specified |
| Reuse VEAN's npm/Bun core | Only as a sidecar | Yes, as sidecar | Yes, as sidecar | Yes |
| “No JS engine / no GC” | Yes | No | No | No |
| No application Zig | Yes until custom host work | No | No | N/A; small existing Rust shell |
| Native app menus | Yes in native/system host | Yes | No in v0.5 | Yes |
| Ephemeral-port sidecar restart + navigation | Requires new/custom host work | Open upstream gap | Open upstream gap | Implemented |
| Exact runtime closure and lineage | Must be rebuilt/re-proved | Must be rebuilt/re-proved | Must be rebuilt and enlarged | H08 candidate machinery exists; signed H08R lineage remains open |
| Updater/distribution maturity | Weaker | Weaker | Weaker | Stronger Tauri upstream; VEAN's signed updater/H08R remains open |
| Net product capability gained | Little; large capability loss | None | Possible Chromium decoder compatibility | Baseline plus known WK fallback work |

## Recommendation

1. **Keep Tauri as VEAN's canonical Mac host and implement/verify the already-specified WK provider boundary.** This remains an architecture decision, not a sunk-cost defense: Tauri is the thin host around the browser/media stack VEAN actually needs, and the decoder problem has a bounded browser-layer design rather than demanding a product rewrite.
2. **Do not interpret v0.5 TypeScript as migration evidence.** It applies to the Native-rendered path VEAN should not take; the preserving web-frontend paths still own Zig.
3. **If evaluating Native further, make it one narrow Native/CEF falsification spike—not a migration.** Keep the compiled Bun service and React viewer byte-for-byte unchanged. Test the exact H07 fixture/product decoder, VP9 alpha, workers, `ImageBitmap`, WebGL2, Web Audio, COOP/COEP, Range media, dynamic loopback navigation, and clean teardown. Stop if the decoder/alpha matrix fails. A pass establishes only that CEF is technically interesting; it does not waive the missing native-menu, sidecar-reload, packaging, updater, or assurance gates.
4. **Do not use the 83 ns or agent-authoring claims as migration evidence.** A relevant comparison would measure VEAN startup, steady-state memory, preview seek/decode latency, dropped frames, sidecar recovery, package size, and clean-machine reliability using the same viewer and runtime closure.
5. **Treat Native v0.5's TypeScript-native mode as a candidate for a new, small, native-first utility—not as the VEAN editor host.** That is where the constrained TypeScript core and deterministic automation are genuinely aligned.

## Conditions that would justify reassessment

Revisit the shell decision only after all of the following are true:

- web-frontend shells can own their needed host logic without hand-maintained Zig, or Native provides a stable generated host extension mechanism;
- issue #15's thread-safe cross-platform WebView navigation/reload API is shipped and tested;
- Native's prepared CEF runtime passes VEAN's exact product media matrix, including H.264, VP9 alpha, workers, WebCodecs/mediabunny, `ImageBitmap`, WebGL2, Web Audio, Range requests, and `@remotion/player`;
- the CEF host supports VEAN's required native app menus and file-drop behavior, or VEAN explicitly changes those product requirements;
- exact-origin policy can follow a newly selected loopback port without widening to `*`;
- packaging, signing, notarization, updater behavior, and the full Bun/Node/Remotion/Chromium/MLT/FFmpeg closure reach VEAN's current clean-machine and lineage evidence level; and
- a VEAN-level benchmark demonstrates a material user-facing benefit that Tauri cannot deliver.

The gate is not “Native SDK reached a higher version.” It is “the preserved VEAN product is measurably better after paying the migration and assurance cost.” v0.5 does not meet that gate.

## Research method and caveats

This assessment inspected Native SDK's `v0.5.0` tag (`e2627ee07f40b467fd954576d0bc67502be4251e`), including the transpiler contract, templates, web engines/surfaces, sidecar guidance, packaging/signing/update docs, benchmark fixture, eval harness, issue tracker, and release change set. It separately traced VEAN's current shell, viewer, sidecar lifecycle, security policy, package closure, and verification artifacts at `origin/main` (`e4dca61`).

The largest uncertainty is CEF capability and trajectory: the exact VEAN media path has not yet been run through Native's prepared CEF distribution, and Native SDK is young, pre-1.0, and changing quickly. That argues for one bounded falsification test if the CEF alternative is seriously considered, not for migrating early. The conclusion is robust to fast improvement because v0.5's TypeScript feature does not apply to the web-frontend architecture VEAN needs.
