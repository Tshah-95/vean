// Logged ranges, range-scoped labels, and saved-query collections — the layer
// between a cataloged file and a clip on the timeline. See DESIGN-MEDIA.md.
//
// A logged range is one row in `media_ranges`: a rational-frame sub-range over a
// source asset carrying a kind (subclip/keyword/rating/marker/role/note) and an
// optional value. NULL/NULL bounds = a whole-asset (untimed) tag. Frames are in the
// ASSET's own rational fps and are validated/clamped against the probed frame count
// when it is known (video with duration + fps); unprobed / image / fps-less audio
// assets accept the given bounds as-is.
//
// State-layer discipline (mirrors media.ts): short-lived handles, no transaction held
// across I/O, files on disk stay the source of truth.

import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { and, eq, like, or, sql } from "drizzle-orm";
import { openStateDb } from "./db";
import { clampRange, assetFrameCount as frameCountFrom } from "./media-range-math";
import { initializeProject } from "./project";
import { mediaAssets, mediaCollections, mediaRanges, routeAliases } from "./schema";

export type MediaRangeRecord = typeof mediaRanges.$inferSelect;
export type MediaCollectionRecord = typeof mediaCollections.$inferSelect;
export type MediaAssetRow = typeof mediaAssets.$inferSelect;

/** The closed set of range kinds. `custom` is the open escape hatch. */
export const RANGE_KINDS = [
  "subclip",
  "keyword",
  "rating",
  "marker",
  "role",
  "note",
  "custom",
] as const;
export type RangeKind = (typeof RANGE_KINDS)[number];

export type LogRangeInput = {
  /** Asset id, absolute/project-relative path, or a `scheme:target` route alias. */
  asset: string;
  in: number;
  out: number;
  name?: string;
  notes?: string;
  color?: string;
  provenance?: RangeProvenance;
};

export type LabelInput = {
  asset: string;
  kind: Extract<RangeKind, "keyword" | "rating" | "role" | "marker" | "note" | "custom">;
  value: string;
  /** Omit both to tag the whole asset (untimed). */
  in?: number;
  out?: number;
  color?: string;
  notes?: string;
  provenance?: RangeProvenance;
};

export type RangeProvenance = {
  source: "human" | "agent" | "auto";
  tool?: string;
  model?: string;
  at?: string;
};

export type RangeFilter = {
  /** Asset id, path, or route alias — resolved to a single asset. */
  asset?: string;
  kind?: RangeKind;
  value?: string;
};

/** A saved live query — the Smart Bin / Search Bin filter. All fields AND together. */
export type MediaCollectionQuery = {
  assetKind?: "video" | "audio" | "image" | "timeline";
  rangeKind?: RangeKind;
  value?: string;
  ratingAtLeast?: "favorite";
  /** Substring match over the asset's relative path and its ranges' value/notes. */
  textContains?: string;
  durationMinSec?: number;
};

export type CollectionResolution = {
  collection: MediaCollectionRecord;
  query: MediaCollectionQuery;
  assets: MediaAssetRow[];
  ranges: MediaRangeRecord[];
};

function nowIso(): string {
  return new Date().toISOString();
}

/** Probed frame count in the asset's own fps, or null when it can't be derived. */
export function assetFrameCount(asset: MediaAssetRow): number | null {
  return frameCountFrom(asset.durationSec, asset.fpsNum, asset.fpsDen);
}

/**
 * Resolve an asset reference (id | absolute path | project-relative path |
 * relative_path | `scheme:target` route alias) to one cataloged asset row, or throw.
 */
function resolveAssetRef(
  handle: ReturnType<typeof openStateDb>,
  projectId: string,
  rootPath: string,
  ref: string,
): MediaAssetRow {
  const rows = handle.db
    .select()
    .from(mediaAssets)
    .where(eq(mediaAssets.projectId, projectId))
    .all();

  // 1) exact id
  const byId = rows.find((r) => r.id === ref);
  if (byId) return byId;

  // 2) route alias `scheme:target` → resolve to a path, then match
  let candidate = ref;
  if (ref.includes(":") && !isAbsolute(ref)) {
    const alias = handle.db
      .select()
      .from(routeAliases)
      .where(and(eq(routeAliases.projectId, projectId), eq(routeAliases.alias, ref)))
      .get();
    if (alias?.target) candidate = alias.target;
  }

  // 3) exact absolute path
  const abs = isAbsolute(candidate) ? candidate : resolve(rootPath, candidate);
  const byPath = rows.find((r) => r.path === abs || r.path === candidate);
  if (byPath) return byPath;

  // 4) relative_path exact, then suffix
  const byRel =
    rows.find((r) => r.relativePath === ref) ??
    rows.find((r) => r.relativePath.endsWith(ref) || r.path.endsWith(ref));
  if (byRel) return byRel;

  throw new Error(`no cataloged asset matches "${ref}"`);
}

