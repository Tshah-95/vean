# Gate — Move 2 (the ambient LSP + diagnostic-aware agent bridge)

**Status: GREEN — Move 2 COMPLETE.** The agent bridge is built as a surface OVER
the Move-0/1 shared core (it CALLS `src/diagnostics`, `src/query`, `src/ops`,
`src/driver`; it reimplements no rule). `vean-lsp` pushes diagnostics ambiently;
the MCP tools return the compact ToolResult; two seeded editing tasks pass
end-to-end through op → ambient diagnostics → render → still. A cross-surface
defect the bridge surfaced (split-of-a-color-clip) was fixed at root cause in the
edit algebra and regression-tested, with the full Move-1 gate re-verified green.

Base commit for this gate run: `b6ce976` (the Move-2 work sits on top).

Toolchain: melt 7.38.0, ffmpeg 8.1.2 (`/opt/homebrew/bin`), xmllint, Bun 1.3.14 +
vitest 2.1.9, Biome 1.9.4.

---

## The four completion criteria — all met

| # | Criterion | Where it's proven |
|---|---|---|
| 1 | `vean-lsp` PUSHES a known defect into the client (`publishDiagnostics`) automatically after a document change, with NO manual `diagnose` in the path | `tests/lsp-ambient.test.ts` — a `didOpen` over a **real paired JSON-RPC connection** driving the actual `registerHandlers` makes the server send `textDocument/publishDiagnostics` carrying `in-out-beyond-source`. No diagnose request exists in the test. |
| 2 | Applying the fix clears the pushed set (empty `publishDiagnostics`) | `tests/lsp-ambient.test.ts` — a `didChange` with the corrected document publishes `diagnostics: []`. Also: the **code action** for the defect, applied, makes re-analysis return zero diagnostics. |
| 3 | MCP tools return consequences, inverse, touched URIs, and a COMPACT health summary — verified to NOT include a full diagnostic dump; the inverse is a WORKING undo | `tests/mcp-tools.test.ts` + `bun run move2:e2e` — the ToolResult carries all four fields; `health` has counts + `newOrBlocking` only; `health` has no `diagnostics` key; a new/blocking diagnostic appears in `newOrBlocking` while an untouched pre-existing warning is counted but NOT dumped. The `inverse` is exercised as a real undo INCLUDING the persist path (apply-op → serialize/write → reparse → undo) — driven over the real MCP wire (apply-op → `undo` tool, real on-disk `.mlt`) and pinned by `mcp-tools.test.ts` Task 5. This is where the C3 trim-on-color-clip inverse defect was found and fixed (see § Defects). |
| 4 | ≥2 seeded editing tasks pass end-to-end: op (via tool) → ambient diagnostics clean → render → still (a real frame) | `bun run move2:e2e` — Task 1 (`trimIn clip-3 +10`) and Task 2 (`gain clip-5 -6dB`) each: apply via the tool core, assert the compact ToolResult, persist, re-analyze clean, render an MP4, grab a real PNG still. OVERALL PASS 2/2. (A third file-clip split task + the color-split fix are covered in the unit suite.) |

---

## What passed (GREEN)

| Stage | Result |
|---|---|
| `bun run typecheck` (`tsc --noEmit`) | clean |
| `bun run lint` (`biome check .`) | **96 files**, no fixes |
| `bun run test` (vitest) | **773 passed**, 0 skipped, **33 files** |
| `bun run lint:xml` | **12/12** XML namespace-clean (Shotcut-openable) — unchanged |
| `bun run verify:corpus` | **10/10** faithful; every sampled frame SSIM **1.0000** — unchanged |
| `tests/op-invariants.test.ts` | **221 passed** (18/18 public ops; +8 from the color-trim samples that lock the trim-color rebase) |
| `bun run move2:e2e` | **OVERALL PASS — 2/2** seeded tasks op→ambient→render→still |
| `bun run read-tools:artifact` | **OVERALL PASS** — `renderTool`/`stillTool` (the read-tool core) produce a true MP4 + PNG on disk at their reported `touchedUris`; a missing doc is a typed `ReadError`, not a throw |

