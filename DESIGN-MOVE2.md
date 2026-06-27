# Move 2 — the ambient LSP + diagnostic-aware agent bridge (design of record)

This is the **design barrier** for the agent bridge: the two coordinated surfaces
that sit OVER the shared Move-0/1 core (the IR, the edit algebra, the diagnostics
engine, the navigation queries, the melt driver) and turn it into something an
agent edits the way it edits code — *ambient* feedback after every change, *domain*
tools that report consequences and undo.

The load-bearing principle (AGENTS.md "Agent feedback contract", BUILD-MONITOR.md
review lens): **the bridge is a surface, never a re-implementation.** Every
diagnostic rule lives in `src/diagnostics/` and nowhere else; the LSP and the MCP
tools CALL `collectDiagnostics`, they do not re-derive validity. Putting a rule in
`src/bridge/` or a `src/lsp/` is the explicit escalation trigger, and neither
directory holds one.

```
                       ┌─────────────────────────────────────────┐
   editor / Claude ──► │  vean-lsp (stdio)   — AMBIENT feedback   │
     (LSP client)      │  document sync · publishDiagnostics      │
                       │  hover · references · definition · code  │
                       │  actions                                 │
                       └───────────────┬─────────────────────────┘
                                       │ calls (never reimplements)
   Claude / agent ───► ┌───────────────▼─────────────────────────┐
     (MCP client)      │  vean-mcp (stdio)   — DOMAIN actions     │
                       │  apply-op · preview-op · undo · render · │
                       │  still · resolve · refs · diagnose       │
                       └───────────────┬─────────────────────────┘
                                       │
            ┌──────────────────────────▼──────────────────────────┐
            │   THE SHARED CORE (Move 0/1 — untouched by Move 2)   │
            │   src/diagnostics  collectDiagnostics (the rules)    │
            │   src/ops          apply(op) → {state',conseq,inv}   │
            │   src/query        resolveValueAtFrame, findRefs     │
            │   src/ir           parse / serialize / source-map    │
            │   src/driver       render / still (melt, arm's-len)  │
            └─────────────────────────────────────────────────────┘
```

---

## 0. The architecture (where each thing lives)

```
src/bridge/
  index.ts            ← the bridge barrel (re-exports both surfaces)
  lsp/
    engine.ts         ← TRANSPORT-FREE heart: analyze(uri,text) → diagnostics
                         (LSP-shaped, with text ranges) + hover/refs/def/actions.
                         Calls collectDiagnostics + the source map + the queries.
    server.ts         ← the stdio JSON-RPC binding: a TextDocuments store, the
                         onDidChangeContent → publishDiagnostics ambient loop, and
                         the navigation/code-action handlers (delegated to engine).
  tools/
    types.ts          ← the ToolResult CONTRACT (consequences, inverse,
                         touchedUris, COMPACT health — no full dump).
    core.ts           ← TRANSPORT-FREE tool core: mutate/preview/undo (the edit
                         algebra + the compact-health diff), the read tools
                         (resolve/refs), the debug diagnose tool, ser/de helpers.
  mcp/
    server.ts         ← the stdio MCP binding: registers the tool set, marshals
                         each call to the tool core, reads/writes the .mlt file.
src/ir/source-map.ts  ← ADDITIVE: IR-identity → .mlt text-span index (the one new
                         thing the LSP needs that Move 0/1 didn't have).
```

The **transport-free / binding split** is deliberate and load-bearing: the
*engine* and the *tool core* are pure (or driver-delegating) functions with no
JSON-RPC, no stdio, no process. That is what makes the ambient behavior testable
**in-process** (the smoke test drives `analyze` and the real `registerHandlers`
over an in-memory connection — no spawned subprocess), and it is the same split
Move 1 used (engine vs CLI verb).

Bins/scripts wired in `package.json`: `vean-lsp` / `vean-mcp` (the `bin` entries),
`bun run lsp` / `bun run mcp` (dev), `bun run move2:e2e` (the render gate).

---

## 1. The library choices (and Bun compatibility)

| Surface | Library | Why | Bun? |
|---|---|---|---|
| LSP | `vscode-languageserver` (10.0.1) + `vscode-languageserver-textdocument` (1.0.12) | The reference Node LSP impl: `createConnection`, `TextDocuments` document sync, `publishDiagnostics`, the request handlers, and the `TextDocument.positionAt(offset)` we need for source-mapping. | ✅ verified — construct + `positionAt`/`offsetAt` round-trip under Bun 1.3.14. The stdio server uses **explicit** `StreamMessageReader(process.stdin)` / `StreamMessageWriter(process.stdout)` (not the argv `--stdio` auto-detect), which is the form that works cleanly under Bun. |
| MCP | `@modelcontextprotocol/sdk` (1.29.0) | The official MCP SDK: `McpServer.registerTool({description, inputSchema}, handler)` + `StdioServerTransport`. Zod input schemas match the project's existing Zod usage. | ✅ verified — `new McpServer(...)`, `registerTool`, `StdioServerTransport`, `connect` all import + construct under Bun. |

