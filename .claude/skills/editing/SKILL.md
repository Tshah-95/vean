---
name: editing
description: How to edit a vean timeline as an agent — drive the .mlt through the MCP/CLI domain tools (apply-op / preview-op / undo / render / still), trust the ambient vean-lsp for diagnostics (never poll diagnose in the loop), read each tool's consequences + inverse + compact health, and use render→still as your eyes. Use when making any change to a .mlt document through the bridge (apply an op, fix a diagnostic, tighten a cut, duck audio, add a dissolve).
---

# Editing a vean timeline (the agent method)

The first real vean skill, written from the Move-2 build. It encodes the method
the agent bridge was *designed* for: **edit a timeline the way you edit code.**
The language server tells you what broke — ambiently, without being asked. The
domain tools tell you what each change did and how to take it back. The
render→still loop is your eyes, because you cannot watch video.

If you take one thing from this skill: **don't confuse the three surfaces.** They
have three different jobs, and blurring them is the one regression the whole
design exists to prevent.

| Surface | What it is | What it's for | How you reach it |
|---|---|---|---|
| **`vean-lsp`** | ambient feedback | *seeing* — pushes the FULL current diagnostic set after every document change | runs in your editor/host; you read its diagnostics, you don't call it |
| **`vean-mcp` tools** | domain actions | *doing* — apply/preview/undo an op, resolve a value, find references, render, still | MCP tools, or the `bun run …` CLI twins |
| **`diagnose`** | a debug verb | a deliberate full report (CI gate, sanity sweep) — **not** the per-edit loop | the `diagnose` tool / `bun run diagnose <file>` |

## The mental model

A `.mlt` is a *document*. vean is a *language server for video* over it. The loop:

```
  apply an op  ──►  read the result (consequences · inverse · compact health)
       │                                   │
       │              ambient: vean-lsp re-publishes the full diagnostic set
       │              for the changed file — you didn't ask, you just see it
       ▼                                   ▼
  render + still  ──►  READ the PNG  ──►  iterate, or undo (it's free + exact)
```

The payoff of doing it this way: an op carries its own *inverse*, so exploration
is reversible; the LSP carries the full picture, so a tool reply can stay a
compact delta instead of flooding you on every call; and a still is a real frame,
so "the diagnostics are clean" never gets mistaken for "the cut looks right."

## The loop, step by step

1. **Mutate with an op, never by hand-editing XML.** The only legal mutation path
   is an op through the edit algebra (`apply-op` tool, or `bun run edit`). An op
   is `{ op, args }` — e.g. `{ op: "trimIn", args: { uuid: "<clip-uuid>", delta: 10 } }`,
   `{ op: "gain", args: { uuid: "<clip-uuid>", db: -6 } }`, `{ op: "dissolve",
   args: { leftUuid, rightUuid, frames: 20 } }`. Hand-editing the `.mlt` desyncs
   clip identity and the played-window bookkeeping the diagnostics engine reads —
   the ops exist precisely so you don't reason about that by hand.
   - **Refer to a clip by its stable uuid, not its index.** Indices are ephemeral;
     a uuid is the identity that survives the edit and that the inverse names.

2. **Read the ToolResult before you render.** Every mutating tool returns four
   fields — read them in this order:
   - **`consequences`** — the structured "what changed": which clips trimmed/moved,
     whether a ripple shifted downstream clips, the duration delta, any warnings.
     This is the *report before a frame renders* — the whole reason the ops layer
     exists. Read it to confirm the edit did what you intended (e.g. that a trim
     rippled the clips you expected and nothing else).
   - **`health`** — a *compact* summary, not the full set: `errors`, `warnings`,
     `clean`, and `newOrBlocking`. **`newOrBlocking` is the list to act on**: it
     holds exactly the diagnostics this edit *introduced* plus any pre-existing
     ERROR that blocks a faithful render. A warning that already existed and you
     didn't touch is *counted* but deliberately *not* dumped here — that's ambient
     context the LSP already showed you, not news. **If `newOrBlocking` is
     non-empty, you broke (or left) something — resolve it before you render.**
   - **`inverse`** — the op invocation that undoes this exact edit. Keep it; it's
     how you take the edit back (step 6).
   - **`touchedUris`** — which document(s) changed (so you re-read them; the LSP
     re-publishes for them).

