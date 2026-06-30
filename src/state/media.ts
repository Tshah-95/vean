import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
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
