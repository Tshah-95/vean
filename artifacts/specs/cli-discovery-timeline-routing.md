# Spec: CLI discovery, op catalog, and timeline routing

Date: 2026-06-28
Research: `artifacts/research/agent-cli-discovery-aliases-2026-06-28.md`

## Goal

Make vean's CLI and agent surfaces self-describing enough that a human or agent
can select a project, find the active timeline, discover valid edit operations,
understand argument shapes, preview/apply an operation, and interpret the result
without reading TypeScript source.

This spec covers the next build slice. It does not add new media inference,
timeline visualization, or UI product decisions.

## Product Decision

vean will use one canonical identity for every action and edit operation.
Aliases are searchable metadata and optional CLI conveniences, never separate
action ids, registry keys, MCP tools, undo identities, or policy identities.

`--help` remains the human CLI baseline. Structured discovery is the agent
baseline:

- `vean discover --json`
- `vean discover <query> --json`
- `vean action describe <id> --json`
- `vean timeline ops list --json`
- `vean timeline ops describe <op-or-alias> --json`
- `vean timeline ops examples <op-or-alias> --json`

## Non-goals

- Do not expose duplicate MCP tools for aliases.
- Do not add a second command parser; Commander remains the CLI framework.
- Do not store canonical edit placement in `.vean/vean.db`.
- Do not add a timeline table unless route aliases prove insufficient during
  implementation.
- Do not add transcription, labels, embeddings, proxy generation, waveform
  analysis, or filesystem watching.

## Current Gaps

- `timeline.applyOp` and `timeline.previewOp` accept opaque `op: string` and
  `args: record`, so action/MCP descriptors do not teach valid operations.
- There is no operation discovery command.
- `action describe` does not expose schema summaries, examples, or aliases.
- `trimOut` documentation is wrong: positive `delta` shortens the tail in the
  implementation and tests, but the comment says it extends the tail.
- Active project exists, route aliases exist, and `.mlt` media detection exists,
  but active timeline selection is not first-class yet.
- Existing timeline commands require an explicit URI even when a project has
  `timeline:main`.

## Design

### 1. Operation Catalog

Add `src/ops/catalog.ts`.

It exports:

```ts
export type OpCategory =
  | "placement"
  | "trim"
  | "transition"
  | "audio"
  | "filter"
  | "track";

export interface OpExample {
  name: string;
  prompt: string;
  args: unknown;
  notes?: string;
}

export interface OpDescriptor {
  op: OpName;
  title: string;
  category: OpCategory;
  summary: string;
  description: string;
  aliases: string[];
  input: z.ZodTypeAny;
  inputSummary: SchemaSummary;
  examples: OpExample[];
  consequences: string[];
  inverse: string;
  hazards: string[];
}
```

`OpDescriptor.input` must reference the same schema object used by `REGISTRY`.
No duplicate hand-authored schema can drift from execution.

Every current public `OP_NAMES` entry gets a descriptor. Internal inverse ops
whose names start with `_` remain executable only through undo/inverse paths and
must never appear in `timeline ops` discovery/search/MCP metadata.

| Op | Category | Required descriptor notes | Aliases |
|---|---|---|---|
| `append` | placement | place a clip at the end of a track | `[]` |
| `split` | trim | cut one clip at a timeline frame | `[]` |
| `insert` | placement | insert a clip at a position, splitting/rippling as needed | `[]` |
| `overwrite` | placement | place a clip over an existing range, replacing covered material | `[]` |
| `lift` | placement | delete a clip but preserve timing with a same-length blank | `delete-gap`, `remove-no-ripple` |
| `remove` | placement | ripple-delete a clip and close the gap; `rippleAllTracks` controls cross-track ripple | `ripple-delete`, `delete-ripple` |
| `replace` | placement | swap the producer at an existing slot while keeping played length | `[]` |
| `trimIn` | trim | positive `delta` trims the head later; negative extends earlier when valid | `trim-in` |
| `trimOut` | trim | positive `delta` shortens the tail; negative extends later when valid | `trim-out` |
| `move` | placement | relocate a clip to a track/position, with optional ripple behavior | `[]` |
| `dissolve` | transition | create a same-track crossfade/transition between adjacent clips | `crossfade` |
| `fadeIn` | transition | set or remove a clip fade-in length | `[]` |
| `fadeOut` | transition | set or remove a clip fade-out length | `[]` |
| `gain` | audio | set audio gain in dB, converting to the IR multiplier internally | `volume`, `set-gain` |
| `addFilter` | filter | attach an ordered filter to a clip producer | `[]` |
| `removeFilter` | filter | detach a filter by index | `[]` |
| `addTrack` | track | add a video or audio track | `[]` |
| `removeTrack` | track | remove a track and capture inverse state | `[]` |