3. **Let the LSP show you the rest — don't poll `diagnose`.** After the edit
   writes the file, `vean-lsp` re-publishes the complete current diagnostic set for
   that document. New adverse effects appear in your context *ambiently*, the same
   way a type error does after you save a `.ts` file. **Calling `diagnose` after an
   ordinary edit is the anti-pattern this design forbids** — `diagnose` is for a
   deliberate full report (a CI gate, a one-off audit, a non-LSP client), never the
   safety step that makes an edit loop OK. The compact `health` from the tool plus
   the ambient set from the LSP together are the full picture.

4. **Prefer `preview-op` when you're unsure or comparing.** `preview-op` returns
   the *same* consequences + inverse + compact health a real edit would produce,
   **without** writing the document. Reach for it when:
   - the op might fail a precondition and you want to see the typed error first;
   - you're choosing between two candidate edits (preview both, compare the
     consequences/health, then `apply-op` the winner);
   - the op ripples and you want to confirm the blast radius before committing.

   Reach straight for `apply-op` when the edit is unambiguous and you'll inspect
   the rendered frame next anyway — undo is exact, so a wrong `apply-op` is cheap
   to reverse.

5. **SEE the frame — non-negotiable for anything perceptual.** A clean diagnostic
   set is the type-checker passing; it is **not** proof the cut *looks* right.
   `render` the document to an MP4, then `still` the exact 0-based frame at the
   moment you changed (both return the produced file in `touchedUris` — read that
   PNG). For a fade, dissolve, or any motion, grab stills at a few frames across
   the transition so you see the arc, not a single instant. Judge feel from the
   pixels, not from the absence of diagnostics.

6. **Undo is free and exact.** Pass a prior result's `inverse` to the `undo` tool
   (or `bun run undo`); it restores the prior IR deep-equal and re-publishes the
   cleared diagnostics. This is what makes exploration cheap — try the tighter cut,
   render it, keep it or undo it. (One caveat: an op that *mints* a new uuid —
   `split`'s left half — names that in-session uuid in its inverse, so undo it
   within the session, before a serialize→parse reload renames it.)

## How code actions fit (auto-fixing a diagnostic)

A diagnostic that has a single deterministic repair exposes an **LSP code action**
— a previewable text edit your host offers as a quick-fix. When the ambient LSP
flags one of these, *prefer the code action over hand-fixing*: it edits the right
byte, and applying it fires the same `didChange → publishDiagnostics` loop, so the
flagged diagnostic clears with no extra step. The three repairs that exist today:

