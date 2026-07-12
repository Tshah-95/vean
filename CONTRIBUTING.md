# Contributing to vean

Early days. The plan of record is [ROADMAP.md](ROADMAP.md); the architecture and
conventions are in [AGENTS.md](AGENTS.md).

## Contributor License Agreement (CLA) — required

vean is **AGPL-3.0**, but contributions are accepted under a **CLA** that grants
the project a license to your contribution broad enough to **relicense and
dual-license** (sell commercial exceptions). This is deliberate and load-bearing —
it is the monetization and optionality escape hatch explained in
[LICENSING.md](LICENSING.md). We cannot merge un-CLA'd external code without
foreclosing it.

**Status:** the project is solo today, so no CLA flow is wired up yet. Before the
repo accepts outside contributions, we will adopt a standard individual + entity
CLA (Apache-ICLA-derived) via a CLA-assistant bot, reviewed by counsel. Until
then, please open an issue to discuss before sending a PR.

## Dev setup

```sh
bun install
bun run test        # vitest — golden round-trips, op-inverse invariants, diagnostics
bun run typecheck   # tsc --noEmit
bun run lint        # biome
```

System deps (not bun packages): `mlt` (provides `melt`) and `ffmpeg`.

## Verification tiers

Use the narrow commands while iterating, then run the tier that owns the claim
you changed. A green browser run is not native-shell or package proof.

| Change class | Required verification |
|---|---|
| Core/CLI/LSP/state or ordinary repository code | `bun run test`, `bun run typecheck`, `bun run lint`, then `bun run verify:harness --profile developer --json` |
| React viewer, timeline interaction, or preview server | `bun run drive verify`, then the developer profile above. The H04 runner uses packaged headless Playwright/Chromium; it does not require `agent-browser`. |
| Tauri/WKWebView development integration | `bun run verify:tauri --provider auto` and `bun run verify:tauri-release-negative` |
| Native macOS menus, windows, focus, or file dialogs | `bun run vm:macos:status`, `bun run vm:macos:doctor-guest`, `bun run vm:macos:verify-native`, and `bun run vm:macos:collect-evidence` from the host, targeting the hidden Tart guest |

Never run native UI automation or computer-use against the active host desktop.
The VM harness owns the dedicated macOS GUI session and supplies the opt-in
environment to the guest. `/view` is only for an explicit human request to open
a foreground window; it is not automated test evidence.

H07–H10 package and release claims require their own evidence; the development
commands above do not satisfy them. Do not substitute `app:build`, an H04
screenshot, or development Mac2 evidence for an installed, signed/notarized,
updater, or manual-accessibility claim.

## Conventions (the short version)

- Work on `main`. Bun + TypeScript, ESM, `@/*` → `src/*`.
- Zod on the IR and every op input. Biome for format/lint. Vitest for pure units.
- **Frame-exact rational time** — fps is `[num, den]`, positions are integer
  frames. Never a float fps.
- **Determinism** — same IR → byte-identical XML; guard it with a golden test.
- **No coupling to any external/in-house brand or app.** vean is standalone.
- Anything that's a format contract (`.mlt` serialization, keyframe strings) ships
  with a golden test in the same change.
