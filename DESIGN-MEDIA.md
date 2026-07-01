# DESIGN-MEDIA — logged ranges, range-scoped labels, and the media catalog

> Status: **Phase A + B landed** (2026-07-01) — the `media_ranges` /
> `media_collections` schema, migration `0003_media_ranges`, the `src/state/media-ranges.ts`
> layer, the `media.log-range` / `media.label` / `media.rate` / `media.marker` /
> `media.range.*` / `media.collection.*` actions, their CLI + MCP projection, and
> tests are on this branch. Phases C–E (copy/link verbs, content index, IR bridge)
> remain. Extends the **Media routing contract** in [AGENTS.md](AGENTS.md) and the
> deferred-action families in [DESIGN-MOVE3.md](DESIGN-MOVE3.md). Nothing here
> contradicts the local-state contract: files stay on disk; only cache/coordination
> state lives in `.vean/vean.db`.

This doc closes the gap between a *cataloged file* and a *clip on the timeline*:
the **logged range** — a labeled, rated, rational-frame sub-range over a source
asset that you can browse, query, and place, before it is ever edited in. It is
the primitive every professional NLE has and vean does not yet.

## Why (the one-paragraph grounding)

Field research (Premiere, DaVinci Resolve, Final Cut, Palmier, Descript, and the
auto-clip cohort) converges on three facts:

1. **Import stores paths, not bytes.** Reference-by-default is universal; copy is
   an explicit, separate verb (Premiere Ingest/Project Manager, Resolve Clone
   Tool/Media Management, FCP "Copy to library"). vean already does this
   (`scanMediaRoot` links, never copies) and has a *stronger* identity than any
   of them — a real `content_hash`, not filename+timecode+reel.
2. **Labels attach to ranges, and one clip carries many overlapping ones.** Final
   Cut is the reference model: keywords, favorite/reject ratings, and roles all
   attach to *time ranges*, and **FCPXML serializes them** as
   `<keyword start="…s" duration="…s" value="…"/>` — rational-time ranges over an
   asset. That maps exactly onto vean's frame-exact rational-time invariant.
3. **The agent-native shift is content-addressing.** Descript ("transcript is the
   substrate") and Palmier (`search_media` visual+spoken → source-second ranges →
   trims) turn raw media into a searchable, labeled *moment index* the timeline is
   downstream of. Their scores/labels are static and opaque; vean's can be
   **recomputable and diagnosable** — the moat.

vean's differentiators to preserve throughout: **link-by-path, typed/diagnosable
IR, consequences-before-render, git-native text, provenance-survives-export.**

## What exists today (grounded)

- **Catalog:** `media_roots`, `media_assets`, `route_aliases`
  ([schema.ts:68–157](src/state/schema.ts)); `scanMediaRoot` /
  `probeAndCatalogAsset` link + probe, never copy ([media.ts](src/state/media.ts)).
- **Identity:** `content_hash` (sha256 prefix) + typed ffprobe facts
  (`duration_sec`, rational `fps_num`/`fps_den`, resolution, colorspace).
- **Actions:** `media.root.*`, `media.scan`, `media.probe`, `media.list`,
  `media.find` (path `LIKE` only), `route.*` ([registry.ts](src/actions/registry.ts)).
- **Provenance:** first-class IR field, survives export as `vean:provenance.*`.
- **A latent, unused `labels_json` column** on `media_assets`
  ([schema.ts:125](src/state/schema.ts:125)) — nothing reads or writes it.
- **Clips reference media by `resource` path**, not by an asset id
  ([ir/types.ts](src/ir/types.ts)).

**The gap:** no logged range / subclip; no label/rating/marker write; no saved
queries; no content search; no bin-read surface; no asset↔clip bridge.

## The data model

Two new tables in `.vean/vean.db`, owned by `src/state/`, migrated by committed
SQL under `drizzle/`. `labels_json` is deprecated (kept for back-compat, stops
pretending to be a feature — whole-asset tags become an untimed range, below).

### `media_ranges` — the logged-range / label / rating / marker primitive

