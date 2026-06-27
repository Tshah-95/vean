# Move 3 design: actions, routing, and media ergonomics

Move 3 turns the Move-2 bridge into a product runtime that can scale without
surface drift. The pattern is deliberately close to the strongest local
harnesses in the Carlo repos: a small resolver routes work, a typed manifest
describes capabilities, doctor commands prove readiness, and local state is a
cache/coordination layer rather than a second source of truth.

## Pattern

1. **One action registry, many adapters.** Define product behavior once in
   `src/actions/registry.ts`: input schema, output schema, scopes, effect
   metadata, surface hints, and handler. Commander CLI, MCP, LSP code actions,
   and the Tauri app consume that registry. Adapters may add presentation, but
   not domain behavior.
2. **CLI is the canonical command surface.** Every public action is reachable by
   `vean action run <id> --input-json ...`; frequent actions also get ergonomic
   Commander commands. Human output is readable by default, `--json` is stable
   for agents and tests.
3. **MCP is generated from registry metadata.** MCP exposes domain actions for
   hosts that benefit from tool calls. It is not the permission source, not the
   diagnostics stream, and not where action semantics live.
4. **LSP stays ambient and narrow.** LSP owns diagnostics, navigation, hover, and
   deterministic code actions. It should not become a project-management or
   media-catalog transport.
5. **The app calls the same actions.** Tauri invokes action ids through local
   IPC. UI state can be rich, but every mutating button/menu is backed by a
   registered action or deliberately view-only.
6. **Local state is useful, gitignored, and rebuildable.** `.vean/vean.db` stores
   project metadata, media catalog caches, route aliases, jobs, setup choices,
   and future UI/session metadata. It does not store canonical timeline
   placement, assets, secrets, or rendered deliverables.

## Project and route model

Agents should not pass long absolute paths after the project is selected.

- Project resolution order: explicit option, env override, nearest `.vean`, then
  user active-project pointer.
- Project-local data lives in `.vean/vean.db`.
- Cross-shell active-project pointers live in user config only as locators.
- Route aliases make resources addressable: `media:raw`, `media:proxy`,
  `timeline:main`, `renders:review`, `stills:latest`, `transcripts:source`.
- Every path-bearing action reports resolved paths and touched URIs.

The initial implemented route slice is intentionally slim:

- `media.root.add/list/remove`
- `media.scan`
- `media.list`
- `media.find`
- `route.set/list/resolve`

It catalogs extension-derived kind, path, relative path, size, and mtime. That is
enough for first-party routing and agent discovery without deciding the product
shape of transcription, labels, proxy generation, or inference.

## Media work: first party now vs later

First-party now:

- media roots with roles and lightweight policy JSON;
- route aliases for project resources;
- recursive scans with a conservative limit;
- path/kind/size/mtime catalog rows;
- structured list/find over CLI and MCP;
- JSON outputs usable by agents and tests.

Defer until the product decision is clearer:

- speech transcription;
- semantic labels and embeddings;
- face/object/scene inference;
- proxy generation policies;
- waveform analysis;
- filesystem watching;
- content hashing/fingerprinting for dedupe;
- user-facing import/copy/link defaults beyond policy metadata.

Those future jobs should enter through the same registry, store state in
`.vean/vean.db`, and use short job-lease transactions. The local media harness
can continue doing high-inference work outside vean until we decide which pieces
belong in the OSS core, the Mac app, or user-configured plugins.

## Verification contract

- `bun run doctor` proves repo and agent-facing setup.
- `bun run app:doctor` proves app scaffold metadata.
- `bun run app:doctor -- --native` proves the native Tauri `.app` build on a
  machine with Rust/Cargo.
- `bun run doctor --surface mcp-lsp` proves generated MCP registration starts
  and the LSP/MCP surfaces are reachable.
- CLI media tests must exercise a fresh `.vean` DB, add a root, scan files,
  list/find assets, and resolve the generated route.

## Anti-patterns

- Do not add a CLI command that bypasses `executeAction`.
- Do not add an MCP tool by hand when registry metadata can project it.
- Do not make LSP poll-style health checks replace pushed diagnostics.
- Do not turn `.vean/vean.db` into canonical edit state.
- Do not let the app grow a second action runtime.
- Do not add inference-heavy media behavior as first-party until install,
  privacy, model availability, and job semantics are settled.
