# vean build monitor

This is the checkpoint protocol for supervising Claude/agent implementation work
on the bridge, action runtime, CLI/project ergonomics, and local app path. It is
intentionally high-fidelity and low-noise: capture enough state to challenge bad
direction, but do not rerun expensive render gates unless the touched files
justify it.

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
   touched URIs, and optional alerts only for newly introduced blocking errors,
   without returning standing health snapshots or full diagnostic payloads every
   time?
4. **Agent ergonomics.** Can Claude see new adverse effects and their fixes
   without being instructed to run a separate diagnostic command?
5. **Protocol fidelity.** Does the LSP surface use normal document sync,
   `publishDiagnostics`, references/definitions/hover, and code actions where
   they fit, rather than inventing a bespoke polling protocol?
6. **Core invariants.** Frame-exact integer timing, stable clip identity,
   deterministic XML, Shotcut-openable output, no GPL linking, no stateful
   network dependencies, and only repo-local product state in `.vean/vean.db`.
7. **Local state hygiene.** Does any new product state go through `src/state/`
   and Drizzle migrations, with `.vean/` gitignored, WAL enabled, and short
   transactions? No long render/agent work inside a DB transaction.
8. **Action registry ownership.** Is product behavior defined once in
   `src/actions/`, with CLI/MCP/LSP/Tauri as adapters, or did a surface grow its
   own domain logic?
9. **Commander parity.** Are CLI commands Commander-backed and action-backed,
   with every public action exposed by an ergonomic command or
   `vean action run`?
10. **Project context honesty.** Do commands resolve and report the active
    project/timeline/media routes deterministically, rather than relying on
    hidden cwd/path guesses?
11. **Permission projection.** Are scopes/effects/approval metadata native to
    vean and projected to MCP hints, CLI confirmations, and Tauri capabilities,
    rather than trusting one host's annotation model as authorization?

## Escalation triggers

Pause and challenge the agent if any of these appear:

- `diagnose` becomes the required safety step after ordinary edits.
- Diagnostics are implemented separately in `src/bridge/` or `src/lsp/` instead
  of shared from `src/diagnostics/`.
- Tool responses include full diagnostic dumps by default.
- LSP diagnostics are only pull/manual, with no pushed current-set behavior.
- An op writes an unserializable or non-invertible timeline.
- Tests pass only by narrowing fixtures instead of preserving the contract.
- Long-running work happens while holding a SQLite transaction or file lock.
- `.vean/` contents are staged or treated as canonical timeline data.
- A CLI/MCP/Tauri command bypasses `executeAction` for product behavior that
  should be registry-owned.
- A first-class CLI command exists without an action id, or a public action lacks
  either an ergonomic command or an explicit hidden reason.
- A command mutates outside the selected project without `ask-strong` policy.
- A path-bearing action omits resolved project/timeline/resource paths or
  touched URIs from machine-readable output.

## Completion criteria

For Move 2 work, the build is complete only when the Move 2 gates in
`ROADMAP.md` pass:

- `vean-lsp` pushes a known defect into Claude context without manual
  `diagnose`.
- Claude fixes that defect and the pushed diagnostic set clears.
- MCP tools return consequences, inverse, touched URIs, and optional alerts
  without standing health snapshots.
- At least two seeded editing tasks pass through op → ambient diagnostics →
  render/still review.
- `.vean/vean.db` initializes through `bun run project:init`, doctor reports
  state clean, and job lease smoke tests pass.

For Move 3 work, the build is complete only when the Move 3 gates in
`ROADMAP.md` pass:

- Every Move-2 tool/CLI behavior is action-backed with parity tests.
- Every public action is reachable through Commander or `vean action run`.
- Policy metadata projects correctly to CLI, MCP, LSP, and Tauri snapshots.
- A fresh project can be initialized, selected, routed through media roots, and
  used to render a still without repeating absolute paths after selection.
- Concurrent job claims do not double-claim and long work never holds DB locks.