/** Clamp/validate a requested [in,out] against the asset's known bounds. */
function boundRange(
  asset: MediaAssetRow,
  inFrame: number,
  outFrame: number,
): { in: number; out: number } {
  return clampRange(inFrame, outFrame, assetFrameCount(asset));
}

/** Create a named subclip (a logged range, kind='subclip'). */
export function createLoggedRange(repo: string, input: LogRangeInput): MediaRangeRecord {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    const asset = resolveAssetRef(handle, project.id, project.rootPath, input.asset);
    const { in: lo, out: hi } = boundRange(asset, input.in, input.out);
    const row = {
      id: randomUUID(),
      projectId: project.id,
      assetId: asset.id,
      kind: "subclip" as const,
      value: input.name ?? null,
      inFrame: lo,
      outFrame: hi,
      color: input.color ?? null,
      notes: input.notes ?? null,
      provenanceJson: input.provenance ? JSON.stringify(input.provenance) : null,
    };
    return handle.db.insert(mediaRanges).values(row).returning().get();
  } finally {
    handle.sqlite.close();
  }
}

/** Attach a keyword / rating / role / marker / note to an asset or a range of it. */
export function addMediaLabel(repo: string, input: LabelInput): MediaRangeRecord {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    const asset = resolveAssetRef(handle, project.id, project.rootPath, input.asset);
    const timed = input.in != null || input.out != null;
    const bounds = timed
      ? boundRange(asset, input.in ?? 0, input.out ?? input.in ?? 0)
      : { in: null as number | null, out: null as number | null };
    const row = {
      id: randomUUID(),
      projectId: project.id,
      assetId: asset.id,
      kind: input.kind,
      value: input.value,
      inFrame: bounds.in,
      outFrame: bounds.out,
      color: input.color ?? null,
      notes: input.notes ?? null,
      provenanceJson: input.provenance ? JSON.stringify(input.provenance) : null,
    };
    // Idempotent-ish: an identical (asset,kind,value,span) tag isn't duplicated.
    const existing = handle.db
      .select()
      .from(mediaRanges)
      .where(
        and(
          eq(mediaRanges.projectId, project.id),
          eq(mediaRanges.assetId, asset.id),
          eq(mediaRanges.kind, input.kind),
          eq(mediaRanges.value, input.value),
        ),
      )
      .all()
      .find((r) => r.inFrame === row.inFrame && r.outFrame === row.outFrame);
    if (existing) {
      handle.db
        .update(mediaRanges)
        .set({ color: row.color, notes: row.notes, updatedAt: nowIso() })
        .where(eq(mediaRanges.id, existing.id))
        .run();
      const updated = handle.db
        .select()
        .from(mediaRanges)
        .where(eq(mediaRanges.id, existing.id))
        .get();
      return updated ?? existing;
    }
    return handle.db.insert(mediaRanges).values(row).returning().get();
  } finally {
    handle.sqlite.close();
  }
}

export function listMediaRanges(repo: string, filter: RangeFilter = {}): MediaRangeRecord[] {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    const conds = [eq(mediaRanges.projectId, project.id)];
    if (filter.asset) {
      const asset = resolveAssetRef(handle, project.id, project.rootPath, filter.asset);
      conds.push(eq(mediaRanges.assetId, asset.id));
    }
    if (filter.kind) conds.push(eq(mediaRanges.kind, filter.kind));
    if (filter.value) conds.push(eq(mediaRanges.value, filter.value));
    return handle.db
      .select()
      .from(mediaRanges)
      .where(and(...conds))
      .orderBy(mediaRanges.assetId, mediaRanges.inFrame)
      .all();
  } finally {
    handle.sqlite.close();
  }
}

/** Delete one logged range/label by id. Returns the removed row, or undefined. */
export function deleteMediaRange(repo: string, id: string): MediaRangeRecord | undefined {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    return handle.db
      .delete(mediaRanges)
      .where(and(eq(mediaRanges.projectId, project.id), eq(mediaRanges.id, id)))
      .returning()
      .get();
  } finally {
    handle.sqlite.close();
  }
}