Aliases:

- `lift`: `delete-gap`, `remove-no-ripple`
- `remove`: `ripple-delete`, `delete-ripple`
- `trimIn`: `trim-in`
- `trimOut`: `trim-out`
- `dissolve`: `crossfade`
- `gain`: `volume`, `set-gain`

Do not add bare `delete` initially. It is ambiguous between lift, ripple delete,
and future media/file deletion.

Add helpers:

```ts
listOpDescriptors(): OpDescriptor[]
describeOp(nameOrAlias: string): {
  descriptor: OpDescriptor;
  canonicalOp: OpName;
  resolvedFrom?: string;
}
resolveOpName(nameOrAlias: string): { canonicalOp: OpName; resolvedFrom?: string }
searchOps(query: string): OpSearchResult[]
```

Alias resolution is case-sensitive for canonical internal names and accepts
lowercase/kebab-case aliases. Duplicate aliases fail at module-load/test time.
Unknown op lookup returns typed suggestions from deterministic catalog search.

### 2. Schema Summaries

Add `src/actions/schema-summary.ts`.

The goal is not full JSON Schema parity yet. It is a stable, compact,
machine-readable summary that can be used in CLI JSON and docs:

```ts
export interface SchemaSummary {
  type: string;
  required?: string[];
  properties?: Record<string, SchemaSummary>;
  enum?: string[];
  default?: unknown;
  description?: string;
  items?: SchemaSummary;
  union?: SchemaSummary[];
  optional?: boolean;
}
```

It must cover the Zod shapes currently used by action and op inputs:

- objects
- strings
- numbers
- booleans
- enums/literals
- records
- arrays
- unions/discriminated unions
- defaults
- optionals
- unknown
- strict objects
- effects/refinements

If a Zod construct is unsupported, the summary may return
`{ type: "unknown", description: "unsupported zod kind: ..." }`, but the tests
must assert no public action/op input summary currently degrades unexpectedly.
`z.unknown()` may summarize as `unknown` only where the declared schema is
genuinely unknown, such as `z.record(z.string(), z.unknown())`.

Later JSON Schema export can build on this, but is not required for this slice.

### 3. Enriched Action Descriptors

Extend `describeAction` in `src/actions/registry.ts` to include:

- `inputSummary`
- `outputSummary`
- `examples`
- `aliases`
- existing singular `effect`
- `surfaces`
- `mcpAnnotations`

Add optional metadata to `ActionDefinition`:

```ts
aliases?: string[];
examples?: Array<{ name: string; input: unknown; prompt?: string }>;
```

For `timeline.applyOp` and `timeline.previewOp`, the action descriptor should
include an `opCatalog` summary or `relatedDiscovery` pointer that tells agents to
call `timeline.ops.list` / `timeline.ops.describe`. Do not attempt to make one
giant union schema for every operation inside `applyOp` in this slice; it would
inflate MCP context and fight the one-action-many-ops escape hatch.

### 4. Discovery Actions

Add actions in `src/actions/registry.ts`:

- `discover.manifest`
- `discover.search`
- `timeline.ops.list`
- `timeline.ops.describe`
- `timeline.ops.examples`
- `timeline.current`
- `timeline.use`
- `timeline.list`

All are action-backed so CLI and MCP can project them from the same runtime.

`discover.manifest` output:

```ts
{
  project: ResolvedProject | null;
  activeTimeline: ResolvedTimeline | null;
  commands: CommandDescriptor[];
  actions: ActionDescriptor[];
  opFamilies: Array<{ category: OpCategory; ops: string[] }>;
  routes: Array<{ namespace: string; examples: string[] }>;
  next: string[];
}
```