Both are added as `dependencies` (the distributed artifact is still pure TS;
neither links GPL code or bundles a binary — Hard boundaries #1/#2 hold). The LSP
is a real protocol surface; we did NOT invent a polling protocol (review lens #5).

---

## 2. The IR ⇄ .mlt source mapping (diagnostic ranges)

The hard part of an LSP-over-a-typed-IR: `collectDiagnostics` returns a location by
**stable identity** (a clip uuid, a track id, a transition index) because the
engine is pure over the IR and knows nothing about bytes. But `publishDiagnostics`
needs a **text `Range`** so the editor underlines the right span. We bridge the two
with `src/ir/source-map.ts`.

**The constraint that shaped the approach:** the parser (`src/ir/parse.ts`) must
stay byte-faithful — the Move-0/1 round-trip + render gates are golden-tested
against its exact output. Threading source offsets through the fast-xml-parser IR
would perturb every one of those goldens. So the source map is a **separate,
additive lexical pass** over the raw `.mlt` text, NOT a change to the parser. It is
a tiny forgiving lexer (the document already parsed — it's known well-formed) that
records the byte span of each addressable element, keyed by the SAME identity the
engine reports:

- **clip uuid → producer span.** A clip's identity is its `<property
  name="shotcut:uuid">` (the parser routes `Clip.id` through it). We scan every
  `<producer>`, read its uuid (falling back to the XML `id` attribute exactly as
  the parser does, so the keys agree with the IR), and record the element span.
- **clip uuid → the `<entry>` that plays it.** The parser reads a played clip's
  **timeline window** (`in`/`out`) from its playlist `<entry>`, not the producer.
  So a window-clamping code action must rewrite the ENTRY — we map each entry to a
  clip uuid via the producer XML id it references.
- **track id → playlist/tractor span**, **field-transition index → `<transition>`
  span** (the field transitions are the ones with an `id` attribute; a nested
  dissolve's idless luma/mix pair is excluded — that single discriminator cleanly
  separates field transitions from dissolve internals, matching how the serializer
  emits them).

`spanForLocation(map, loc)` resolves a diagnostic's location to a span (clip
first, then transition, then track), and the LSP engine converts the byte span to
an LSP `Range` with `TextDocument.positionAt` — we never reimplement line counting.
A location the map can't resolve falls back to the document head `(0,0)` so a
diagnostic is **never dropped** for want of a precise span; it just lands at the
top of the file.

This same map powers hover / go-to-definition / find-references: `elementAt(offset)`
finds the element under the cursor, and the navigation handlers read the IR (hover)
or call the shared `findReferences` query (references) for the answer.

---

## 3. The ToolResult contract (tool-output discipline)

The one rule a mutating tool must obey (review lens #3, the explicit escalation
trigger *"tool responses include full diagnostic dumps by default"*):

```ts
type ToolResult = {
  ok: true;
  consequences: Consequences;   // the edit algebra's structured "what changed"
  inverse: OpInvocation;        // re-apply via `undo` to reverse this edit
  touchedUris: string[];        // which documents changed (re-read / re-publish)
  health: {                     // a COMPACT diagnostic summary — NOT the full set
    errors: number;             //   counts over the post-edit document
    warnings: number;
    clean: boolean;
    newOrBlocking: Diagnostic[];//   ONLY the news: diagnostics this edit
  };                            //   INTRODUCED + any blocking ERROR
};
type ToolError = { ok: false; kind: string; detail: string };  // typed, not thrown
```

`health.newOrBlocking` is computed in `core.ts mutate` by diffing the **shared
engine's** pre-edit and post-edit sets (keyed by code + stable location): a key
present after but not before is NEW; a post-edit ERROR is BLOCKING (surfaced even
if pre-existing, because it blocks a faithful render). A pre-existing WARNING the
edit didn't touch is COUNTED but omitted from the detail list — it's ambient
context the LSP already showed, not news. This is the ONLY place full `Diagnostic`
objects enter a tool result, and only for the ones that are news.

The full current set is the **ambient LSP's** job (`publishDiagnostics`) and the
explicit **`diagnose`** debug verb's job — the one tool deliberately allowed to
return the full array, because an agent calls it on purpose for a complete report,
not after every edit.

**Why this matters for the agent loop (review lens #4):** Claude sees a new adverse
effect (`newOrBlocking`) and the inverse in the tool's own reply, AND the full
current picture ambiently from the LSP — without ever being told to "run a
diagnostic command". `apply-op` → compact delta; the editor → full ambient set.

---

## 4. How each surface calls the shared core (no rule reimplemented)

| Surface / op | Calls into the shared core | Reimplements? |
|---|---|---|
| LSP `analyze` (didOpen/didChange) | `fromMlt` → `collectDiagnostics` → source map → LSP diagnostics | no — the engine IS `collectDiagnostics` |
| LSP hover | source map + read the IR clip/track | no |
| LSP references | source map + `query.findReferences({kind:"source"})` | no |
| LSP definition | source map (`shotcut:uuid` property span) | no |
| LSP code action | the diagnostic's `data` + a single-attribute text rewrite on the entry | no — a text repair, not a rule |
| MCP `apply-op` / `undo` | `ops.apply(invocation)` + `collectDiagnostics` (before/after diff) | no — `apply` is the only mutation path |
| MCP `preview-op` | the same as `apply-op`, new state discarded | no |
| MCP `resolve-value-at-frame` | `query.resolveValueAtFrame` | no |
| MCP `find-references` | `query.findReferences` | no |
| MCP `render` / `still` | `driver.render` / `driver.still` (melt, arm's-length subprocess) | no |
| MCP `diagnose` | `collectDiagnostics` + `summarize` (full set — the debug verb) | no |

The payoff (AGENTS.md "the layer model"): a human gesture (a future UI) and an
agent action (an MCP tool) become the SAME op through the SAME `apply`, both get
the same `inverse`, and both update the SAME `.mlt` file the LSP watches — so
ambient diagnostics are correct for either author. The editing logic is built once.

---

## 5. The code-action repair (a worked example)

The seeded defect — a clip window past its source length (`in-out-beyond-source`,
an error) — has a deterministic repair: clamp the out-point to `length-1`. The code
action computes it from the diagnostic's `data.length`, locates the clip's
**`<entry>`** in the source map (the entry, because that's where the played window
lives), and emits a `TextEdit` rewriting just the `out="…"` value. Applying it and
re-analyzing returns an **empty** diagnostic set — the pushed diagnostics clear.
(Rewriting the producer's `out` alone would NOT clear it, because the IR window
comes from the entry — a subtlety the source map's `clipEntries` index captures.)

---

## 6. Defects this Move surfaced + fixed at root cause (cross-surface)

Building + gating the bridge exposed **two** genuine latent inconsistencies, both
the same root-cause family — exactly the kind of cross-surface defect ambient
feedback (and a real undo round-trip) exist to catch. A positionless **color**
generator is always emitted 0-based by the serializer (`in=0, out=len-1,
length=len`), so its window is meaningful only as a *playtime*; any op that resizes
it must re-base to 0-based or the in-memory IR diverges from the serialized form.

**(a) Split.** Splitting a color clip left the tail half with a re-based `length`
(its own played count) but an UN-rebased `out`, so `out ≥ length` tripped the
diagnostics engine's `in-out-beyond-source` rule on a perfectly valid edit.
**Fixed:** `splitEntryAt` re-bases each color split half's window to 0-based
(`[0, playtime-1]`), making `out < length` hold by construction.

**(b) Trim (the C3 finding).** A `trimIn`/`trimOut` on a color clip resized its
window in source space (trimIn +10 → `in=10, out=49`), but the serializer re-bases
it to 0-based (`in=0, out=39`). The op's **scalar inverse** (`trimIn −10`) was
correct in-memory but, after the serialize→reparse **persist** the MCP server does
between `apply-op` and the `undo` tool, computed `newIn = 0 − 10 < 0` and FAILED —
so the inverse the tool returned was a broken undo across persist. **Fixed at root
cause in `src/ops/trim.ts`:** a trim on a positionless color clip validates by
playtime (not by the source-bound `in≥0` / `out<length` checks, which are
meaningless for a generator) and re-bases the window 0-based by playtime
(`in=0, out=playtime−1, length=playtime`) — mirroring the split fix — so the
in-memory IR matches the serialized form and the scalar inverse survives the
persist round-trip.

Both fixes live in the **edit algebra** (NOT papered over in the bridge), are
byte-stable on round-trip with a byte-exact restore-to-original through persist,
keep the render pixel-identical (color clips are content-identical at every frame;
verify:corpus SSIM 1.0000), and keep the full Move-1 op-invariants gate green
(**221/221**, +8 from new color-trim samples). Regression-tested at the edit-algebra
layer (`tests/ops-trim-move.test.ts`: 0-based windows, diagnostic silence,
byte-stable round-trip, in-memory undo, AND serialize→reparse→undo for both trim
verbs) and over the bridge wire (`tests/mcp-tools.test.ts`: the color-split
cleanliness + the trim-undo persist round-trip).

---

## 7. What this Move does NOT build (correctly out of scope)

- **The Claude Code plugin config** that registers `vean-lsp` with diagnostics on
  by default — that is editor/host configuration, not a code deliverable, and is
  documented in the skill instead. The server itself is a conformant LSP a host
  registers like any other.
- **The reference viz layer** (Move 3) — it only needs to *read* the IR + render
  outputs and is unblocked already.
- **Stateful sessions / network / DB** — Hard boundary #3. The "document" is a
  file on disk addressed by a URI; the MCP server reads it, applies the op, writes
  it back. The shared file is what keeps the MCP edit and the ambient LSP in
  lock-step.

See [GATE-MOVE2.md](GATE-MOVE2.md) for the verification.
