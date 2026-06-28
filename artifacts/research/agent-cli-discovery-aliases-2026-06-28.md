# Research: agent CLI discovery and alias policy

Date: 2026-06-28

## Question

For vean's CLI/MCP/app action surfaces, should command aliases be exposed as
multiple callable names, or should vean keep one canonical command/action/op name
and make human-friendly names discoverable as metadata?

## Decision

Use one canonical identity for every action and edit operation. Put aliases,
synonyms, human phrases, and NLE vocabulary in metadata, command help, examples,
and deterministic discovery search. Do not expose duplicate model-callable tools
or duplicate action ids for the same behavior.

For CLI ergonomics, Commander aliases are acceptable only at the edge when they
resolve to the canonical id and every machine-readable response records the
canonical id. MCP, policy, audit logs, undo/inverse operations, telemetry, and
the future app all use canonical ids only.

## Why

### Agent tool selection depends on metadata quality

OpenAI's Apps SDK guidance says tool discovery is driven almost entirely by
metadata: unique action-oriented names, descriptions that explain when to use the
tool, parameter annotations, and prompt rehearsal where every direct prompt maps
to exactly one tool. This argues for richer descriptors, not duplicate aliases as
separate tools.

Source: https://developers.openai.com/apps-sdk/plan/tools

Anthropic's tool guidance similarly emphasizes detailed descriptions, high-signal
responses, and examples for complex nested or format-sensitive inputs. The vean
op surface is exactly that kind of format-sensitive input today: `timeline.applyOp`
accepts `{ op, args }`, but the per-op args are hidden in TypeScript source.

Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools

Anthropic's engineering write-up also recommends prototyping tools locally, then
running real-world task evaluations to see whether agents can use the surface.
That should become part of vean's command-discovery build: golden prompt
rehearsals for "crossfade these clips", "delete but leave a gap", "ripple delete",
"duck this audio", and similar editing intents.

Source: https://www.anthropic.com/engineering/writing-tools-for-agents

### MCP separates identity from display and safety metadata

MCP tools have a unique `name`, optional human-readable `title`, description,
JSON input schema, optional output schema, and behavior annotations such as
read-only/destructive/open-world hints. The protocol shape supports a canonical
machine identity with richer user/model-facing metadata; it does not require or
reward exposing aliases as separate tools.

Source: https://modelcontextprotocol.io/specification/2025-11-25/server/tools

The MCP tool-annotations charter frames annotations as metadata that lets hosts
make safer, more usable agentic systems. That matches vean's current action
runtime design: native effect metadata is authoritative, then projected to MCP
annotations.

Source: https://modelcontextprotocol.io/community/interest-groups/tool-annotations

### CLI conventions allow aliases, but clarity and consistency matter

CLI Guidelines recommends full-length readable flags, standard names such as
`--json`, `--dry-run`, and `--help`, good defaults, scriptable non-interactive
paths, and confirmation before dangerous actions.

Source: https://clig.dev/

Microsoft's command-line design guidance recommends short, easy-to-spell names,
lowercase/kebab-case words, consistent pluralization, verbs for action commands,
and care around aliases because familiar names can differ in meaning across
communities. This is directly relevant to NLE terms: "delete" may mean lift,
ripple delete, or destructive media deletion depending on context.

Source: https://learn.microsoft.com/en-us/dotnet/standard/commandline/design-guidance

## Local vean state

Subagent survey found these current surfaces:

- `package.json` exposes `vean`, `vean-lsp`, and `vean-mcp`.
- `src/cli.ts` exposes Commander commands for `action`, `timeline`, `render`,
  `media`, `route`, `state`, `project`, and `jobs`.
- `src/actions/registry.ts` defines action ids, titles, descriptions, Zod
  schemas, effects, scopes, and surface metadata.
- `src/bridge/mcp/server.ts` generates MCP tools from registered actions.
- `src/bridge/lsp/server.ts` handles ambient diagnostics, navigation, hover, and
  deterministic code actions.
