// The dials-catalog GENERATOR — the subprocess tool that turns `melt -query`'s
// per-service YAML into vean's static, typed dial catalog (`./catalog`). This is
// the ONLY file in `src/ir/dials/` allowed to shell out: it runs `melt`, parses
// its output, merges the override table, and prints a ready-to-commit catalog
// module. The pure engine never imports it — `src/ir`/`src/diagnostics` read only
// the static `./catalog` data this writes (Hard boundary #3: no subprocess on the
// pure path). Run it via `bun run dials:generate` when MLT is upgraded.
//
// Why a hand-rolled YAML reader: melt's `-query` emits a SMALL, REGULAR YAML
// subset (a flat header of `key: value`, then a `parameters:` list of `- key:
// value` blocks, with one nested `values:` list per enum param). Pulling in a full
// YAML dependency for this constrained, machine-generated shape is overkill; the
// reader here handles exactly melt's grammar and is unit-tested against fixtures.
import { spawnSync } from "node:child_process";
import { resolveBin } from "../../driver/melt";
import { DIAL_OVERRIDES, type DialOverride } from "./overrides";
import {
  type Dial,
  type DialKind,
  type DialOption,
  type DialService,
  type ServiceKind,
  dialService,
} from "./types";

// ─── The curated service list ─────────────────────────────────────────────────
/** The services vean emits, round-trips, or is likely to author — the catalog's
 *  scope. Deliberately NOT "every melt service" (hundreds of avfilter/frei0r
 *  wrappers most projects never touch): a focused catalog stays reviewable and the
 *  diagnostic stays fast. Add a service here when vean starts authoring it. */
export const CATALOG_SERVICES: Array<{ id: string; kind: ServiceKind }> = [
  { id: "brightness", kind: "filter" },
  { id: "volume", kind: "filter" },
  { id: "gain", kind: "filter" },
  { id: "affine", kind: "filter" },
  { id: "oldfilm", kind: "filter" },
  { id: "grain", kind: "filter" },
  { id: "luma", kind: "transition" },
  { id: "mix", kind: "transition" },
  { id: "qtblend", kind: "transition" },
];

// ─── melt's -query YAML reader (the constrained subset) ───────────────────────
/** A parsed melt parameter block (one `- identifier: …` entry under `parameters:`),
 *  as raw string fields plus the captured enum `values:` list. */
type RawParam = {
  fields: Record<string, string>;
  values: string[];
};

/** Strip a melt YAML scalar of its optional surrounding quotes. melt quotes a value
 *  that contains a colon/special char (`"colour:0"`, `"Start level (*DEPRECATED*)"`)
 *  and leaves bare scalars unquoted. */
