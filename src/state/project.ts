import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { openStateDb } from "./db";
import { initializeState } from "./migrate";
import { projects } from "./schema";

export type ProjectRecord = typeof projects.$inferSelect;

export function initializeProject(repo = process.cwd()): ProjectRecord {
  initializeState(repo);
  const rootPath = resolve(repo);
  const handle = openStateDb(repo);
  try {
    const row = {
      id: randomUUID(),
      rootPath,
      title: basename(rootPath),
    };
    return handle.db
      .insert(projects)
      .values(row)
      .onConflictDoUpdate({
        target: projects.rootPath,
        set: {
          title: row.title,
          updatedAt: sql`CURRENT_TIMESTAMP`,
        },
      })
      .returning()
      .get();
  } finally {
    handle.sqlite.close();
  }
}
