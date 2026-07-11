# Coverage ledger

| Surface | Status | Evidence shard | Known misses |
|---|---|---|---|
| Vean current harness | Covered (31 findings) | `vean-current.jsonl` | No live packaged-clean-Mac run in this planning pass |
| Tauri/WDIO/macOS | Covered (28 findings) | `tauri-wdio.jsonl` | Vean-specific embedded-driver compatibility must be proven by the Wave-0 spike |
| React/Vite/Vitest | Covered | `react-remotion.jsonl` | Tool choice is planned; no dependencies installed in this pass |
| Remotion/media verification | Covered | `react-remotion.jsonl` | Exact WKWebView codec/device matrix remains runtime-dependent |
| CI/release/package proof | Covered | Multiple | Apple credentials and a self-contained Vean core artifact do not exist yet |
| Accessibility/performance | Covered | Multiple | Manual accessibility remains required beyond automated axe/Appium checks |
| Security/process lifecycle | Covered | Multiple | Loopback authentication design is a roadmap unit, not implemented here |
| Check-contract false positives | Covered/amended | `checkpoints/verifier-check-contract.md` | Implementation must prove fixed evidence corpus and sensitivity semantics |
| Topology/worktree/secrets | Covered/amended | `checkpoints/verifier-topology-security.md` | Runner/credential availability remains an execution-time external gate |
| Domain/source-of-truth overclaim | Covered/amended | `checkpoints/verifier-domain-truth.md` | Keyboard budgets and release authority still require named user decisions |

## Blind spots accepted by the roadmap

- Embedded WDIO v1.2 is official and green upstream, but only about two months
  old. The plan treats it as a gated spike, pins it exactly, and dispatches the
  executable H05F Mac2/self-test branch if localhost navigation cannot be
  instrumented safely.
- Appium Mac2 requires macOS Accessibility/XCTest setup and serialized execution;
  it is a narrow native-surface smoke tier, not the main E2E runner.
- Browser codec support is hardware/OS/runtime-dependent. Deterministic MLT and
  Remotion render goldens remain separate from real-time playback evidence.
- A signed/notarized clean-machine release cannot be proven until Vean packages
  its own Bun/core service rather than referring to the source checkout.
- Timeline keyboard/announcement semantics, performance thresholds, Apple and
  updater key custody, and manual accessibility assessment are explicit user/PM
  gates. They cannot be silently omitted or counted green.
