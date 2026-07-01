// SETTINGS (storage half) — the DB-backed get/set/list/unset over the project-local
// `.vean/vean.db`. Imports `./db` (and thus `bun:sqlite`), so it runs only in the
// Bun runtime (CLI, preview server, orchestrators) — never imported by a vitest
// unit (the pure registry in `./settings` is). Settings are PROJECT-scoped (the DB
// is repo-local); the registry `default` is the global baseline, an `app_meta` row
// (`setting:<key>`) is the override. Reuses the generic `app_meta` KV table — no
// schema migration, no new table.
import { existsSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { openStateDb, stateDbPath } from "./db";
import { initializeState } from "./migrate";
import { appMeta } from "./schema";
import {
  SETTINGS,
  type SettingDetail,
  type SettingValue,
  coerceSettingValue,
  parseStoredSetting,
  settingDef,
  settingStorageKey,
} from "./settings";

/** Read the raw stored override for a key, or null if unset / no DB yet. Read-only:
 *  never creates or migrates the DB (a read must not have side effects), so an
 *  uninitialized project simply reports defaults. */
function readOverride(repo: string, key: string): string | null {
  if (!existsSync(stateDbPath(repo))) return null;
  const handle = openStateDb(repo);
  try {
    const row = handle.db
      .select({ value: appMeta.value })
      .from(appMeta)
      .where(eq(appMeta.key, settingStorageKey(key)))
      .get();
    return row?.value ?? null;
  } catch {
    return null; // table absent (DB not migrated) → defaults
  } finally {
    handle.sqlite.close();
  }
}

/** The effective value of a setting: the project override if set, else the registry
 *  default. Throws for an unknown key (a typo should be loud). */
export function getSettingValue(repo: string, key: string): SettingValue {
  const def = settingDef(key);
  if (!def) throw new Error(`unknown setting: ${key}`);
  const stored = readOverride(repo, key);
  return stored == null ? def.default : parseStoredSetting(def, stored);
}

export function getSettingDetail(repo: string, key: string): SettingDetail {
  const def = settingDef(key);
  if (!def) throw new Error(`unknown setting: ${key}`);
  const stored = readOverride(repo, key);
  return {
    def,
    value: stored == null ? def.default : parseStoredSetting(def, stored),
    isDefault: stored == null,
  };
}

/** Every setting with its effective value + default-or-override status — the
 *  `vean config list` payload (discoverability). */
export function listSettings(repo: string): SettingDetail[] {
  return SETTINGS.map((def) => getSettingDetail(repo, def.key));
}

/** Set a project override. Validates against the registry, ensures the DB is
 *  initialized (idempotent migrate), then upserts. Returns the new typed value. */
export function setSetting(repo: string, key: string, raw: string): SettingDetail {
  const def = settingDef(key);
  if (!def) throw new Error(`unknown setting: ${key}`);
  const value = coerceSettingValue(def, raw); // throws on invalid before any write
  initializeState(repo); // idempotent: guarantees app_meta exists
  const handle = openStateDb(repo);
  try {
    handle.db
      .insert(appMeta)
      .values({ key: settingStorageKey(key), value: JSON.stringify(value) })
      .onConflictDoUpdate({
        target: appMeta.key,
        set: { value: JSON.stringify(value), updatedAt: sql`CURRENT_TIMESTAMP` },
      })
      .run();
  } finally {
    handle.sqlite.close();
  }
  return { def, value, isDefault: false };
}

/** Clear a project override, reverting to the registry default. Returns the default. */
export function unsetSetting(repo: string, key: string): SettingDetail {
  const def = settingDef(key);
  if (!def) throw new Error(`unknown setting: ${key}`);
  if (existsSync(stateDbPath(repo))) {
    const handle = openStateDb(repo);
    try {
      handle.db
        .delete(appMeta)
        .where(eq(appMeta.key, settingStorageKey(key)))
        .run();
    } catch {
      /* table absent → nothing to clear */
    } finally {
      handle.sqlite.close();
    }
  }
  return { def, value: def.default, isDefault: true };
}