`discover.search` input:

```ts
{
  query: string;
  kind?: "all" | "command" | "action" | "op" | "route";
  limit?: number;
}
```

Search is deterministic local matching over ids, titles, aliases, descriptions,
examples, and route namespaces. It is not an LLM classifier. For every direct
golden prompt in tests, the top result must be exactly one canonical target.

Search result shape:

```ts
{
  kind: "command" | "action" | "op" | "route";
  canonicalId?: string;
  canonicalOp?: OpName;
  title: string;
  aliases: string[];
  command?: string;
  actionId?: string;
  describeCommand?: string;
  rank: number;
  score: number;
  reason: string;
}
```

Search boundaries:

- default `limit` is `10`; maximum `limit` is `50`;
- `limit: 0`, negative limits, non-integer limits, over-max limits, invalid
  `kind`, and empty/whitespace query return typed validation failures;
- ties sort by `kind`, then canonical id/op, then title for deterministic output;
- ambiguous prompts such as `delete` return a disambiguation/candidates result
  rather than silently choosing a mutating op.

### 5. Active Timeline Routing

Use route aliases for this build rather than adding a `timelines` table.

Rules:

- `timeline:main` is the durable project-local active timeline pointer.
- `timeline.use <path-or-alias>` resolves a path, `file://` URI, or route alias,
  verifies it points to an existing `.mlt`/`.MLT` file, stores/updates route alias
  `timeline:main`, and returns `{ canonicalRoute: "timeline:main", uri,
  resolvedPath, project, outsideProject }`.
- Relative paths resolve against the resolved project root, not the process cwd.
- Absolute paths and `file://` URIs are accepted.
- Outside-project `.mlt` files are accepted for this slice but must return
  `outsideProject: true`; the app can later decide whether to warn or import.
- `timeline.current --json` with no `timeline:main` exits 0 and returns
  `{ activeTimeline: null, next: [...] }`.
- Omitted-URI timeline commands with no active timeline exit nonzero with a typed
  JSON failure and setup suggestions.
- Stale/deleted `timeline:main` returns a typed `stale-route` failure for commands
  that need a usable file.
- `timeline.list` lists cataloged media assets with `kind: "timeline"` plus any
  route aliases under `timeline:*`.
- `timeline.list` is stable-sorted by resolved path, de-duplicates a cataloged
  `.mlt` that also has `timeline:main`, and includes `source: "catalog" |
  "route" | "both"` plus route alias metadata.
- Path-bearing timeline actions accept route aliases anywhere they accept `uri`.
- `timeline apply-op`, `preview-op`, `undo`, `diagnose`, `resolve-value-at-frame`,
  and `find-references` can omit `<uri>` and fall back to `timeline:main`.
- Route alias resolution for timeline commands allows one alias-to-alias
  indirection. A filesystem target is depth 0. `timeline:main -> timeline:review
  -> /x.mlt` is depth 1 and allowed. A second alias-to-alias indirection or any
  cycle fails with a typed `route-chain` failure. Route aliases that resolve to
  directories, missing files, broken symlinks, or non-MLT files are rejected for
  `timeline.use` and omitted-URI timeline execution.

CLI behavior:

- If `uri` is omitted and no `timeline:main` exists, return a typed failure with
  suggested commands: `vean timeline list --json`, `vean timeline use <path>`.
- JSON output always includes `uri`, `resolvedPath`, and `project`.
- Human output prints the active timeline path and route name without dumping
  full action envelopes unless `--json` is requested.

Implementation should reuse `src/project/context.ts` and route helpers in
`src/state/media.ts`/`src/state/routes` rather than inventing a separate project
state model.

### 6. CLI Command Tree

Add top-level discovery:

```text
vean discover [query]
  --kind <all|command|action|op|route>
  --limit <n>
  --json
```

Add timeline op discovery:

```text
vean timeline ops list
  --category <placement|trim|transition|audio|filter|track>
  --json

vean timeline ops describe <op-or-alias>
  --json

vean timeline ops examples <op-or-alias>
  --json
```