function unquoteYaml(v: string): string {
  const t = v.trim();
  if (
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** Parse one `melt -query "filter=X"` document into a flat header map + the ordered
 *  parameter list. Handles exactly melt's grammar: 2-space-indented header keys, a
 *  `parameters:` list whose items start `  - identifier: …` (4-space `- `), 4-space
 *  continuation `    key: value`, and a per-item `    values:` block of `      - …`
 *  options. Block scalars (`description: |`) are skipped over (we don't need them). */
export function parseMeltQuery(yaml: string): {
  header: Record<string, string>;
  params: RawParam[];
} {
  const lines = yaml.split("\n");
  const header: Record<string, string> = {};
  const params: RawParam[] = [];
  let inParams = false;
  let cur: RawParam | null = null;
  let inValues = false;
  let skipBlockIndent = -1; // when inside a `key: |` block scalar, the indent to skip past

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, ""); // drop trailing ws
    if (line.trim() === "" || line.trim() === "---") continue;
    const indent = line.length - line.trimStart().length;

    // Inside a block scalar (`description: |`) — skip every more-indented line.
    if (skipBlockIndent >= 0) {
      if (indent > skipBlockIndent) continue;
      skipBlockIndent = -1;
    }

    // Enter the parameters list.
    if (!inParams && /^parameters:\s*$/.test(line.trim()) && indent === 0) {
      inParams = true;
      continue;
    }

    if (!inParams) {
      // Flat header `key: value` (top-level only).
      const m = line.match(/^([A-Za-z_][\w.-]*):\s?(.*)$/);
      if (m && indent === 0) {
        const key = m[1] as string;
        const val = m[2] as string;
        // A bare `key:` opening a list/block at the header (e.g. `tags:`) — ignore.
        if (val.trim() !== "" && !val.trim().endsWith("|") && !val.trim().endsWith(">")) {
          header[key] = unquoteYaml(val);
        }
      }
      continue;
    }

    // A new parameter item: `  - identifier: …`.
    const itemMatch = line.match(/^\s+-\s+([A-Za-z_"][\w.*"-]*):\s?(.*)$/);
    if (itemMatch && !inValues) {
      if (cur) params.push(cur);
      cur = { fields: {}, values: [] };
      cur.fields[itemMatch[1] as string] = unquoteYaml(itemMatch[2] as string);
      continue;
    }
    if (!cur) continue;

    // A `values:` block opener under the current param.
    if (/^\s+values:\s*$/.test(line)) {
      inValues = true;
      continue;
    }
    // An enum option line: `      - 0 (source over)`.
    if (inValues) {
      const opt = line.match(/^\s+-\s+(.*)$/);
      if (opt) {
        cur.values.push(unquoteYaml(opt[1] as string));
        continue;
      }
      inValues = false; // fell out of the values list
    }

    // A continuation field of the current param: `    key: value`.
    const fld = line.match(/^\s+([A-Za-z_][\w.-]*):\s?(.*)$/);
    if (fld) {
      const key = fld[1] as string;
      const val = (fld[2] as string).trim();
      if (val === "|" || val === ">" || val === "|-" || val === ">-") {
        // A block scalar — skip its body (we don't model descriptions).
        skipBlockIndent = indent;
        continue;
      }
      cur.fields[key] = unquoteYaml(val);
    }
  }
  if (cur) params.push(cur);
  return { header, params };
}

// ─── Field interpretation ─────────────────────────────────────────────────────
/** Map melt's `type:` to vean's narrowed `DialKind`. Unknown/absent → `string`
 *  (the safe, un-range-checked family). */
function meltTypeToKind(type: string | undefined): DialKind {
  switch ((type ?? "").trim()) {
    case "float":
      return "float";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "color":
      return "color";
    case "rect":
      return "rect";
    case "geometry":
      return "geometry";
    case "properties":
      return "properties";
    default:
      return "string";
  }
}

/** Parse a melt enum option line (`0 (source over)`) into a typed `DialOption`. The
 *  leading token is the wire value (numeric when it parses as a number); the
 *  parenthesized remainder is the label. */
function parseOption(raw: string): DialOption {
  const m = raw.match(/^(\S+)\s*(?:\((.*)\))?\s*$/);
  if (!m) return { value: raw };
  const token = m[1] as string;
  const label = m[2];
  const n = Number(token);
  const value = Number.isFinite(n) && token !== "" ? n : token;
  return label ? { value, label } : { value };
}

/** True iff a melt title/identifier is marked deprecated (`(*DEPRECATED*)`). */
function isDeprecated(p: RawParam): boolean {
  const title = p.fields.title ?? "";
  const id = p.fields.identifier ?? "";
  return /\*DEPRECATED\*/i.test(title) || /\*DEPRECATED\*/i.test(id);
}

/** Normalize a melt parameter identifier. melt occasionally LEAKS the
 *  `(*DEPRECATED*)` marker into the `identifier` field itself (e.g. brightness's
 *  `"end (*DEPRECATED*)"`, volume's `"gain (*DEPRECATED*)"`) — the real property
 *  name is the leading token. Strip any parenthetical/marker suffix so the stored
 *  identifier is the clean MLT property key a filter actually carries; the
 *  deprecation is recorded separately by `isDeprecated`. A legitimate wildcard
 *  identifier (`producer.*`, `transition.*`) has no parenthetical and is left
 *  intact — those are real melt `properties` bags, not malformed names. */
export function normalizeIdentifier(raw: string): string {
  const t = raw.trim();
  // Cut at the first whitespace-or-paren that begins a `(…)` annotation.
  const paren = t.indexOf("(");
  const base = paren >= 0 ? t.slice(0, paren) : t;
  return base.trim();
}

/** Coerce a melt default scalar to number/boolean/string for the typed `default`. */
function parseDefault(raw: string | undefined): number | boolean | string | undefined {
  if (raw == null || raw.trim() === "") return undefined;
  const t = raw.trim();
  if (t === "yes" || t === "true") return true;
  if (t === "no" || t === "false") return false;
  const n = Number(t);
  if (Number.isFinite(n) && /^-?\d/.test(t)) return n;
  return t;
}

/** Build one typed `Dial` from a raw param + its override, stamping provenance. */
export function buildDial(p: RawParam, override: DialOverride | undefined): Dial {
  const identifier = normalizeIdentifier(p.fields.identifier ?? "");
  const kind = override?.kind ?? meltTypeToKind(p.fields.type);
  const dial: Dial = { identifier, kind };

  if (p.fields.title) dial.title = p.fields.title;

  // Numeric bounds: start from melt's published min/max, then apply the override
  // (a curated bound wins; `clearMin`/`clearMax` drop a melt sentinel).
  const meltMin = p.fields.minimum != null ? Number(p.fields.minimum) : undefined;
  const meltMax = p.fields.maximum != null ? Number(p.fields.maximum) : undefined;
  let min = Number.isFinite(meltMin) ? meltMin : undefined;
  let max = Number.isFinite(meltMax) ? meltMax : undefined;
  let boundFromOverride = false;
  if (override) {
    if (override.clearMin) min = undefined;
    if (override.clearMax) max = undefined;
    if (override.min != null) {
      min = override.min;
      boundFromOverride = true;
    }
    if (override.max != null) {
      max = override.max;
      boundFromOverride = true;
    }
  }
  if (min != null) dial.min = min;
  if (max != null) dial.max = max;

  const def = parseDefault(p.fields.default);
  if (def !== undefined) dial.default = def;
  if (override?.unit) dial.unit = override.unit;

  if (p.values.length > 0) dial.options = p.values.map(parseOption);
  if ((p.fields.animation ?? "").trim() === "yes") dial.animation = true;
  if (isDeprecated(p)) dial.deprecated = true;

  // Provenance: a curated bound is `override`; otherwise the dial reflects melt's
  // published schema. Only stamp when there's a meaningful bound/unit to attribute.
  if (boundFromOverride || override?.unit) dial.source = boundFromOverride ? "override" : "melt";
  else if (min != null || max != null) dial.source = "melt";

  return dial;
}

/** Collapse dials that normalize to the SAME identifier (melt occasionally lists
 *  a property twice — a deprecated alias plus the live one, e.g. volume's two
 *  `max_gain` entries, one of which the `(*DEPRECATED*)` strip collides onto the
 *  other). Keep ONE per identifier, preserving melt's first-seen order, and prefer
 *  the entry that carries real bounds / is NOT deprecated — so a duplicate never
 *  shadows the authoritative knob. The kept entry merges in any bound the other
 *  had but it lacked (a one-sided pair across the two duplicate rows still yields
 *  a complete range). */
function dedupeDials(dials: Dial[]): Dial[] {
  const byId = new Map<string, Dial>();
  const order: string[] = [];
  for (const d of dials) {
    const existing = byId.get(d.identifier);
    if (!existing) {
      byId.set(d.identifier, d);
      order.push(d.identifier);
      continue;
    }
    // Prefer the non-deprecated, more-bounded entry; merge missing bounds.
    const better = pickRicherDial(existing, d);
    if (existing.min == null && d.min != null) better.min = d.min;
    if (existing.max == null && d.max != null) better.max = d.max;
    byId.set(d.identifier, better);
  }
  return order.map((k) => byId.get(k) as Dial);
}

/** Of two same-identifier dials, the one to keep: a non-deprecated entry beats a
 *  deprecated one; otherwise the one with more numeric bounds; otherwise the first. */
function pickRicherDial(a: Dial, b: Dial): Dial {
  const depA = a.deprecated === true;
  const depB = b.deprecated === true;
  if (depA !== depB) return depA ? { ...b } : { ...a };
  const boundsA = (a.min != null ? 1 : 0) + (a.max != null ? 1 : 0);
  const boundsB = (b.min != null ? 1 : 0) + (b.max != null ? 1 : 0);
  return boundsB > boundsA ? { ...b } : { ...a };
}

// ─── Query + build one service ────────────────────────────────────────────────
/** Run `melt -query "<kind>=<id>"` and build the typed `DialService`. Throws if
 *  melt is unavailable or the service is unknown (the generator is a tool — it
 *  should fail loudly, never emit a half-catalog). */
export function generateService(id: string, kind: ServiceKind): DialService {
  const query = `${kind}=${id}`;
  const res = spawnSync(resolveBin("melt"), ["-query", query], { encoding: "utf8" });
  if (res.status !== 0 || !res.stdout) {
    throw new Error(`dials:generate: \`melt -query ${query}\` failed (status ${res.status})`);
  }
  const { header, params } = parseMeltQuery(res.stdout);
  const overrides = DIAL_OVERRIDES[id] ?? {};
  const built: Dial[] = params
    .map((p) => buildDial(p, overrides[normalizeIdentifier(p.fields.identifier ?? "")]))
    .filter((d) => d.identifier.length > 0);

  const service: DialService = {
    identifier: header.identifier ?? id,
    kind,
    dials: dedupeDials(built),
  };
  if (header.title) service.title = header.title;
  if (header.schema_version) service.schemaVersion = header.schema_version;
  return dialService.parse(service);
}

// ─── The whole catalog + the printer ──────────────────────────────────────────
/** Build the full catalog object over `CATALOG_SERVICES`. */
export function generateCatalog(): Record<string, DialService> {
  const out: Record<string, DialService> = {};
  for (const { id, kind } of CATALOG_SERVICES) {
    out[id] = generateService(id, kind);
  }
  return out;
}

/** Render the catalog as a committable TypeScript module (`./catalog.ts`). The
 *  emitted file is plain data — a typed object literal validated at load — so the
 *  pure engine reads it with no subprocess. Deterministic key order (the curated
 *  service order) keeps the diff minimal across regenerations. */
export function renderCatalogModule(catalog: Record<string, DialService>): string {
  const banner = `// GENERATED by \`bun run dials:generate\` (src/ir/dials/generate.ts) from
// \`melt -query\` + the override table (src/ir/dials/overrides.ts). DO NOT EDIT BY
// HAND — re-run the generator after an MLT upgrade or an override change. The pure
// engine imports the typed \`DIAL_CATALOG\` constant below with NO subprocess; this
// file IS the static catalog the dial-range diagnostic reads (Hard boundary #3).
//
// Provenance per dial: \`source: "melt"\` = bound/unit published by \`melt -query\`;
// \`source: "override"\` = completed from the curated table. A dial with neither
// \`min\` nor \`max\` is intentionally UNBOUNDED (the diagnostic never fires on it),
// which keeps the zero-false-positive bar — an absent bound is "no limit", not "0".
import type { DialCatalog } from "./types";

export const DIAL_CATALOG: DialCatalog = `;
  const body = JSON.stringify(catalog, null, 2);
  return `${banner}${body} as const;\n`;
}
