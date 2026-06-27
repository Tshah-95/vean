# vean build monitor

This is the checkpoint protocol for supervising Claude/agent implementation work
on the LSP + bridge build. It is intentionally high-fidelity and low-noise:
capture enough state to challenge bad direction, but do not rerun expensive
render gates unless the touched files justify it.

## Cadence

Every 15 minutes while an agent is actively building, record one checkpoint:

1. `git rev-parse HEAD`
2. `git status --short --branch`
3. `git log --oneline -5`
4. `git diff --stat`
5. `bun run typecheck`
6. `bun run test`

If the checkpoint follows a commit, review that commit before the next agent
continues:

```bash
git show --stat --oneline --decorate --find-renames <sha>
git show --find-renames --format=fuller <sha>
```

## Review lens

Challenge the work against this contract, in order:

1. **Ambient feedback first.** Does the implementation make `vean-lsp` publish
   diagnostics automatically after document/project changes, or did it regress
   into a manual `diagnose` loop?
2. **Shared rules.** Do LSP, MCP, CLI, tests, and future UI call the same
   `src/diagnostics/` engine rather than reimplementing checks?
3. **Tool output discipline.** Do mutation tools return consequences, inverse,
   touched URIs, and compact health summaries without dumping full diagnostic
   payloads every time?
4. **Agent ergonomics.** Can Claude see new adverse effects and their fixes
   without being instructed to run a separate diagnostic command?
5. **Protocol fidelity.** Does the LSP surface use normal document sync,
   `publishDiagnostics`, references/definitions/hover, and code actions where
   they fit, rather than inventing a bespoke polling protocol?
6. **Core invariants.** Frame-exact integer timing, stable clip identity,
   deterministic XML, Shotcut-openable output, no GPL linking, no stateful
   network/DB dependencies.

## Escalation triggers

Pause and challenge the agent if any of these appear:

- `diagnose` becomes the required safety step after ordinary edits.
- Diagnostics are implemented separately in `src/bridge/` or `src/lsp/` instead
  of shared from `src/diagnostics/`.
- Tool responses include full diagnostic dumps by default.
- LSP diagnostics are only pull/manual, with no pushed current-set behavior.
- An op writes an unserializable or non-invertible timeline.
- Tests pass only by narrowing fixtures instead of preserving the contract.

## Completion criteria

The build is complete only when the Move 2 gates in `ROADMAP.md` pass:

- `vean-lsp` pushes a known defect into Claude context without manual
  `diagnose`.
- Claude fixes that defect and the pushed diagnostic set clears.
- MCP tools return consequences, inverse, touched URIs, and compact health
  summaries.
- At least two seeded editing tasks pass through op → ambient diagnostics →
  render/still review.