Add active timeline commands:

```text
vean timeline list --json
vean timeline use <path-or-alias> --json
vean timeline current --json
```

Update existing timeline commands:

```text
vean timeline apply-op <op-or-uri> [op-or-alias] --timeline <uri-or-route> --args-json <json> --json
vean timeline preview-op <op-or-uri> [op-or-alias] --timeline <uri-or-route> --args-json <json> --json
vean timeline undo [uri] --timeline <uri-or-route> --inverse-json <json> --json
vean timeline diagnose [uri] --timeline <uri-or-route> --json
vean timeline resolve-value-at-frame <frame-or-uri> [frame] --timeline <uri-or-route> --target-json <json> --json
vean timeline find-references [uri] --timeline <uri-or-route> --query-json <json> --json
```

Commander positional disambiguation is part of the contract:

- `apply-op` and `preview-op` use a shared post-Commander disambiguation helper:
  with one positional, treat it as `op-or-alias` and resolve the timeline from
  `--timeline` or active `timeline:main`; with two positionals, treat them as
  `<uri> <op-or-alias>`.
- `vean timeline apply-op <op-or-alias> --timeline <uri-or-route>` is the
  preferred explicit form.
- `vean timeline apply-op <op-or-alias>` uses active `timeline:main`.
- old `vean timeline apply-op <uri> <op-or-alias>` remains compatible.
- `resolve-value-at-frame <frame>` treats the single positional as the frame only
  when an active timeline exists or `--timeline` is provided.

The same forms apply to `preview-op` where relevant. Final command help must make
the active-timeline default and `--timeline` option explicit.

### 7. Alias Resolution at Execution Edges

Before dispatching `timeline.applyOp` and `timeline.previewOp`, normalize public
op names through `resolveOpName`. `timeline.undo` accepts canonical internal
inverse op names such as `_unlift` and `_setGain` exactly, normalizes public
aliases only if they are present, and never exposes internal ops through
discovery.

Outputs include:

```ts
{
  invocation: {
    op: "dissolve",
    resolvedFrom: "crossfade"
  }
}
```

Consequences and inverse operations always use canonical op names. Inverses never
return aliases.

Unknown op errors should include:

- received op string
- nearest canonical/alias suggestions from deterministic search
- command to describe available ops
- `ok: false`, typed `kind`, `detail`, and suggestions in every `--json` CLI
  failure introduced by this spec; human stderr can stay concise.
- no file write on failed unknown-op apply/preview.

### 8. MCP Projection

MCP remains generated from the action registry.

Add MCP tools only because the new actions are registered:

- `discover-manifest`
- `discover-search`
- `timeline-ops-list`
- `timeline-ops-describe`
- `timeline-ops-examples`
- `timeline-current`
- `timeline-use`
- `timeline-list`

Do not add duplicate tools like `crossfade`, `ripple-delete`, `delete-gap`, or
`trim-out`.

Tool descriptors should use:

- canonical `name`
- human `title`
- "Use this when..." description style
- compact input schemas
- aliases in metadata if the current MCP helper supports it, otherwise in
  descriptions/results
- read-only/destructive/open-world hints projected from native effect metadata

Projection must be tested against actual MCP registration, not only the pure
mutation tool core.

### 9. Documentation and Skills

Update:

- `README.md` quick reference with `vean discover`, `timeline ops`, and active
  timeline commands.
- `AGENTS.md` quick reference and resolver rows.
- `.agents/skills/editing/SKILL.md` so agents start by using `vean discover` or
  `vean timeline ops describe` when they do not know an op.
- `.agents/skills/setup/SKILL.md` only if setup verification should assert the
  new discovery commands.

Docs must say: aliases are accepted for CLI/search convenience, but canonical ids
are the durable identity.

## Implementation Steps

1. Fix the `trimOut` comment in `src/ops/types.ts`.
2. Add `src/actions/schema-summary.ts` and tests over representative Zod shapes.
3. Add `src/ops/catalog.ts`; wire descriptors to existing `REGISTRY` schemas.
4. Add unit tests proving every `OP_NAMES` entry has exactly one descriptor,
   descriptor input is the same object as `REGISTRY[op].args`, aliases are unique,
   and examples validate.