- `src/ops/index.ts` exposes `REGISTRY` and `OP_NAMES`; `OP_NAMES` is currently
  the public operation vocabulary.

Current gaps:

- `timeline.applyOp` and `timeline.previewOp` take `op: string` plus opaque
  `args: record`; agents cannot discover valid ops or per-op arg schemas through
  the action descriptor.
- `describeAction` does not include JSON-ish schemas, examples, per-op docs,
  consequences, preconditions, or alias metadata.
- MCP inherits that generic shape, so its `apply-op` tool is too broad and
  underspecified.
- There is no `vean timeline ops list`, `vean timeline ops describe`, or
  `vean discover`.
- A local documentation bug exists: the `trimOut` comment says positive `delta`
  extends the tail, but implementation/tests indicate positive `delta` shortens
  the tail. This must be corrected before generating docs.
- Projects can have many `.mlt` files in the media catalog, but there is no
  first-class active timeline model yet. Route aliases already provide a good
  near-term fit via `timeline:main`.

## Alias Policy

1. Canonical action ids remain namespaced camelCase, e.g. `timeline.applyOp`,
   `render.still`, `media.scan`.
2. Canonical edit operation tokens remain the existing `OP_NAMES`: `append`,
   `split`, `insert`, `overwrite`, `lift`, `remove`, `replace`, `trimIn`,
   `trimOut`, `move`, `dissolve`, `fadeIn`, `fadeOut`, `gain`, `addFilter`,
   `removeFilter`, `addTrack`, `removeTrack`.
3. CLI command paths use lowercase/kebab-case where they are command words:
   `timeline apply-op`, `timeline preview-op`, `timeline ops describe`,
   `trim-in`, `trim-out` as command/search aliases for canonical `trimIn` and
   `trimOut`.
4. Aliases are metadata, not identity. Machine outputs include
   `canonicalId`/`canonicalOp` and, when relevant, `resolvedFrom`.
5. MCP exposes one tool per action. It may include alias metadata for discovery,
   but it does not expose duplicate callable alias tools.
6. Audit, policy, jobs, undo inverses, and tests use canonical ids only.

Recommended initial op aliases:

- `lift`: `delete-gap`, `remove-no-ripple`
- `remove`: `ripple-delete`, `delete-ripple`
- `trimIn`: `trim-in`
- `trimOut`: `trim-out`
- `dissolve`: `crossfade`
- `gain`: `volume`, `set-gain`

Avoid ambiguous bare `delete` as an executable alias until CLI prompts can
disambiguate between `lift`, `remove`, and future media/file deletion.

## Command Discovery Policy

`--help` is necessary but insufficient. Humans should be able to learn from
normal Commander help, but agents need stable, structured discovery:

- `vean discover --json` returns a compact manifest of command families,
  registered actions, edit operations, route namespaces, active project/timeline
  context, and suggested next commands.
- `vean discover <query> --json` performs deterministic local search over
  canonical ids, titles, aliases, descriptions, examples, and route namespaces,
  returning canonical targets.
- `vean action describe <id> --json` includes schema summaries, examples, effects,
  and surfaces.
- `vean timeline ops list/describe/examples --json` exposes the edit algebra
  without requiring agents to read source.

This gives agents a low-context bootstrap path while keeping Commander help
idiomatic and keeping MCP tool lists small.

## Build Implications

The next build should add an operation catalog, action/command discovery actions,
timeline route/current commands, and a test harness that checks:

- every public op has a descriptor, aliases are unique, and examples validate;
- every direct golden prompt maps to exactly one canonical command/action/op;
- aliases resolve to canonical names in CLI outputs and action envelopes;
- the MCP tool list does not grow duplicate alias tools;
- active timeline resolution works through `timeline:main` and omitted timeline
  args for timeline commands;
- JSON output is stable enough for agents and tests.