One flat, kind-discriminated table — the FCPXML shape, where keyword, rating, and
marker are all sibling range-children of an asset. A **subclip** is a named range;
a **keyword/rating/role** is a range carrying a value; a **marker** is a
zero-length range; a **whole-asset tag** is a range with null bounds. Overlap is
allowed and expected (one asset → many rows).

```ts
export const mediaRanges = sqliteTable(
  "media_ranges",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    assetId: text("asset_id").notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    // 'subclip' | 'keyword' | 'rating' | 'marker' | 'role' | 'note' | 'custom'
    kind: text("kind").notNull(),
    // subclip name · keyword text · 'favorite'|'reject' · role · marker comment
    value: text("value"),
    // INCLUSIVE 0-based frames in the ASSET's own rational fps. NULL/NULL =
    // whole-asset (untimed) tag. marker: inFrame == outFrame. Never seconds.
    inFrame: integer("in_frame"),
    outFrame: integer("out_frame"),
    color: text("color"),          // optional label/marker/clip color
    notes: text("notes"),          // freeform log note
    // who/what created it: {source:'human'|'agent'|'auto', tool?, model?, at?}
    provenanceJson: text("provenance_json"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    assetIdx: index("media_ranges_project_asset_idx").on(table.projectId, table.assetId),
    kindValueIdx: index("media_ranges_project_kind_value_idx")
      .on(table.projectId, table.kind, table.value),
  }),
);
```

**Rational-time rule (load-bearing).** `inFrame`/`outFrame` are integer frames in
the asset's own fps (`fps_num`/`fps_den` already on `media_assets`). This honors
the frame-exact invariant and is *stronger* than FCPXML's rational-seconds
(no float fps anywhere). When a logged range is placed on a timeline whose fps
differs, the placement op converts frames rationally — never through a float.

### `media_collections` — saved queries (smart collections / search bins)

A view, not a location — the Search Bin / Smart Bin / Smart Collection pattern.
Evaluated live against `media_assets` + `media_ranges` (and, later, the moment
index).

```ts
export const mediaCollections = sqliteTable(
  "media_collections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // typed filter: { assetKind?, rangeKind?, value?, ratingAtLeast?,
    //   textContains?, colorspace?, durationMin?, ... } — ANDed groups
    queryJson: text("query_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameUnique: uniqueIndex("media_collections_project_name_unique")
      .on(table.projectId, table.name),
  }),
);
```

### The asset↔clip bridge (a decision — recommend derive-first)

Today a clip's `resource` is a raw path. To let relink/offline diagnostics and
"which logged ranges are used" flow end-to-end:

- **Now (no IR change):** derive the link by resolving `clip.resource` against
  `media_assets.path` / `content_hash`. Zero serializer risk; works immediately.
- **Later (IR change, deferred):** add optional `assetId` to the `Clip` type,
  serialized as a `vean:asset.id` producer property (exactly like provenance) so
  it survives export. Only if derive-by-path proves insufficient.

## The actions

Registered in `src/actions/`, projected to CLI/MCP (and later Tauri) — same shape
as the existing media actions ([registry.ts:1724](src/actions/registry.ts:1724)).
The three you named are fully specced; companions follow the same mold.

### `media.log-range` — create a subclip / logged range

```ts
action({
  id: "media.log-range",
  title: "Log a media range",
  description: "Create a named sub-range (subclip) over a cataloged asset — shared bytes, its own in/out.",
  input: z.object({
    repo: z.string().optional(),
    asset: z.string(),                 // asset id, path, or route alias
    in: z.number().int().nonnegative(),
    out: z.number().int().nonnegative(),
    name: z.string().optional(),
    notes: z.string().optional(),
    color: z.string().optional(),
  }),
  output: z.unknown(),                 // the media_ranges row
  scopes: ["media:write", "state:write"],
  effect: {
    kind: "stateWrite", mutates: ["projectState"], openWorld: false,
    destructive: false, idempotency: "idempotent", reversibility: "snapshot",
    dryRun: "none", approval: "ask", audit: "metadata",
    job: { mode: "inline", cancellable: false, retrySafe: true },
  },
  surfaces: { cli: { command: "media log-range" }, mcp: { name: "media-log-range" } },
  // execute → resolve asset, clamp in/out to [0, durationInFrames], insert kind:'subclip'
})
```