5. Add op alias normalization to `src/ops/index.ts` or a small adapter imported
   by action handlers.
6. Enrich `ActionDefinition` and `describeAction`.
7. Add discovery and timeline actions.
8. Wire Commander commands in `src/cli.ts`, keeping all commands action-backed.
9. Update MCP tests to prove generated tools include discovery actions and do not
   include alias tools.
10. Update docs and skills.
11. Run the full verification contract.

## Check Contract

### Unit

- `tests/schema-summary.test.ts`: representative Zod strings, numbers, booleans,
  enums, literals, records, arrays, unions/discriminated unions, optionals,
  defaults around optional fields, strict objects, effects/refinements, objects,
  `z.record(z.string(), z.unknown())`, and unknown values produce stable
  summaries. No public action/op input summary degrades to unsupported
  `unknown`; declared `z.unknown()` remains allowed.
- `tests/ops-catalog.test.ts`: every `OP_NAMES` op has one descriptor; no
  descriptor exists for a non-public/internal `_` op; all aliases are unique;
  every descriptor input schema is referentially equal to `REGISTRY[op].args`;
  every example parses against the op input schema.
- `tests/ops-catalog.test.ts`: `trimOut` descriptor and source comment agree that
  positive `delta` shortens the tail; `gain` docs state `db` is decibels.
- `tests/ops-catalog.test.ts`: `_` internal inverse ops are not searchable or
  describable through catalog helpers, while undo can still accept canonical
  internal inverse invocations.
- `tests/actions-registry.test.ts`: `describeAction` keeps backward-compatible
  fields and adds `inputSummary`, `outputSummary`, `examples`, and `aliases`
  while preserving singular `effect`.
- `tests/actions-registry.test.ts`: descriptor enrichment is asserted for exact
  representatives: `state.status` (read), `media.root.add` or `project.use`
  (write), `timeline.previewOp` (preview), `render.still` (render), and
  `discover.manifest` (discovery). `timeline.applyOp` and `timeline.previewOp`
  include `relatedDiscovery: ["timeline.ops.list", "timeline.ops.describe"]` or
  equivalent.
- `tests/actions-registry.test.ts`: every registered action with a CLI surface has
  a canonical command path; no action id aliases are registered.
- `tests/actions-registry.test.ts`: every non-hidden `surfaces.cli.command`
  appears in `discover.manifest.commands`.

### CLI Workflow

- `tests/cli-discover.test.ts`: `vean discover --json` returns active project,
  active timeline null-or-object, actions, commands, op families, route examples,
  and next commands.
- `tests/cli-discover.test.ts`: direct golden prompts map to one top result:
  `crossfade clips` -> op `dissolve`; `delete but leave a gap` -> op `lift`;
  `ripple delete` -> op `remove`; `duck audio` -> op `gain`; `trim tail shorter`
  -> op `trimOut`.
- `tests/cli-discover.test.ts`: each search result has `kind`, canonical id/op,
  title, aliases, command/action path or describe command, rank, score, and
  reason fields.
- `tests/cli-discover.test.ts`: search is deterministic across repeated runs;
  `--kind` and `--limit` filter output; route namespace queries return route
  results.
- `tests/cli-discover.test.ts`: empty/whitespace query, invalid `kind`,
  `limit: 0`, negative limit, non-integer limit, and over-max limit return
  parseable JSON failures with `ok:false`, typed `kind`, `detail`, and suggestions
  where relevant.
- `tests/cli-discover.test.ts`: `vean discover delete --json` does not silently
  choose one destructive meaning; it returns multiple candidates or a
  disambiguation result.
- `tests/cli-timeline-ops.test.ts`: `vean timeline ops list --json` includes all
  public ops grouped by category; `describe crossfade --json` resolves to
  canonical `dissolve` with `resolvedFrom: "crossfade"`; examples are emitted.
- `tests/cli-timeline-ops.test.ts`: `vean timeline ops describe _unlift --json`
  and searching for internal `_` inverse names fail or return no public results.
