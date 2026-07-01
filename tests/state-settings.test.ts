// Settings registry tests — the PURE half (`src/state/settings.ts`): the registry,
// the validation gate, and stored-value parsing. The DB-backed round-trip lives in
// the CLI spawn test (state modules import bun:sqlite, which vitest can't load).
import { describe, expect, it } from "vitest";
import {
  SETTINGS,
  coerceSettingValue,
  parseStoredSetting,
  settingDef,
} from "../src/state/settings";

/** Fetch a registered setting def, asserting it exists — a missing id is a test
 *  bug, not a runtime path, so a throw here keeps the specs free of non-null
 *  assertions while still narrowing the type for the assertions below. */
function requireDef(id: string) {
  const def = settingDef(id);
  if (!def) throw new Error(`unknown setting id in test: ${id}`);
  return def;
}

describe("settings registry", () => {
  it("registers the fps settings with sane defaults", () => {
    expect(settingDef("fps.autodetect")?.default).toBe("confirm");
    expect(settingDef("fps.vfrTolerance")?.default).toBe(0.002);
    expect(settingDef("fps.mismatchTolerance")?.default).toBe(0.0005);
    expect(settingDef("nope")).toBeUndefined();
    // Every registered setting carries a real description (discoverability bar).
    expect(SETTINGS.every((s) => s.description.length > 10)).toBe(true);
  });
});

describe("coerceSettingValue — the validation gate", () => {
  it("accepts allowed enum values and rejects others", () => {
    const def = requireDef("fps.autodetect");
    expect(coerceSettingValue(def, "auto")).toBe("auto");
    expect(coerceSettingValue(def, "off")).toBe("off");
    expect(() => coerceSettingValue(def, "sometimes")).toThrow(/one of/);
  });

  it("coerces numbers and enforces bounds", () => {
    const def = requireDef("fps.vfrTolerance");
    expect(coerceSettingValue(def, "0.01")).toBe(0.01); // a number, not "0.01"
    expect(() => coerceSettingValue(def, "2")).toThrow(/≤/);
    expect(() => coerceSettingValue(def, "-1")).toThrow(/≥/);
    expect(() => coerceSettingValue(def, "abc")).toThrow(/number/);
  });
});

describe("parseStoredSetting — typed round-trip from storage", () => {
  it("parses stored JSON back to the typed value", () => {
    const num = requireDef("fps.vfrTolerance");
    expect(parseStoredSetting(num, JSON.stringify(0.005))).toBe(0.005);
    const en = requireDef("fps.autodetect");
    expect(parseStoredSetting(en, JSON.stringify("auto"))).toBe("auto");
  });

  it("falls back to the default on corrupt or wrong-typed storage", () => {
    const num = requireDef("fps.vfrTolerance");
    expect(parseStoredSetting(num, "not json")).toBe(0.002); // default
    expect(parseStoredSetting(num, JSON.stringify("a string"))).toBe(0.002); // wrong type
  });
});
