import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { and, eq, like, sql } from "drizzle-orm";
import { contentHash, probeFactsFromSource, probeSource } from "../driver/probe";
import { openStateDb } from "./db";
import { initializeProject } from "./project";
import { mediaAssets, mediaRoots, routeAliases } from "./schema";

export type MediaRootRecord = typeof mediaRoots.$inferSelect;
export type MediaAssetRecord = typeof mediaAssets.$inferSelect;
export type RouteAliasRecord = typeof routeAliases.$inferSelect;

export type AddMediaRootInput = {
  role?: string;
  path: string;
  policyJson?: string;
};

export type ScanMediaInput = {
  rootId?: string;
  limit?: number;
};

export type MediaScanResult = {
  root: MediaRootRecord;
  scanned: number;
  upserted: number;
};

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".mkv",
  ".webm",
  ".avi",
  ".mts",
  ".m2ts",
]);
const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".aiff", ".ogg"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".tif", ".tiff"]);
const TIMELINE_EXTENSIONS = new Set([".mlt"]);

function nowIso(): string {
  return new Date().toISOString();
}

function detectKind(path: string): string {
  const ext = extname(path).toLowerCase();
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (TIMELINE_EXTENSIONS.has(ext)) return "timeline";
  return "unknown";
}

function assertJson(value: string): string {
  JSON.parse(value);
  return value;
}

function walkFiles(rootPath: string, limit: number): string[] {
  const files: string[] = [];
  const pending = [rootPath];
  while (pending.length > 0 && files.length < limit) {
    const dir = pending.pop();
    if (!dir) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      if (files.length >= limit) break;
    }
  }
  return files;
}

export function addMediaRoot(repo: string, input: AddMediaRootInput): MediaRootRecord {
  const project = initializeProject(repo);
  const path = resolve(project.rootPath, input.path);
  const policyJson = assertJson(input.policyJson ?? "{}");
  const role = input.role ?? "raw";
  const handle = openStateDb(project.rootPath);
  try {
    const row = {
      id: randomUUID(),
      projectId: project.id,
      role,
      path,
      policyJson,
    };
    return handle.db
      .insert(mediaRoots)
      .values(row)
      .onConflictDoUpdate({
        target: [mediaRoots.projectId, mediaRoots.role, mediaRoots.path],
        set: {
          policyJson,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      })
      .returning()
      .get();
  } finally {
    handle.sqlite.close();
  }
}

export function listMediaRoots(repo: string, role?: string): MediaRootRecord[] {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    return handle.db
      .select()
      .from(mediaRoots)
      .where(
        role
          ? and(eq(mediaRoots.projectId, project.id), eq(mediaRoots.role, role))
          : eq(mediaRoots.projectId, project.id),
      )
      .orderBy(mediaRoots.role, mediaRoots.path)
      .all();
  } finally {
    handle.sqlite.close();
  }
}

export function removeMediaRoot(repo: string, id: string): MediaRootRecord | undefined {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    return handle.db
      .delete(mediaRoots)
      .where(and(eq(mediaRoots.projectId, project.id), eq(mediaRoots.id, id)))
      .returning()
      .get();
  } finally {
    handle.sqlite.close();
  }
}

export function scanMediaRoot(repo: string, input: ScanMediaInput = {}): MediaScanResult {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    const root =
      input.rootId !== undefined
        ? handle.db
            .select()
            .from(mediaRoots)
            .where(and(eq(mediaRoots.projectId, project.id), eq(mediaRoots.id, input.rootId)))
            .get()
        : handle.db
            .select()
            .from(mediaRoots)
            .where(eq(mediaRoots.projectId, project.id))
            .orderBy(mediaRoots.role, mediaRoots.path)
            .limit(1)
            .get();
    if (!root) throw new Error("no media root found");
    const files = walkFiles(root.path, input.limit ?? 1000);
    let upserted = 0;
    for (const file of files) {
      const stat = statSync(file);
      const row = {
        id: randomUUID(),
        projectId: project.id,
        rootId: root.id,
        path: resolve(file),
        relativePath: relative(root.path, file),
        kind: detectKind(file),
        sizeBytes: stat.size,
        mtimeMs: Math.round(stat.mtimeMs),
      };
      handle.db
        .insert(mediaAssets)
        .values(row)
        .onConflictDoUpdate({
          target: [mediaAssets.projectId, mediaAssets.path],
          set: {
            rootId: root.id,
            relativePath: row.relativePath,
            kind: row.kind,
            sizeBytes: row.sizeBytes,
            mtimeMs: row.mtimeMs,
            updatedAt: nowIso(),
          },
        })
        .run();
      upserted += 1;
    }
    return { root, scanned: files.length, upserted };
  } finally {
    handle.sqlite.close();
  }
}