- `tests/cli-timeline-ops.test.ts`: `timeline apply-op _unlift ...` and
  `timeline preview-op _unlift ...` fail as non-public ops, while `timeline undo
  --inverse-json '{"op":"_unlift",...}'` remains accepted when args are valid.
- `tests/cli-timeline-current.test.ts`: in a fresh project with a cataloged `.mlt`,
  `timeline use <path>` sets `timeline:main`, `timeline current --json` resolves
  it, and `timeline diagnose --json` works with omitted URI.
- `tests/cli-timeline-current.test.ts`: after `timeline use`, omitted-URI
  `preview-op`, `apply-op`, `undo`, `diagnose`, `resolve-value-at-frame`, and
  `find-references` all run against `timeline:main` and return `uri`,
  `resolvedPath`, and `project` in JSON.
- `tests/cli-timeline-current.test.ts`: explicit `timeline:main` route works in
  `apply-op`, `undo`, `diagnose`, `resolve-value-at-frame`, and
  `find-references`, plus `preview-op timeline:main gain ...`; alternatively, a
  shared route resolver unit covers alias resolution and each command has adapter
  coverage proving it calls that resolver.
- `tests/cli-timeline-current.test.ts`: omitted URI without `timeline:main`
  returns a typed nonzero JSON failure with suggested setup commands; `timeline
  current --json` without `timeline:main` exits 0 with `activeTimeline: null` and
  `next`.
- `tests/cli-timeline-current.test.ts`: stale/deleted `timeline:main` returns a
  typed `stale-route` failure for commands that need the file.
- `tests/cli-timeline-current.test.ts`: relative timeline paths resolve against
  project root from a neutral cwd; absolute paths and `file://` URIs are accepted;
  returned `uri` is normalized and `resolvedPath` is absolute.
- `tests/cli-timeline-current.test.ts`: outside-project `.mlt` targets are
  accepted and return `outsideProject: true`.
- `tests/cli-timeline-current.test.ts`: `timeline.use` rejects missing files,
  directories, broken symlinks, existing non-`.mlt` files, unknown aliases,
  alias-to-directory, alias-to-non-MLT, circular aliases, and `media:raw` when it
  resolves to a directory. Each failure is parseable JSON and does not overwrite
  the prior `timeline:main`. Uppercase `.MLT` is accepted.
- `tests/cli-timeline-current.test.ts`: route-chain behavior is pinned:
  `timeline:main -> timeline:review -> file.mlt` is allowed as one alias-to-alias
  indirection; `timeline:main -> timeline:review -> timeline:alt -> file.mlt`
  fails as `route-chain` and preserves the prior `timeline:main`.
- `tests/cli-timeline-current.test.ts`: `timeline.list` is stable-sorted,
  de-duplicates catalog+route entries for the same path, marks source as
  `catalog`, `route`, or `both`, reports stale routes, and returns an empty list
  cleanly for an empty project.
- `tests/cli-timeline-parsing.test.ts`: `timeline preview-op gain --args-json
  ... --json` treats `gain` as the op with active timeline; `timeline preview-op
  <uri> gain ...` remains old-form compatible; `timeline preview-op gain
  --timeline timeline:main ...` works; help text names the active-timeline
  default.
- `tests/cli-timeline-parsing.test.ts`: `timeline apply-op trim-out --timeline
  timeline:main`, old `apply-op <uri> trim-out`, and one-positional omitted-URI
  forms dispatch to canonical `trimOut`. `resolve-value-at-frame 10` treats `10`
  as the frame only when active timeline exists or `--timeline` is supplied.
- `tests/cli-timeline-aliases.test.ts`: execution-edge aliases are real, not only
  docs. `preview-op timeline:main crossfade` resolves to `dissolve`, `apply-op
  timeline:main volume` resolves to `gain`, outputs include canonical
  `invocation.op` and `resolvedFrom`, and `inverse.op` never contains an alias.
- `tests/cli-timeline-aliases.test.ts`: typo `crossfdae` returns deterministic
  suggestions plus `vean timeline ops list` hint, exits nonzero under `--json`,
  and a failed unknown-op apply does not write the file.
