import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { openStateDb, stateDbPath, stateDir } from "./db";

export type StateStatus = {
  repo: string;
  stateDir: string;
  dbPath: string;
  exists: boolean;
  migrationsApplied: number;
  journalMode?: string;
  busyTimeoutMs?: number;
};

const MIGRATIONS_FOLDER = resolve(import.meta.dirname, "..", "..", "drizzle");

export function initializeState(repo = process.cwd()): StateStatus {
  const handle = openStateDb(repo);
  try {
    migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
    return getStateStatus(repo, handle);
  } finally {
    handle.sqlite.close();
  }
}

export function getStateStatus(
  repo = process.cwd(),
  existingHandle?: ReturnType<typeof openStateDb>,
): StateStatus {
  const dbPath = stateDbPath(repo);
  if (!existingHandle && !existsSync(dbPath)) {
    return {
      repo: resolve(repo),
      stateDir: stateDir(repo),
      dbPath,
      exists: false,
      migrationsApplied: 0,
    };
  }
  const handle = existingHandle ?? openStateDb(repo);
  try {
    const migrationRows = handle.sqlite
      .query<{ count: number }, []>(
        "select count(*) as count from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
      )
      .get();
    const migrationsApplied =
      migrationRows?.count === 1
        ? (handle.sqlite
            .query<{ count: number }, []>("select count(*) as count from __drizzle_migrations")
            .get()?.count ?? 0)
        : 0;
    const journalMode = handle.sqlite
      .query<{ journal_mode: string }, []>("PRAGMA journal_mode")
      .get()?.journal_mode;
    const busyTimeoutMs = handle.sqlite
      .query<{ timeout: number }, []>("PRAGMA busy_timeout")
      .get()?.timeout;
    return {
      repo: resolve(repo),
      stateDir: stateDir(repo),
      dbPath,
      exists: existsSync(dbPath),
      migrationsApplied,
      journalMode,
      busyTimeoutMs,
    };
  } finally {
    if (!existingHandle) handle.sqlite.close();
  }
}
