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

## Conventions (the short version)

- Work on `main`. Bun + TypeScript, ESM, `@/*` → `src/*`.
- Zod on the IR and every op input. Biome for format/lint. Vitest for pure units.
- **Frame-exact rational time** — fps is `[num, den]`, positions are integer
  frames. Never a float fps.
- **Determinism** — same IR → byte-identical XML; guard it with a golden test.
- **No coupling to any external/in-house brand or app.** vean is standalone.
- Anything that's a format contract (`.mlt` serialization, keyframe strings) ships
  with a golden test in the same change.