New test files this Move: `lsp-ambient.test.ts` (the ambient gate over the real
protocol + source-mapping + code-action + parse-error robustness),
`lsp-navigation.test.ts` + `lsp-codeactions.test.ts` (the READ + FIX surfaces over
the wire), `mcp-tools.test.ts` (13 — the tool-output discipline + the seeded-task
op→clean legs + the **trim-undo persist** regression), `tools-mutate.test.ts`,
`read-tools.test.ts`, `cli-mutate.test.ts`, `source-map.test.ts`. Plus regression
locks in `ops-trim-move.test.ts` (47 — the color-split AND color-trim
window-rebase regressions) and `op-invariants.test.ts` (221 — the +8 color-trim
samples).

---

## The architecture this Move obeys (load-bearing)

Per AGENTS.md "Agent feedback contract" + BUILD-MONITOR.md review lens:

1. **AMBIENT FIRST.** `vean-lsp` publishes the full current set after every
   `didOpen`/`didChange` (one `onDidChangeContent` handler). No manual diagnose
   loop. ✅
2. **SHARED RULES.** The LSP engine and the MCP tool core both call
   `collectDiagnostics` (src/diagnostics) — the ONE engine. No `src/lsp/`, no
   diagnostics in `src/bridge/`; neither exists. ✅
3. **TOOL OUTPUT DISCIPLINE.** Mutating tools return consequences + inverse +
   touchedUris + a compact health (counts + `newOrBlocking` only); the full set is
   never in a mutating tool's reply (the `diagnose` tool is the one deliberate
   exception). ✅
4. **AGENT ERGONOMICS.** A new adverse effect shows in `newOrBlocking` and the
   inverse is in the same reply; the full current picture arrives ambiently — no
   "remember to run diagnose". ✅
5. **PROTOCOL FIDELITY.** Real LSP: document sync, `publishDiagnostics`,
   references/definition/hover, code actions. No bespoke polling protocol. ✅
6. **CORE INVARIANTS.** Frame-exact integer timing, stable uuid identity,
   deterministic Shotcut-openable XML (lint:xml 12/12, verify:corpus SSIM 1.0), no
   GPL linking (melt/ffmpeg driven as subprocesses), no stateful network/DB. ✅

None of the escalation triggers fired: no diagnose-after-edit requirement, no
diagnostics reimplemented in the bridge, no full-dump tool responses, no pull-only
LSP, no unserializable/non-invertible op write, no fixtures narrowed to pass.

---

## The files (the bridge layout)

```
src/bridge/
  index.ts                 the bridge barrel
  lsp/engine.ts            transport-free: analyze → LSP diagnostics + the shared
                           element-locating helpers (the parse + diagnostics core)
  lsp/navigation.ts        transport-free: hover / references / definition (the READ
                           surface; calls src/query resolveValueAtFrame + findReferences)
  lsp/codeActions.ts       transport-free: the deterministic repairs (the FIX surface;
                           WorkspaceEdits over the .mlt text from a diagnostic's code+data)
  lsp/server.ts            stdio: TextDocuments sync → publishDiagnostics ambient loop;
                           binds analyze + navigation + codeActions to the JSON-RPC handlers
  tools/types.ts           the ToolResult contract (compact health, no dump)
  tools/core.ts            transport-free: mutate/preview/undo/resolve/refs/diagnose
  mcp/server.ts            stdio: registers the tool set, marshals to the core
src/ir/source-map.ts       ADDITIVE: IR-identity → .mlt text-span index
scripts/move2-e2e.ts       the op→ambient→render→still gate (bun run move2:e2e)
.claude/skills/editing/    the first real skill: the agent editing method
package.json               bins: vean-lsp, vean-mcp · scripts: lsp, mcp, move2:e2e
```