export function saveMediaCollection(
  repo: string,
  name: string,
  query: MediaCollectionQuery,
): MediaCollectionRecord {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    const row = {
      id: randomUUID(),
      projectId: project.id,
      name,
      queryJson: JSON.stringify(query),
    };
    return handle.db
      .insert(mediaCollections)
      .values(row)
      .onConflictDoUpdate({
        target: [mediaCollections.projectId, mediaCollections.name],
        set: { queryJson: row.queryJson, updatedAt: sql`CURRENT_TIMESTAMP` },
      })
      .returning()
      .get();
  } finally {
    handle.sqlite.close();
  }
}

export function listMediaCollections(repo: string): MediaCollectionRecord[] {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    return handle.db
      .select()
      .from(mediaCollections)
      .where(eq(mediaCollections.projectId, project.id))
      .orderBy(mediaCollections.name)
      .all();
  } finally {
    handle.sqlite.close();
  }
}

/** Evaluate a saved collection to its matching assets (+ the ranges that matched). */
export function resolveMediaCollection(repo: string, name: string): CollectionResolution {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    const collection = handle.db
      .select()
      .from(mediaCollections)
      .where(and(eq(mediaCollections.projectId, project.id), eq(mediaCollections.name, name)))
      .get();
    if (!collection) throw new Error(`no collection named "${name}"`);
    const query = JSON.parse(collection.queryJson) as MediaCollectionQuery;
    return { collection, query, ...evaluateQuery(handle, project.id, query) };
  } finally {
    handle.sqlite.close();
  }
}

/** Evaluate an ad-hoc query without saving it (shared by resolve + a live find). */
export function evaluateMediaQuery(
  repo: string,
  query: MediaCollectionQuery,
): { assets: MediaAssetRow[]; ranges: MediaRangeRecord[] } {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    return evaluateQuery(handle, project.id, query);
  } finally {
    handle.sqlite.close();
  }
}

function evaluateQuery(
  handle: ReturnType<typeof openStateDb>,
  projectId: string,
  query: MediaCollectionQuery,
): { assets: MediaAssetRow[]; ranges: MediaRangeRecord[] } {
  // Asset-level predicates in SQL.
  const conds = [eq(mediaAssets.projectId, projectId)];
  if (query.assetKind) conds.push(eq(mediaAssets.kind, query.assetKind));
  if (query.textContains) conds.push(like(mediaAssets.relativePath, `%${query.textContains}%`));
  let assets = handle.db
    .select()
    .from(mediaAssets)
    .where(and(...conds))
    .all();
  if (query.durationMinSec != null) {
    const min = query.durationMinSec;
    assets = assets.filter((a) => (a.durationSec ?? 0) >= min);
  }

  // Range-level predicates: which ranges match, and which assets own a match.
  const needsRange = query.rangeKind != null || query.value != null || query.ratingAtLeast != null;
  let ranges: MediaRangeRecord[] = [];
  if (needsRange || query.textContains) {
    const rConds = [eq(mediaRanges.projectId, projectId)];
    if (query.rangeKind) rConds.push(eq(mediaRanges.kind, query.rangeKind));
    if (query.ratingAtLeast === "favorite") {
      rConds.push(eq(mediaRanges.kind, "rating"), eq(mediaRanges.value, "favorite"));
    }
    if (query.value) rConds.push(eq(mediaRanges.value, query.value));
    if (query.textContains && !needsRange) {
      // textContains also matches a range's value/notes.
      const textMatch = or(
        like(mediaRanges.value, `%${query.textContains}%`),
        like(mediaRanges.notes, `%${query.textContains}%`),
      );
      if (textMatch) rConds.push(textMatch);
    }
    ranges = handle.db
      .select()
      .from(mediaRanges)
      .where(and(...rConds))
      .all();
  }

  if (needsRange) {
    const matchedAssetIds = new Set(ranges.map((r) => r.assetId));
    assets = assets.filter((a) => matchedAssetIds.has(a.id));
  } else if (query.textContains) {
    // Union: assets whose path matched OR that own a range whose value/notes matched.
    const pathMatched = new Set(assets.map((a) => a.id));
    const rangeAssetIds = new Set(ranges.map((r) => r.assetId));
    const extra = handle.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.projectId, projectId))
      .all()
      .filter((a) => rangeAssetIds.has(a.id) && !pathMatched.has(a.id));
    assets = [...assets, ...extra];
  }

  // Only surface ranges that belong to a surfaced asset.
  const keep = new Set(assets.map((a) => a.id));
  ranges = ranges.filter((r) => keep.has(r.assetId));
  assets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { assets, ranges };
}