Bounds handling (as built): in/out are ordered and **clamped to the asset's probed
frame count**, and a range starting entirely past the last frame is **rejected at
action time** (`clampRange` in [media-range-math.ts](src/state/media-range-math.ts),
a pure module unit-tested in `tests/media-range-math.test.ts`). Placement of a range
onto a timeline is separately covered by the IR's own out-of-range clip diagnostics,
so no standing catalog diagnostic is needed.

### `media.label` — attach a keyword / rating / role / marker to an asset or range

```ts
action({
  id: "media.label",
  title: "Label media",
  description: "Attach a range-scoped (or whole-asset) keyword, rating, role, or marker.",
  input: z.object({
    repo: z.string().optional(),
    asset: z.string(),                 // asset id, path, or route alias
    kind: z.enum(["keyword", "rating", "role", "marker", "note"]),
    value: z.string(),                 // keyword · 'favorite'|'reject' · role · comment
    in: z.number().int().nonnegative().optional(),   // omit both → whole-asset tag
    out: z.number().int().nonnegative().optional(),
    color: z.string().optional(),
  }),
  output: z.unknown(),
  scopes: ["media:write", "state:write"],
  effect: { /* stateWrite, idempotent (upsert by asset+kind+value+span), approval: "ask" */ },
  surfaces: { cli: { command: "media label" }, mcp: { name: "media-label" } },
})
```

This is the write path that finally makes `labels_json` obsolete. Sugar aliases
(`media.rate` → kind:'rating', `media.marker` → kind:'marker') are optional thin
wrappers, not new tables.

### `media.collection.save` — save a smart collection (saved query)

```ts
action({
  id: "media.collection.save",
  title: "Save a media collection",
  description: "Save a named live query over the catalog (the Smart Bin / Search Bin pattern).",
  input: z.object({
    repo: z.string().optional(),
    name: z.string(),
    query: z.object({
      assetKind: z.enum(["video", "audio", "image", "timeline"]).optional(),
      rangeKind: z.string().optional(),
      value: z.string().optional(),        // keyword/role match
      ratingAtLeast: z.enum(["favorite"]).optional(),
      textContains: z.string().optional(), // path/notes now; transcript later
      durationMinSec: z.number().optional(),
    }).passthrough(),
  }),
  output: z.unknown(),
  scopes: ["state:write"],
  effect: { /* stateWrite, idempotent upsert by (project, name), approval: "ask" */ },
  surfaces: { cli: { command: "media collection save" }, mcp: { name: "media-collection-save" } },
})
```

### Companion actions (same mold, one-line specs)

| Action | Purpose | Effect |
|---|---|---|
| `media.range.list` / `media.range.remove` | Read ranges by asset / kind / value; delete one by id | stateRead / stateWrite |
| `media.collection.list` | List saved collections | stateRead |
| `media.collection.resolve` | Evaluate a collection → matching assets/ranges (the **bin read**) | stateRead |
| `media.add` | Catalog a single file by path (link + probe) — sugar over root+scan | update |
| `media.import` | Explicit **copy** into a route (`--copy`, dest alias) — Clone-Tool equivalent | update, `fs:write` |
| `media.consolidate` | Copy *used* media to a route (Collect / Consolidate-and-Transcode) | update, later |
| `media.relink` | Re-resolve a dangling asset by `content_hash`/name | update |
| `media.search` | **Content search** (transcript + semantic) → ranges — *deferred* | update, job |
| `media.proxy` | Attach/generate a proxy (`transcode.ts` stub exists) — *deferred* | update, job |

### CLI / MCP projection

```
vean media log-range <asset> --in <f> --out <f> [--name ..] [--notes ..]
vean media label <asset> --kind keyword --value "interview" [--in <f> --out <f>]
vean media rate <asset> --favorite | --reject [--in <f> --out <f>]
vean media collection save <name> --query-json '{...}'
vean media collection resolve <name> --json          # the bin read
vean media range list [--asset <id>] [--kind keyword] --json
vean media import <path> [--copy --dest media:proxy] --json
```

