// The Remotion render cache — content-addressed coordination state under
// `.vean/cache/remotion/` (gitignored). A re-preview or re-export of the SAME
// composition + props + range + profile is instant: we hash those into a key,
// and a hit returns the already-rendered `.mov` without re-rendering.
//
// This is allowed coordination state per the local-state contract: it lives
// under `.vean/` (gitignored), it is a CACHE (regenerable from the deterministic
// Remotion render), and the artifacts themselves are FILES on disk — only a
// small JSON index records the key→artifact mapping. We use a JSON index file
// (not the SQLite schema) deliberately: it's lighter, needs no migration, and an
// atomic temp-write-then-rename avoids index races without a transaction.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { stateDir } from "./db";

/** The directory holding cached Remotion clips + the index, for `repo`. */
export function remotionCacheDir(repo = process.cwd()): string {
  return join(stateDir(repo), "cache", "remotion");
}

function indexPath(repo: string): string {
  return join(remotionCacheDir(repo), "index.json");
}

/** Everything that, if changed, must invalidate a cached clip. */
export type CacheKeyInput = {
  compositionId: string;
  props: Record<string, unknown>;
  frameRange?: [number, number] | null;
  /** `${width}x${height}@${fps[0]}/${fps[1]}` — a resolution/fps change misses. */
  profileFingerprint: string;
  /** A hash or mtime of the composition entry — editing the .tsx invalidates. */
  entryFingerprint: string;
};

export type CacheEntry = {
  key: string;
  compositionId: string;
  props: Record<string, unknown>;
  frameRange: [number, number] | null;
  outPath: string;
  pixFmt: string;
  hasAlpha: boolean;
  createdAt: string;
};

/** Canonical JSON with SORTED keys at every object level, so a key is stable
 *  regardless of prop insertion order. */
function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** The cache key — a SHA-256 hex of the canonical key input. */
export function cacheKey(input: CacheKeyInput): string {
  const normalized: CacheKeyInput = {
    compositionId: input.compositionId,
    props: input.props,
    frameRange: input.frameRange ?? null,
    profileFingerprint: input.profileFingerprint,
    entryFingerprint: input.entryFingerprint,
  };
  return createHash("sha256").update(canonical(normalized)).digest("hex");
}

/** The on-disk path a clip for `key` should land at. */
export function pathFor(repo: string, key: string): string {
  return join(remotionCacheDir(repo), `${key}.mov`);
}

function readIndex(repo: string): Record<string, CacheEntry> {
  const path = indexPath(repo);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, CacheEntry>;
  } catch {
    // A corrupt index is a cache, not a source of truth — start fresh.
    return {};
  }
}

/** Look up a recorded entry whose artifact still exists on disk. A recorded
 *  entry whose `.mov` was deleted is treated as a miss (and ignored). */
export function lookup(repo: string, key: string): CacheEntry | null {
  const entry = readIndex(repo)[key];
  if (!entry) return null;
  if (!existsSync(entry.outPath)) return null;
  return entry;
}

/** Every recorded entry, regardless of key. Resilient: a missing/corrupt index
 *  yields `[]`, never throws — the preview read-adapter enriches the wire IR from
 *  this and must degrade to no enrichment, not fail the timeline read. */
export function listEntries(repo: string): CacheEntry[] {
  return Object.values(readIndex(repo));
}

/** Find the recorded entry whose baked artifact is `outPath` (compared as an
 *  absolute path — the index stores absolutes). Used to recover a baked overlay's
 *  composition identity from its clip `resource` so the preview server can enrich
 *  an EXISTING overlay placed without `vean:composition` metadata. Returns the
 *  first match, or null. Resilient: a missing/corrupt index → null, never throws. */
export function findByOutPath(repo: string, outPath: string): CacheEntry | null {
  const target = resolve(outPath);
  for (const entry of listEntries(repo)) {
    if (resolve(entry.outPath) === target) return entry;
  }
  return null;
}

/** Record (or overwrite) an entry. Atomic: write a temp index then rename over
 *  the real one, so a concurrent reader never sees a half-written file. */
export function record(repo: string, entry: CacheEntry): CacheEntry {
  const dir = remotionCacheDir(repo);
  mkdirSync(dir, { recursive: true });
  const index = readIndex(repo);
  index[entry.key] = entry;
  const path = indexPath(repo);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(index, null, 2));
  renameSync(tmp, path);
  return entry;
}

/** A fingerprint of the Remotion entry FILE (and its composition dir) so editing
 *  a composition invalidates the cache. Hashes the entry + every `.tsx`/`.ts`
 *  sibling under the entry's directory tree by content. Cheap + deterministic. */
export function entryFingerprint(entryPath: string): string {
  const hash = createHash("sha256");
  const root = resolve(entryPath, "..");
  // Hash the entry itself plus the compositions/lib it pulls in. We avoid a full
  // recursive walk dependency by hashing the well-known source files; a content
  // change in any of them changes the digest.
  const files = collectSourceFiles(root);
  for (const f of files) {
    if (existsSync(f)) hash.update(f).update(readFileSync(f));
  }
  return hash.digest("hex").slice(0, 16);
}

function collectSourceFiles(root: string): string[] {
  // Hash the conventional Remotion source layout (index + Root + compositions +
  // lib). This is intentionally shallow + explicit so it stays deterministic and
  // dependency-free; adding a composition file under these dirs is picked up by
  // the directory read below.
  const out: string[] = [];
  const dirs = [root, join(root, "compositions"), join(root, "lib")];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const name of readdirSync(dir).sort()) {
        if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(join(dir, name));
      }
    } catch {
      // ignore unreadable dirs
    }
  }
  return out;
}
