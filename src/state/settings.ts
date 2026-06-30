// SETTINGS (pure half) — the typed registry + validation. This module has NO DB
// import (so it loads in vitest, which can't resolve `bun:sqlite`); the DB-backed
// get/set/list lives in `./settingsStore`. Together they are the user-tunable
// preference primitive: per AGENTS.md "preferences" live in `.vean/vean.db` and
// "CLI is the canonical command surface", so a setting is a TYPED registry entry,
// persisted as a project override, projected to `vean config` so every setting is
// DISCOVERABLE (`config list`/`describe`) and TUNABLE (`config set`) from the CLI
// without reading source. The registry is the single source of truth — add an entry
// here and it is instantly CLI-exposed and readable via `getSettingValue`, so a
// behavior becomes "just a setting" by registering it.

export type SettingType = "enum" | "number" | "boolean" | "string";
export type SettingValue = string | number | boolean;

/** One registered setting: stable key, type, default, human description, and (per
 *  type) the allowed enum values or numeric bounds used to VALIDATE a set. */
export type SettingDef = {
  key: string;
  type: SettingType;
  default: SettingValue;
  description: string;
  /** Allowed values for an `enum` setting (validation + `config describe`). */
  allowed?: readonly string[];
  /** Inclusive bounds for a `number` setting. */
  min?: number;
  max?: number;
};

/** The `app_meta` key a setting override is stored under. */
export const SETTING_KEY_PREFIX = "setting:";
export const settingStorageKey = (key: string): string => SETTING_KEY_PREFIX + key;

// ─── The registry ────────────────────────────────────────────────────────────────
// Add a setting here and it is instantly discoverable + tunable via `vean config`
// and readable via getSettingValue — no other wiring. The first entries make the
// fps-detection behavior tunable (the motivating case): the autodetect MODE and the
// two diagnostic tolerances are now settings, not hardcoded constants.
export const SETTINGS: readonly SettingDef[] = [
  {
    key: "fps.autodetect",
    type: "enum",
    default: "confirm",
    allowed: ["off", "confirm", "auto"],
    description:
      "When a clip's frame rate differs from the timeline (on add / project init): 'off' = do nothing, 'confirm' = ask before changing the timeline rate, 'auto' = set the timeline rate from the first clip automatically.",
  },
  {
    key: "fps.mismatchTolerance",
    type: "number",
    default: 0.0005,
    min: 0,
    max: 1,
    description:
      "Relative gap between a source's nominal rate and the timeline rate above which the 'source-fps-mismatch' diagnostic fires (0.0005 = 0.05%). Lower = stricter.",
  },
  {
    key: "fps.vfrTolerance",
    type: "number",
    default: 0.002,
    min: 0,
    max: 1,
    description:
      "Relative gap between a source's nominal (r_frame_rate) and average rate above which the 'variable-frame-rate-source' diagnostic fires (0.002 = 0.2%). Lower = more sources flagged as VFR.",
  },
  {
    key: "media.transcodeCodec",
    type: "enum",
    default: "prores422hq",
    allowed: ["prores422hq", "prores422", "prores422lt", "dnxhr_hq", "dnxhr_sq", "h264"],
    description:
      "Codec for the edit-friendly CFR intermediate `vean fps transcode` produces. ProRes 422 HQ is the visually-lossless default (largest); 422/422LT trade quality for size; DNxHR HQ/SQ are the Avid-native equivalents; h264 is the smallest (CRF 18, .mp4) but least edit-friendly. ProRes/DNxHR write .mov.",
  },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** The definition for `key`, or undefined if it is not a registered setting. */
export function settingDef(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

/** Validate + coerce a raw string (from the CLI) to the setting's typed value, or
 *  throw a descriptive Error. The single validation gate — `config set` and any
 *  programmatic setter go through it, so an invalid value never reaches storage. */
export function coerceSettingValue(def: SettingDef, raw: string): SettingValue {
  switch (def.type) {
    case "enum": {
      if (def.allowed && !def.allowed.includes(raw)) {
        throw new Error(`${def.key} must be one of: ${def.allowed.join(", ")} (got "${raw}")`);
      }
      return raw;
    }
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new Error(`${def.key} must be a number (got "${raw}")`);
      if (def.min != null && n < def.min) throw new Error(`${def.key} must be ≥ ${def.min}`);
      if (def.max != null && n > def.max) throw new Error(`${def.key} must be ≤ ${def.max}`);
      return n;
    }
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new Error(`${def.key} must be true or false (got "${raw}")`);
    }
    default:
      return raw;
  }
}

/** Parse a stored JSON override back to a typed value, falling back to the default
 *  if the stored text is corrupt or the wrong type (never throw on a read). Pure. */
export function parseStoredSetting(def: SettingDef, stored: string): SettingValue {
  try {
    const v = JSON.parse(stored) as unknown;
    if (def.type === "number" && typeof v === "number") return v;
    if (def.type === "boolean" && typeof v === "boolean") return v;
    if ((def.type === "enum" || def.type === "string") && typeof v === "string") return v;
  } catch {
    /* fall through to default */
  }
  return def.default;
}

/** The full picture for one setting: its def, effective value, and whether that
 *  value is the registry default or an explicit project override. */
export type SettingDetail = { def: SettingDef; value: SettingValue; isDefault: boolean };
