import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    rootPath: text("root_path").notNull(),
    title: text("title"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    rootPathUnique: uniqueIndex("projects_root_path_unique").on(table.rootPath),
  }),
);

export const setupChoices = sqliteTable(
  "setup_choices",
  {
    id: text("id").primaryKey(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    source: text("source").notNull().default("cli"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    keyUnique: uniqueIndex("setup_choices_key_unique").on(table.key),
  }),
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(0),
    payloadJson: text("payload_json").notNull().default("{}"),
    resultJson: text("result_json"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedBy: text("locked_by"),
    lockedUntil: text("locked_until"),
    error: text("error"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
  },
  (table) => ({
    statusPriorityIdx: index("jobs_status_priority_idx").on(
      table.status,
      table.priority,
      table.createdAt,
    ),
    lockIdx: index("jobs_lock_idx").on(table.lockedUntil, table.lockedBy),
  }),
);

export const mediaRoots = sqliteTable(
  "media_roots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("raw"),
    path: text("path").notNull(),
    policyJson: text("policy_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectRolePathUnique: uniqueIndex("media_roots_project_role_path_unique").on(
      table.projectId,
      table.role,
      table.path,
    ),
  }),
);

export const mediaAssets = sqliteTable(
  "media_assets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    rootId: text("root_id")
      .notNull()
      .references(() => mediaRoots.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    relativePath: text("relative_path").notNull(),
    kind: text("kind").notNull().default("unknown"),
    sizeBytes: integer("size_bytes"),
    mtimeMs: integer("mtime_ms"),
    // ─── Typed ffprobe facts (the queryable, first-class media-intelligence
    //     columns). `probeJson` keeps the verbatim ffprobe blob; these promote the
    //     load-bearing fields a query/diagnostic actually filters on. All nullable —
    //     a never-probed row, an audio-only file (no width/fps), or a still image
    //     leaves the irrelevant columns null. fps stays RATIONAL [num, den] (never a
    //     float) per the frame-exact invariant; duration is the one inherently
    //     real-valued probe fact (seconds), so it is the single `real` column. ──
    durationSec: real("duration_sec"),
    fpsNum: integer("fps_num"),
    fpsDen: integer("fps_den"),
    width: integer("width"),
    height: integer("height"),
    audioStreams: integer("audio_streams"),
    colorSpace: text("color_space"),
    colorTransfer: text("color_transfer"),
    colorPrimaries: text("color_primaries"),
    /** Short content hash (sha256 prefix) — detects a re-encode / replacement. */
    contentHash: text("content_hash"),
    /** ISO timestamp of the last successful probe (null = never probed). */
    probedAt: text("probed_at"),
    /** @deprecated Superseded by the `media_ranges` table (a whole-asset tag is a
     *  null-bounds range there). Retained for back-compat; no code reads or writes it. */
    labelsJson: text("labels_json").notNull().default("[]"),
    probeJson: text("probe_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectPathUnique: uniqueIndex("media_assets_project_path_unique").on(
      table.projectId,
      table.path,
    ),
    projectKindIdx: index("media_assets_project_kind_idx").on(table.projectId, table.kind),
  }),
);

export const routeAliases = sqliteTable(
  "route_aliases",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    target: text("target").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    projectAliasUnique: uniqueIndex("route_aliases_project_alias_unique").on(
      table.projectId,
      table.alias,
    ),
  }),
);

// ─── Logged ranges (the subclip / keyword / rating / marker primitive) ──────────
// The missing layer between a cataloged file and a clip on the timeline. One flat,
// kind-discriminated table — the FCPXML shape, where a keyword, a rating, and a
// marker are all sibling range-children of an asset. A subclip is a NAMED span; a
// keyword/rating/role/marker/note is a span carrying `value`; a whole-asset tag is a
// null-bounds range. Overlap is expected (one asset → many rows). See DESIGN-MEDIA.md.
export const mediaRanges = sqliteTable(
  "media_ranges",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => mediaAssets.id, { onDelete: "cascade" }),
    /** 'subclip' | 'keyword' | 'rating' | 'marker' | 'role' | 'note' | 'custom'. */
    kind: text("kind").notNull(),
    /** subclip name · keyword text · 'favorite'|'reject' · role · marker/note comment. */
    value: text("value"),
    // INCLUSIVE 0-based frames in the ASSET's OWN rational fps (`fps_num`/`fps_den`),
    // never seconds — honors the frame-exact invariant. NULL/NULL = whole-asset
    // (untimed) tag. A marker is a zero-length range (`in_frame === out_frame`).
    inFrame: integer("in_frame"),
    outFrame: integer("out_frame"),
    /** Optional label / marker / clip color (hex or named). */
    color: text("color"),
    /** Freeform log note. */
    notes: text("notes"),
    /** {source:'human'|'agent'|'auto', tool?, model?, at?} — who/what logged it. */
    provenanceJson: text("provenance_json"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    assetIdx: index("media_ranges_project_asset_idx").on(table.projectId, table.assetId),
    kindValueIdx: index("media_ranges_project_kind_value_idx").on(
      table.projectId,
      table.kind,
      table.value,
    ),
  }),
);

// ─── Media collections (saved-query smart bins) ─────────────────────────────────
// A view, not a location — the Search Bin / Smart Bin / Smart Collection pattern.
// Evaluated live against `media_assets` + `media_ranges` (and, later, the moment index).
export const mediaCollections = sqliteTable(
  "media_collections",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Typed filter (see MediaCollectionQuery in media-ranges.ts): { assetKind?,
    // rangeKind?, value?, ratingAtLeast?, textContains?, durationMinSec? }. Saved live query.
    queryJson: text("query_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameUnique: uniqueIndex("media_collections_project_name_unique").on(
      table.projectId,
      table.name,
    ),
  }),
);