export function listMediaAssets(repo: string, kind?: string): MediaAssetRecord[] {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    return handle.db
      .select()
      .from(mediaAssets)
      .where(
        kind
          ? and(eq(mediaAssets.projectId, project.id), eq(mediaAssets.kind, kind))
          : eq(mediaAssets.projectId, project.id),
      )
      .orderBy(mediaAssets.kind, mediaAssets.relativePath)
      .all();
  } finally {
    handle.sqlite.close();
  }
}

export function findMediaAssets(repo: string, query: string): MediaAssetRecord[] {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    return handle.db
      .select()
      .from(mediaAssets)
      .where(
        and(eq(mediaAssets.projectId, project.id), like(mediaAssets.relativePath, `%${query}%`)),
      )
      .orderBy(mediaAssets.kind, mediaAssets.relativePath)
      .all();
  } finally {
    handle.sqlite.close();
  }
}

/** One cataloged asset by id, or undefined. */
export function getMediaAsset(repo: string, id: string): MediaAssetRecord | undefined {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    return handle.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.projectId, project.id), eq(mediaAssets.id, id)))
      .get();
  } finally {
    handle.sqlite.close();
  }
}

/** Store an asset's structured ffprobe result in `probeJson`. Cache/coordination
 *  state only — the media file stays the source of truth. Returns the updated row. */
export function setMediaProbe(
  repo: string,
  id: string,
  probe: unknown,
): MediaAssetRecord | undefined {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    handle.db
      .update(mediaAssets)
      .set({ probeJson: JSON.stringify(probe), updatedAt: nowIso() })
      .where(and(eq(mediaAssets.projectId, project.id), eq(mediaAssets.id, id)))
      .run();
    return handle.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.projectId, project.id), eq(mediaAssets.id, id)))
      .get();
  } finally {
    handle.sqlite.close();
  }
}

/**
 * Probe one cataloged asset with ffprobe + a content hash and persist the typed
 * facts (duration, rational fps, resolution, audio-stream count, colorspace, hash,
 * last-probe timestamp) plus the verbatim `probeJson` blob. Cache/coordination state
 * only — the file on disk stays the source of truth.
 *
 * Probing is I/O (ffprobe spawn + a whole-file hash read) and runs OUTSIDE any DB
 * transaction (the local-state concurrency rule: never hold a transaction while
 * probing media); the write that follows is a single short UPDATE. Returns the
 * updated row, or `undefined` if the id is unknown. An unprobeable file (missing /
 * no streams) still records a `probedAt` with null facts, so a re-scan can tell
 * "probed, nothing there" from "never probed".
 */
export async function probeAndCatalogAsset(
  repo: string,
  id: string,
): Promise<MediaAssetRecord | undefined> {
  const project = initializeProject(repo);

  // Read the asset's path under a short-lived handle, then CLOSE it before probing.
  const asset = (() => {
    const handle = openStateDb(project.rootPath);
    try {
      return handle.db
        .select()
        .from(mediaAssets)
        .where(and(eq(mediaAssets.projectId, project.id), eq(mediaAssets.id, id)))
        .get();
    } finally {
      handle.sqlite.close();
    }
  })();
  if (!asset) return undefined;

  // I/O — no DB handle open here.
  const probe = await probeSource(asset.path);
  const hash = contentHash(asset.path);
  const facts = probeFactsFromSource(probe, hash);

  // Short write: the typed columns + the verbatim blob (`{}` when unprobeable).
  const handle = openStateDb(project.rootPath);
  try {
    handle.db
      .update(mediaAssets)
      .set({
        durationSec: facts.durationSec,
        fpsNum: facts.fpsNum,
        fpsDen: facts.fpsDen,
        width: facts.width,
        height: facts.height,
        audioStreams: facts.audioStreams,
        colorSpace: facts.colorSpace,
        colorTransfer: facts.colorTransfer,
        colorPrimaries: facts.colorPrimaries,
        contentHash: facts.contentHash,
        probedAt: facts.probedAt,
        probeJson: probe ? JSON.stringify(probe) : "{}",
        updatedAt: nowIso(),
      })
      .where(and(eq(mediaAssets.projectId, project.id), eq(mediaAssets.id, id)))
      .run();
    return handle.db
      .select()
      .from(mediaAssets)
      .where(and(eq(mediaAssets.projectId, project.id), eq(mediaAssets.id, id)))
      .get();
  } finally {
    handle.sqlite.close();
  }
}

export function setRouteAlias(repo: string, alias: string, target: string): RouteAliasRecord {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    const row = {
      id: randomUUID(),
      projectId: project.id,
      alias,
      target,
    };
    return handle.db
      .insert(routeAliases)
      .values(row)
      .onConflictDoUpdate({
        target: [routeAliases.projectId, routeAliases.alias],
        set: { target, updatedAt: sql`CURRENT_TIMESTAMP` },
      })
      .returning()
      .get();
  } finally {
    handle.sqlite.close();
  }
}