// ─── Placement + usage (Phase E of DESIGN-MEDIA) ────────────────────────────────

export type PlacementInput = {
  /** A logged-range id to place (uses its in/out + name)… */
  range?: string;
  /** …or an asset ref with explicit bounds. */
  asset?: string;
  in?: number;
  out?: number;
  /** Override the label carried onto the clip (defaults to the range's name). */
  label?: string;
};

/** A resolved placement (what `addFootage` needs): absolute resource + frame window. */
export type PlacementSpec = {
  resource: string;
  inFrame: number;
  durationFrames: number;
  label?: string;
};

/**
 * Resolve a logged range (or an asset + in/out) to a placement spec. The catalog is the
 * SOURCE of the slice; the placed clip is a plain reference (resource + in/out + label) —
 * no machine-local catalog id leaks into the portable IR (see DESIGN-MEDIA §bridge).
 */
export function resolvePlacement(repo: string, input: PlacementInput): PlacementSpec {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    let asset: MediaAssetRow | undefined;
    let inFrame: number | null | undefined;
    let outFrame: number | null | undefined;
    let label = input.label;
    if (input.range) {
      const range = handle.db
        .select()
        .from(mediaRanges)
        .where(and(eq(mediaRanges.projectId, project.id), eq(mediaRanges.id, input.range)))
        .get();
      if (!range) throw new Error(`no logged range "${input.range}"`);
      asset = handle.db
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.projectId, project.id), eq(mediaAssets.id, range.assetId)))
        .get();
      if (!asset) throw new Error("the range's source asset is no longer cataloged");
      inFrame = input.in ?? range.inFrame;
      outFrame = input.out ?? range.outFrame;
      label = label ?? range.value ?? undefined;
    } else if (input.asset) {
      asset = resolveAssetRef(handle, project.id, project.rootPath, input.asset);
      inFrame = input.in ?? 0;
      outFrame = input.out;
    } else {
      throw new Error("place needs a range id or an asset");
    }
    const lo = inFrame ?? 0;
    let hi = outFrame;
    if (hi == null) {
      const count = assetFrameCount(asset);
      if (count == null) {
        throw new Error(
          "no out-point and the asset's length is unknown — probe it or pass an out-point",
        );
      }
      hi = count - 1;
    }
    if (hi < lo) throw new Error(`out-point ${hi} is before in-point ${lo}`);
    return {
      resource: asset.path,
      inFrame: lo,
      durationFrames: hi - lo + 1,
      label: label ?? undefined,
    };
  } finally {
    handle.sqlite.close();
  }
}

export type MediaUsage = {
  used: Array<{ asset: MediaAssetRow; ranges: MediaRangeRecord[] }>;
  unused: MediaAssetRow[];
  unmatched: string[];
};

/**
 * Join a timeline's referenced source files (from `timelineSourceFiles`) against the
 * catalog by resolved path — "which cataloged assets + ranges are USED, which are
 * UNUSED, and which timeline sources aren't cataloged (unmatched)". The association is
 * DERIVED here, never stored in the IR.
 */
export function mediaUsage(repo: string, referenced: string[]): MediaUsage {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    const refSet = new Set(referenced.map((p) => resolve(p)));
    const assets = handle.db
      .select()
      .from(mediaAssets)
      .where(eq(mediaAssets.projectId, project.id))
      .all();
    const allRanges = handle.db
      .select()
      .from(mediaRanges)
      .where(eq(mediaRanges.projectId, project.id))
      .all();
    const rangesByAsset = new Map<string, MediaRangeRecord[]>();
    for (const r of allRanges) {
      const list = rangesByAsset.get(r.assetId) ?? [];
      list.push(r);
      rangesByAsset.set(r.assetId, list);
    }
    const used: MediaUsage["used"] = [];
    const unused: MediaAssetRow[] = [];
    const matched = new Set<string>();
    for (const a of assets) {
      const ap = resolve(a.path);
      if (refSet.has(ap)) {
        used.push({ asset: a, ranges: rangesByAsset.get(a.id) ?? [] });
        matched.add(ap);
      } else {
        unused.push(a);
      }
    }
    const unmatched = [...refSet].filter((p) => !matched.has(p));
    return { used, unused, unmatched };
  } finally {
    handle.sqlite.close();
  }
}