Libraries (Bun-verified): `vscode-languageserver` 10 +
`vscode-languageserver-textdocument` for the LSP; `@modelcontextprotocol/sdk` for
MCP. Both pure-TS deps — no GPL link, no bundled binary.

---

## The source-mapping approach (diagnostic ranges)

`collectDiagnostics` locates by STABLE IDENTITY (clip uuid / track id / transition
index). `src/ir/source-map.ts` is an ADDITIVE lexical pass over the raw `.mlt`
text (NOT a parser change — the parser stays byte-faithful, so the Move-0/1
goldens are untouched) that indexes each addressable element's byte span by that
same identity. The LSP engine converts a span to an LSP `Range` with
`TextDocument.positionAt`. A clip resolves to its `<producer>` (the diagnostic
anchor) and its `<entry>` (where the played window lives, so a window-clamping
code action rewrites the right place); a track to its `<playlist>`/`<tractor>`; a
field transition to the `<transition>` with an `id` (excluding a dissolve's idless
luma/mix). An unresolvable location falls back to the document head — a diagnostic
is never dropped. See [DESIGN-MOVE2.md](DESIGN-MOVE2.md) §2.

---

## The navigation + code-action surface (`lsp/navigation.ts`, `lsp/codeActions.ts`)

The two LSP feature modules sit beside the engine, each calling the shared core and
reimplementing nothing.

**Navigation (the READ surface).** `hover` / `references` / `definition` locate the
element under the cursor via the source map, then DELEGATE the answer to the shared
`src/query` layer:
- **hover** is the "go-to-definition for video" surface — over a clip it resolves
  every fade + animated filter parameter's EFFECTIVE value at the clip's start
  frame through `resolveValueAtFrame` (e.g. `brightness.level: 0.2 (via clip)`,
  `fadeIn level: 0 (via fade)`), labelled with the producing scope; over a field
  transition it does the same at the transition's start. The hover number agrees
  with the `resolve` CLI verb by construction (both call the one resolver).
- **references** delegates the source-usage set to `findReferences({kind:"source"})`.
- **definition** points at the clip's `shotcut:uuid` property value (its declaration).

**Code actions (the FIX surface).** Each is a `WorkspaceEdit` (a `TextEdit` on the
`.mlt`) computed PURELY from a diagnostic's stable `code` + machine `data` + the
source map — never from a re-derived rule. Three repairs, each proven to CLEAR its
diagnostic on re-analysis (and over the real wire: request → apply as `didChange` →
empty re-publish):
- `in-out-beyond-source` → clamp the clip `<entry>`'s `out` to `length-1`.
- `transition-inverted-window` → swap the `<transition>`'s `in`/`out`.
- `transition-no-overlap` → clamp the transition window onto the last content frame.

The scope is deliberate. Only repairs **reachable through the LSP document path**
are offered: the LSP always holds a PARSED document, so a defect the IR schema
rejects (a negative in-point, an empty resource, a service-less filter — all
Zod-invalid → a parse-error) never reaches a code action; those diagnostics exist
for a hand-built IR (the MCP/test path) and their repairs belong there. Repairs that
need a structural rewrite or a human CHOICE (relink a missing asset to a NEW path,
resolve a ripple direction, re-time a same-track dissolve + its nested tractor) are
the MCP `apply-op` layer's job — a quick-fix must be self-contained. Duplicate edits
(one defect that fires per-track) collapse to a single offered action.

Proven by `tests/lsp-navigation.test.ts` (9) + `tests/lsp-codeactions.test.ts` (7,
incl. the over-the-wire request→apply→re-publish-clears loop).

---

## Defects found + FIXED this Move (cross-surface, root cause)