export function listRouteAliases(repo: string): RouteAliasRecord[] {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    return handle.db
      .select()
      .from(routeAliases)
      .where(eq(routeAliases.projectId, project.id))
      .orderBy(routeAliases.alias)
      .all();
  } finally {
    handle.sqlite.close();
  }
}

export function resolveRouteAlias(repo: string, alias: string): RouteAliasRecord | undefined {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    return handle.db
      .select()
      .from(routeAliases)
      .where(and(eq(routeAliases.projectId, project.id), eq(routeAliases.alias, alias)))
      .get();
  } finally {
    handle.sqlite.close();
  }
}

export function defaultRouteAliasForRoot(root: MediaRootRecord): string {
  return `media:${root.role || basename(root.path)}`;
}

// ─── Import & relink (Phase C of DESIGN-MEDIA) ──────────────────────────────────

export type ImportMediaInput = {
  /** File to bring into the catalog (absolute or project-relative). */
  path: string;
  /** Copy the bytes into `dest` instead of linking in place. */
  copy?: boolean;
  /** Copy target — a route alias (e.g. media:proxy) or a directory. Required with copy. */
  dest?: string;
  /** Root role when a new media root is created for the copy destination. */
  role?: string;
};

export type ImportMediaResult = {
  asset: MediaAssetRecord;
  copied: boolean;
  from?: string;
  to?: string;
};

/** Resolve a copy destination (a route alias or a path) to an absolute directory. */
function resolveDestDir(
  handle: ReturnType<typeof openStateDb>,
  project: { id: string; rootPath: string },
  dest: string,
): string {
  if (dest.includes(":") && !isAbsolute(dest)) {
    const alias = handle.db
      .select()
      .from(routeAliases)
      .where(and(eq(routeAliases.projectId, project.id), eq(routeAliases.alias, dest)))
      .get();
    if (alias?.target) return resolve(alias.target);
  }
  return resolve(project.rootPath, dest);
}

function roleFromDest(dest: string): string {
  if (dest.includes(":") && !isAbsolute(dest)) return dest.split(":")[1] || "imported";
  return "imported";
}

/** Find or create the media root that owns `dir`. */
function ensureRootForDir(
  handle: ReturnType<typeof openStateDb>,
  projectId: string,
  dir: string,
  role: string,
): MediaRootRecord {
  const existing = handle.db
    .select()
    .from(mediaRoots)
    .where(and(eq(mediaRoots.projectId, projectId), eq(mediaRoots.path, dir)))
    .get();
  if (existing) return existing;
  return handle.db
    .insert(mediaRoots)
    .values({ id: randomUUID(), projectId, role, path: dir, policyJson: "{}" })
    .returning()
    .get();
}