- **`in-out-beyond-source`** (a clip's played window runs past its source length)
  → *"Trim out-point to N"* — clamps the clip's `<entry>` out-point to `length-1`.
- **`transition-inverted-window`** (a field transition's in > out) → *"Swap the
  transition window"*.
- **`transition-no-overlap`** (the transition starts past the track's content)
  → clamps it onto the last content frame.

Two judgment points the design draws sharply:
- **A quick-fix is self-contained; a *choice* is not.** Defects that need a human
  decision or a structural rewrite — relinking a missing asset to a *new* path,
  picking a ripple direction, re-timing a same-track dissolve and its nested
  tractor — are **not** code actions. They're your job through `apply-op`. Don't
  wait for a quick-fix that won't come; make the call and apply the op.
- A code action only exists for a defect the LSP can *see*, which means the
  document parsed. A defect that makes the IR itself invalid surfaces as a
  parse-error, not a fixable diagnostic.

## Hard rules (the ones that bite)

- **Timeline window vs source window.** A clip's *timeline* (played) window lives
  in its `<entry>`; its *source* window lives in the `<producer>`. A diagnostic
  about a played-window problem (e.g. `in-out-beyond-source`) is fixed by changing
  the **entry** — that's where the IR reads `[in, out]`. Rewriting the producer
  alone won't clear it. (The code action knows this; if you ever hand-fix, fix the
  entry.)
- **Ops refuse to write an invalid state — and that's correct.** An op whose
  precondition fails (a trim past source, a clip uuid that doesn't exist, a
  dissolve longer than its clips) returns a *typed* `ToolError` (`kind` +
  `detail`), **not** a thrown exception and **not** a silently bad edit. Read the
  `kind`, pick a valid argument or a different op. Don't try to force it.
- **Color clips are positionless.** Their `in`/`out` are 0-based by convention and
  a split re-bases them to `[0, playtime-1]`. Don't reason about a color clip's
  window as if it indexed a file — it doesn't.
- **Frame-exact integers only.** Never introduce a float frame or a float fps —
  one float makes every downstream diagnostic subtly, permanently wrong. fps is
  `[num, den]` (29.97 is `30000/1001`).
- **Never reimplement a diagnostic in the loop.** If a check seems missing, it
  belongs in `src/diagnostics/` (called by every surface) — never inline in a tool
  call or worked around in the edit. That's a hard project boundary, not a style
  note.

## Reading consequences, inverse, and health (a worked shape)

```jsonc
// apply-op { op: "trimIn", args: { uuid: "clip-3", delta: 10 } } →
{
  "ok": true,
  "consequences": { /* clip-3 trimmed +10 in; downstream rippled; durationDelta… */ },
  "inverse": { "op": "trimIn", "args": { "uuid": "clip-3", "delta": -10 } },  // ← undo with this
  "touchedUris": ["file:///…/cut.mlt"],
  "health": {
    "errors": 0, "warnings": 1, "clean": false,
    "newOrBlocking": []   // ← empty: the 1 warning is pre-existing ambient context, not from this edit
  }
}
```

`newOrBlocking: []` with a non-zero `warnings` count means *you didn't introduce
anything* — the warning is the LSP's standing context. Had the trim pushed a clip
past its source, that error would appear in `newOrBlocking` (and you'd fix it, or
undo, before rendering). The full warning detail is the ambient LSP's to show — the
tool stays a compact delta on purpose.

## CLI twins (when there's no MCP host)

Every MCP tool has a `bun run` twin for scripting or a non-LSP context. Note:
without an LSP host you lose the ambient push — the CLI prints the consequence +
inverse, and you reach for `bun run diagnose <file>` *deliberately* for the full
set (this is the legitimate non-LSP use of `diagnose`, not per-edit polling).

| Tool | CLI |
|---|---|
| apply-op | `bun run edit <in.mlt> <op> <json-args> [out.mlt]` |
| preview-op | `bun run preview-op <file.mlt> <op> <json-args>` |
| undo | `bun run undo <in.mlt> <op> <json-args>` |
| render | `bun run render <file>` |
| still | `bun run still <file> <frame>` |
| resolve-value-at-frame | `bun run resolve …` |
| find-references | `bun run refs …` |
| diagnose (debug only) | `bun run diagnose <file>` |

## Registering the LSP with a host (one-time)

`vean-lsp` is a conformant stdio language server (`bun run lsp`, or the `vean-lsp`
bin). A host (Claude Code, VS Code) registers it for the `.mlt` language with
diagnostics enabled; after that the push happens automatically on
`didOpen`/`didChange`. There is **no** vean-specific polling protocol — if your
host speaks LSP, you get ambient vean diagnostics, hover (the effective value of a
parameter at a frame), references, definition, and code actions for free.

## Verifying your own work (the gate)

`bun run move2:e2e` runs the whole loop end-to-end (op → ambient clean → render →
still) over seeded tasks and asserts the tool-output discipline — run it after any
bridge change. The standing gates are `bun run test`, `bun run typecheck`,
`bun run lint`, `bun run lint:xml`, and `bun run verify:corpus`.