- `tests/cli-timeline-aliases.test.ts`: apply through an alias, serialize/reparse,
  then `timeline undo` using the canonical/internal inverse restores the original
  document.
- `tests/cli-actions.test.ts`: old explicit-uri forms still work for at least
  `timeline preview-op <uri> gain --args-json ... --json` and `timeline apply-op
  <uri> gain --args-json ... --json`, asserting `ok: true`, canonical
  `invocation.op`, explicit-path `touchedUris`, and no `health`/`diagnostics`.
- `tests/cli-actions.test.ts`: direct CLI JSON for `discover`, `timeline ops`,
  `timeline list`, and `timeline current/use` matches `action run <id>` for the
  same input.

### MCP

- `tests/mcp-projection.test.ts`: actual MCP registration, via server start or a
  spy server around the registration helper, lists `discover-manifest`,
  `discover-search`, `timeline-ops-list`, `timeline-ops-describe`,
  `timeline-ops-examples`, `timeline-current`, `timeline-use`, and
  `timeline-list`.
- `tests/mcp-projection.test.ts`: MCP does not list alias tools such as
  `crossfade`, `delete-gap`, `ripple-delete`, `trim-out`, or `volume`.
- `tests/mcp-projection.test.ts`: discovery tools are read-only; timeline-use has
  state-write metadata; timeline apply remains non-idempotent and reversible by
  inverse op; registered input schemas match action descriptors.
- `tests/mcp-projection.test.ts`: descriptor metadata includes canonical names,
  human titles, "Use this when..." descriptions, alias metadata/fallback, compact
  schemas, and projected effect hints for at least one discovery tool, one
  timeline-op tool, and `timeline-use`.
- `tests/mcp-projection.test.ts`: `vean discover <q> --json`,
  `action run discover.search`, and the MCP discovery tool return the same
  canonical top result shape for one golden query.

### Integration

- `tests/doctor.test.ts`: spawning `bun src/cli.ts doctor --surface all --json`
  reports named CLI, MCP, and LSP check entries.
- `tests/tools-mutate.test.ts` or existing tool-output tests assert mutating
  outputs still omit standing `health` and `diagnostics` unless a newly introduced
  blocking alert exists.
- `bun run typecheck`, `bun run lint`, and `bun run test` pass.
- `bun run move2:e2e` passes as the workflow-integration gate: preview/apply
  returns consequences, inverse, touched URIs, and only newly introduced blocking
  alerts, not full diagnostic dumps.

## Edge Cases

- Ambiguous alias/query: return candidates with canonical ids; do not pick a
  mutating op from a vague query like `delete`.
- Alias collision: fail tests and module-load validation.
- Unknown op typo: typed error with suggestions and `vean timeline ops list`
  command hint.
- Missing active project: discovery still works with `project: null`; project
  commands continue to guide setup.
- Missing active timeline: read-only op discovery works; timeline-mutating commands
  fail with setup guidance.
- Route points outside project: accepted in this slice with
  `outsideProject: true`, normalized `uri`, absolute `resolvedPath`, and project
  source so agents do not guess.
- Existing explicit URI workflows keep working.
- Inverses use canonical op names even when the forward call used an alias.
- Every new `--json` CLI failure emits parseable JSON with `ok:false`, typed
  `kind`, `detail`, `suggestions` when relevant, and nonzero exit. Human stderr
  may stay concise.

## Definition of Done

- All new behavior is reachable through action registry, Commander CLI, and MCP
  where surface metadata says it should be.
- Agents can discover operation names, argument summaries, examples, aliases, and
  active timeline setup through CLI/MCP without reading source.
- No duplicate alias tools/actions are exposed.
- `timeline:main` is usable as the active timeline route and omitted URI default.
- Docs and editing/setup skills describe the new discovery loop.
- The Check Contract passes.

## TDD Verification

TDD passes: 3 rounds on 2026-06-28. Initial coverage, edge-case, and brittleness
reviews found gaps in MCP projection tests, active timeline fallback, Commander
positional parsing, alias execution, route-chain behavior, internal inverse op
exposure, action/CLI/MCP parity, and JSON failure shape. Those findings were
absorbed into the Check Contract. Final convergence review reported CLEAN.