Both defects are the **same root-cause family**: a positionless COLOR generator's
window is meaningful only as a *playtime* (the serializer ALWAYS emits a color
clip 0-based — `in=0, out=len-1, length=len` — `serialize.ts walkTrack`), so any
op that resizes a color clip's window must re-base it to 0-based or the in-memory
IR diverges from the serialized form. Both were found by the bridge doing its job;
both were fixed at the EDIT-ALGEBRA layer, never papered over in the bridge.

**Defect 1 — split (found during build).** Splitting a COLOR clip produced a state
the diagnostics engine flagged as an error: the split tail kept a re-based `length`
(its own played count) but an UN-rebased `out`, so `out ≥ length` tripped
`in-out-beyond-source` on a valid edit — a latent inconsistency between the split op
(`src/ops/primitives.ts splitEntryAt`) and the diagnostics engine, EXPOSED by the
ambient feedback loop. **Fixed:** `splitEntryAt` re-bases each color split half's
window to 0-based (`[0, playtime-1]`), making `out < length` hold by construction.

**Defect 2 — trim (found during this gate's criteria verification, C3).** A
`trimIn`/`trimOut` on a COLOR clip resized its window in source space (e.g. trimIn
+10 → `in=10, out=49`), but the serializer re-bases a color clip to 0-based
(`in=0, out=39`). The op's **scalar inverse** (`trimIn −10`) was correct against the
in-memory window but, after a serialize→reparse **persist** — exactly the path the
MCP server takes between `apply-op` (writes the `.mlt`) and the `undo` tool (reads
it back) — computed `newIn = 0 − 10 = −10 < 0` and FAILED with `frame-out-of-range`.
So the documented seeded trim op's `inverse` field was a BROKEN undo across persist
(criterion 3 requires a working inverse). The existing undo test missed it because
it only exercised `gain` and applied the inverse to the in-memory post-edit state,
never serialize→reparse. **Fixed at root cause in the edit algebra**
(`src/ops/trim.ts`): a trim on a positionless color clip now validates by playtime
(no source-bound `in≥0` / `out<length` checks — meaningless for a generator) and
re-bases the window to canonical 0-based by playtime (`in=0, out=playtime−1,
length=playtime`) — mirroring the split-color fix — so the in-memory IR is byte-
identical to the serialized form and the scalar inverse survives the persist
round-trip. The trim side still chooses which neighbour blank absorbs the change.

**Verification (both defects).** Byte-stable round-trip (`toMlt(fromMlt(x)) === x`)
and a byte-exact restore-to-original through the persist path; diagnostic-clean
state (no `in-out-beyond-source`); pixel-identical render (a color clip is content-
identical at every frame — verify:corpus SSIM 1.0000 unchanged, and Task 1's
frame-30 still is the expected solid blue). The full Move-1 op-invariants gate re-runs
green (**221/221**, +8 from the new color-trim samples). Locked at the edit-algebra
layer (`tests/ops-trim-move.test.ts`: 0-based windows, diagnostic silence,
byte-stable round-trip, in-memory undo, AND serialize→reparse→undo restore for BOTH
trimIn and trimOut) and over the bridge wire (`tests/mcp-tools.test.ts` Task 5:
apply-op → persist → undo restores the document). The fix was confirmed
load-bearing: reverting it alone (samples + tests intact) fails 5 tests, all on the
persisted-undo path.

---

## Still open (correctly deferred — not Move-2 deliverables)

- **The Claude Code plugin config** registering `vean-lsp` with diagnostics on by
  default — editor/host configuration, not a code artifact; documented in the
  `editing` skill. The server is a conformant LSP a host registers like any other.
- **The viz layer** (Move 3) — only reads the IR + render outputs; unblocked.
- **The I/O-injected perceptual diagnostics** (dangling FILE ref, upscaling,
  colorspace) carried over from Move 1b as finalized-signature stubs — they land
  additively at the zero-false-positive bar; the bridge already surfaces whatever
  the engine reports, so no bridge change is needed when they go live.
