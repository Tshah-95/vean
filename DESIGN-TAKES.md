# DESIGN — Takes (scene variations / auditions)

Status: design sketch, not scheduled into a Move yet. Driven by a live need in
`projects/carlo-demo` (2026-07-12): every scene of a piece has multiple
candidate treatments, and the human wants to flip between them **on the
timeline, while previewing**, the way the storyboard's tabs let them flip
between interface ideas.

## Prior art

- **Final Cut Pro "Auditions"** — the canonical design. A clip position holds a
  *container* of alternates with one active "pick"; the container previews in
  place, the editor cycles picks, and the timeline behaves as if only the pick
  existed. This is the shape to reimplement.
- **DaVinci Resolve "Take Selector"** — same idea, one clip slot stacks takes;
  opened via right-click on the clip.
- **Premiere Pro** — no first-class equivalent (users fake it with stacked
  muted tracks); the gap is part of why this feature matters.
- Right-click on timeline clips is a heavily-used surface in all three NLEs —
  a "Takes ▸" context-menu group on a clip fits convention.

## Data model (IR)

A take set is a property of a **clip slot**, not a new entity kind:

```ts
type TakeSet = {
  activeId: string;
  options: Array<{
    id: string;            // "A", "B", …
    label: string;         // 3–5 word concept name
    resource: string;      // file path or composition ref
    composition?: { id: string }; // live Remotion overlay, same as today
  }>;
};
// Clip gains: takes?: TakeSet — the clip's own resource/composition MUST equal
// the active option (denormalized on purpose: any MLT consumer that knows
// nothing about takes renders the pick correctly).
```

Serialization: app-namespaced properties on the producer/entry
(`vean:takes`, JSON-encoded), like Shotcut's `shotcut:*` extras — round-trips
through Shotcut/Kdenlive untouched, invisible to melt. The denormalization
rule makes the `.mlt` valid for every non-vean consumer by construction.

## Ops (edit algebra)

- `takes.add(clipId, option)` / `takes.remove(clipId, optionId)`
- `takes.select(clipId, optionId)` — swaps the clip's resource/composition to
  the option; consequences: resource change on [in,out]; inverse: select(prev).
- Diagnostics: active option missing from `options` → error; option resource
  absent on disk → warning (same class as any missing resource); option
  duration ≠ slot duration → error (takes differ in content, never length —
  length changes are a ripple edit, a different op).

## Surfaces

- **CLI**: `vean takes list|add|select|remove` (+ `vean action run takes.*`).
- **LSP**: code action "Select take…" on the clip's line in the `.mlt`;
  find-references lists all options' resources.
- **Viewer / app**: chip on the clip (`A · 3 takes`); click → popover strip of
  options (label + hover-scrub thumbnail); right-click clip → "Takes ▸ …".
  Selecting re-binds the preview player's overlay live (same `@project-comp`
  HMR path as today's live compositions).
- **MCP**: `takes-select` etc. for agent-driven review sessions.

## The bridge (works today, no core changes)

`projects/carlo-demo` implements takes at the FILE level: each scene is a
folder of variant comps (`P.tsx`, `A.tsx`, `B.tsx` + a `VARIANTS` registry),
every variant registers as `<Comp>-<takeId>`, and a trunk-owned `takes.ts`
map binds one take per scene in `build-timeline.ts`. Switching = one-letter
edit + rebuild. That convention is the migration target: when `takes.select`
lands, the folder registry becomes the `options` list and `takes.ts` becomes
`activeId` — nothing about the comp files changes.

## Open questions

- Nested auditions (take of a take)? FCP says no; start with no.
- Should `takes.select` re-bake stale overlay caches eagerly or lazily?
  (Today's export auto-bake suggests lazily.)
- Group-level takes (one pick that swaps N clips together — e.g. a scene's
  overlay + its audio)? Real need for VO alternates; sketch after the basic op.