/** The most-specific existing root that contains `filePath`, or undefined. */
function findContainingRoot(
  handle: ReturnType<typeof openStateDb>,
  projectId: string,
  filePath: string,
): MediaRootRecord | undefined {
  const roots = handle.db
    .select()
    .from(mediaRoots)
    .where(eq(mediaRoots.projectId, projectId))
    .all();
  return roots
    .filter((r) => filePath === r.path || filePath.startsWith(r.path + sep))
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function catalogRow(projectId: string, root: MediaRootRecord, filePath: string) {
  const stat = statSync(filePath);
  return {
    id: randomUUID(),
    projectId,
    rootId: root.id,
    path: resolve(filePath),
    relativePath: relative(root.path, filePath),
    kind: detectKind(filePath),
    sizeBytes: stat.size,
    mtimeMs: Math.round(stat.mtimeMs),
  };
}

/**
 * Bring one file into the catalog. Default LINKS it in place (it must sit under an
 * existing media root). `copy` relocates the bytes into `dest` (a route alias or dir,
 * creating a root there if needed) — the Premiere-Ingest-Copy / Resolve Clone-Tool
 * equivalent. Never a scan side-effect; always explicit. Files stay the source of truth.
 */
export function importMediaFile(repo: string, input: ImportMediaInput): ImportMediaResult {
  const project = initializeProject(repo);
  const source = resolve(project.rootPath, input.path);
  if (!existsSync(source)) throw new Error(`no such file: ${source}`);
  const handle = openStateDb(project.rootPath);
  try {
    let root: MediaRootRecord;
    let finalPath: string;
    let copied = false;
    let from: string | undefined;
    if (input.copy) {
      if (!input.dest) throw new Error("copy requires a dest (a route alias or directory)");
      const destDir = resolveDestDir(handle, project, input.dest);
      mkdirSync(destDir, { recursive: true });
      finalPath = join(destDir, basename(source));
      copyFileSync(source, finalPath);
      copied = true;
      from = source;
      root = ensureRootForDir(handle, project.id, destDir, input.role ?? roleFromDest(input.dest));
    } else {
      finalPath = source;
      const containing = findContainingRoot(handle, project.id, source);
      if (!containing) {
        throw new Error(
          `no media root contains ${source}; add one with 'vean media root add', or use --copy --dest`,
        );
      }
      root = containing;
    }
    const row = catalogRow(project.id, root, finalPath);
    const asset = handle.db
      .insert(mediaAssets)
      .values(row)
      .onConflictDoUpdate({
        target: [mediaAssets.projectId, mediaAssets.path],
        set: {
          rootId: root.id,
          relativePath: row.relativePath,
          kind: row.kind,
          sizeBytes: row.sizeBytes,
          mtimeMs: row.mtimeMs,
          updatedAt: nowIso(),
        },
      })
      .returning()
      .get();
    return { asset, copied, from, to: copied ? finalPath : undefined };
  } finally {
    handle.sqlite.close();
  }
}

export type RelinkMediaInput = {
  /** Relink one cataloged asset by id; omit to relink every offline asset. */
  id?: string;
  /** Extra directory to search, in addition to the project's media roots. */
  search?: string;
};

export type RelinkMediaResult = {
  relinked: Array<{ id: string; from: string; to: string }>;
  stillMissing: Array<{ id: string; path: string }>;
};

/**
 * Re-resolve cataloged assets whose file has moved or disappeared ("offline"). Searches
 * the project's media roots (plus an optional dir) and reconnects each dangling asset to
 * a file with the same basename — preferring a `content_hash` match when the asset carries
 * one (a strictly stronger key than Premiere/Resolve's name+timecode). Rewrites the stored
 * path only; the media file stays the source of truth.
 */
export function relinkMedia(repo: string, input: RelinkMediaInput = {}): RelinkMediaResult {
  const project = initializeProject(repo);
  const handle = openStateDb(project.rootPath);
  try {
    const one = input.id
      ? handle.db
          .select()
          .from(mediaAssets)
          .where(and(eq(mediaAssets.projectId, project.id), eq(mediaAssets.id, input.id)))
          .get()
      : undefined;
    const assets = input.id
      ? one
        ? [one]
        : []
      : handle.db.select().from(mediaAssets).where(eq(mediaAssets.projectId, project.id)).all();
    const dangling = assets.filter((a) => !existsSync(a.path));

    // Build a basename → candidates index across the search dirs ONCE.
    const roots = handle.db
      .select()
      .from(mediaRoots)
      .where(eq(mediaRoots.projectId, project.id))
      .all();
    const searchDirs: Array<{ dir: string; rootId: string | null; rootPath: string | null }> =
      roots.map((r) => ({ dir: r.path, rootId: r.id, rootPath: r.path }));
    if (input.search) {
      const dir = resolve(project.rootPath, input.search);
      const containing = findContainingRoot(handle, project.id, dir);
      searchDirs.push({ dir, rootId: containing?.id ?? null, rootPath: containing?.path ?? null });
    }
    type Candidate = { path: string; rootId: string | null; rootPath: string | null };
    const index = new Map<string, Candidate[]>();
    for (const { dir, rootId, rootPath } of searchDirs) {
      if (!existsSync(dir)) continue;
      for (const file of walkFiles(dir, 100000)) {
        const key = basename(file);
        const list = index.get(key) ?? [];
        list.push({ path: file, rootId, rootPath });
        index.set(key, list);
      }
    }

    const relinked: RelinkMediaResult["relinked"] = [];
    const stillMissing: RelinkMediaResult["stillMissing"] = [];
    for (const a of dangling) {
      const candidates = index.get(basename(a.path)) ?? [];
      let hit: Candidate | undefined = candidates[0];
      if (a.contentHash && candidates.length > 0) {
        const byHash = candidates.find((c) => contentHash(c.path) === a.contentHash);
        if (byHash) hit = byHash;
      }
      if (!hit) {
        stillMissing.push({ id: a.id, path: a.path });
        continue;
      }
      handle.db
        .update(mediaAssets)
        .set({
          path: resolve(hit.path),
          rootId: hit.rootId ?? a.rootId,
          relativePath: hit.rootPath ? relative(hit.rootPath, hit.path) : a.relativePath,
          updatedAt: nowIso(),
        })
        .where(and(eq(mediaAssets.projectId, project.id), eq(mediaAssets.id, a.id)))
        .run();
      relinked.push({ id: a.id, from: a.path, to: resolve(hit.path) });
    }
    return { relinked, stillMissing };
  } finally {
    handle.sqlite.close();
  }
}