MCP names mirror the ids (`media-log-range`, `media-label`, `media-collection-save`,
…), generated from the registry per the action-runtime contract. LSP stays
narrow — labels/collections are CLI/MCP/app actions, not code actions.

## Copy vs link (explicit verbs, never on scan)

`scanMediaRoot` continues to **link only**. Copying is opt-in:

- `media.import --copy --dest <route>` — the Premiere-Ingest-Copy / Resolve
  Clone-Tool equivalent (relocate originals, catalog the copies).
- `media.consolidate --dest <route> [--used-only] [--handles <f>]` — the Project
  Manager Collect / Consolidate-and-Transcode equivalent, for portable bundles.
- Transcode-on-import and proxy generation ride the deferred `media.proxy` /
  transcode job — not a scan side-effect.

## Content-addressing (the agent-native superpower, deferred)

Once the designed whisper.cpp transcript job and on-device embeddings land (both
deferred per DESIGN-MOVE3), `media.search` turns "find where she mentions the
budget" / "the wide harbor shot" into **rational-frame ranges** ready to place —
the Palmier `search_media` / Descript transcript-substrate model. Because vean
has diagnostics, these results are *recomputable and inspectable*, not a static
opaque score. The moment index writes `media_ranges` rows (kind:'auto') with
`provenanceJson.source = 'auto'`, so agent/auto/human labels are distinguishable
and auditable.

## What we deliberately don't build (skip-but-useful)

- **Interchange export** (`export_as_fcp_xml` / AAF / EDL) — a *later* interop
  bridge, not core. FCP's lesson: the serializable document *is* the integration
  surface; vean's `.mlt` + typed ranges already are that.
- **XMP sidecar write** — labels live in `.vean/vean.db`; writing them into file
  XMP (so they travel to other tools) is a portability nicety, deferred.
- **In-core generation** (`generate_video/image/audio`) — stays out of the
  stateless core; generation is a deferred, network-isolated *job* that emits
  import-with-provenance clips (which, unlike Palmier's lossy `.palmier`→XML,
  survive export).
- **Social publish / scheduling** — out of domain.

## Build plan (a Move, phased behind gates)

- **A — schema (done ✓):** `media_ranges` + `media_collections` Drizzle models +
  committed migration `0003_media_ranges`; state fns in `src/state/media-ranges.ts`;
  `labels_json` deprecated.
- **B — actions (done ✓):** `log-range`, `label` (+`rate`/`marker` sugar),
  `range.list`/`range.remove`, `collection.save`/`list`/`resolve` + CLI + MCP
  projection + stable tests (`cli-media-ranges`, `media-range-math`); bounds
  clamped/validated at action time.
- **C — copy/link verbs:** `media.import --copy`, `media.consolidate`,
  `media.relink`.
- **D — content index (deferred):** wire whisper transcript + embeddings →
  `media.search` → ranges.
- **E — decisions:** asset↔clip IR bridge (if derive-by-path proves insufficient);
  the app's bin-read surface over `media.collection.resolve`.

**Gates (A + B, green):** stable JSON for every action via the CLI subprocess
(`tests/cli-media-ranges.test.ts`); pure frame-math unit tests
(`tests/media-range-math.test.ts`) pin the clamp/round-trip; collection query eval
is deterministic; full suite + `typecheck` + `biome` pass.

## Open decisions (need a call)

1. **asset↔clip bridge:** derive-by-path now vs. explicit serialized `assetId`
   later. *Recommend derive-first.*
2. **Whole-asset tags:** null-bounds range (kills `labels_json`) vs. keep
   `labels_json`. *Recommend null-bounds range; deprecate the column.*
3. **`kind` taxonomy:** fixed enum + `'custom'` vs. open string. *Recommend fixed
   enum + `'custom'`.*
4. **Placing a logged range:** should `media.log-range` output feed directly into
   an existing append/overwrite op (place this subclip)? *Recommend yes — the
   range carries the in/out the op needs.*
5. **Content-search sequencing:** gated behind whisper.cpp live wiring (currently
   fixture-only). Confirm it stays in Phase D.
