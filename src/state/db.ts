import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export const STATE_DIR_NAME = ".vean";
export const STATE_DB_NAME = "vean.db";

export type StateDbHandle = ReturnType<typeof openStateDb>;

export function stateDir(repo = process.cwd()): string {
  return resolve(repo, STATE_DIR_NAME);
}

export function stateDbPath(repo = process.cwd()): string {
  return resolve(stateDir(repo), STATE_DB_NAME);
}

export function openStateDb(repo = process.cwd()) {
  const path = stateDbPath(repo);
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path, { create: true });
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  return {
    db: drizzle(sqlite, { schema }),
    path,
    sqlite,
  };
}
