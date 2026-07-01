import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createActionContext } from "../src/actions/registry";
import { loadCatalog, skillActions } from "../src/actions/skills";

const repoRoot = join(import.meta.dirname, "..");
const skillsDir = join(repoRoot, ".agents", "skills");

function getAction(id: string) {
  const a = skillActions.find((entry) => entry.id === id);
  if (!a) throw new Error(`missing action ${id}`);
  return a;
}

function ctxFor(cwd: string) {
  return createActionContext({ cwd, surface: "test" });
}

/** Run an action the way `executeAction` does: parse the raw input through the
 *  action's Zod schema (applying `.default()`s) before invoking `execute`. Lets
 *  the tests pass partial input like the CLI/MCP adapters do. */
async function run<O>(id: string, cwd: string, input: unknown): Promise<O> {
  const a = getAction(id);
  const parsed = a.input.parse(input);
  return (await a.execute(ctxFor(cwd), parsed)) as O;
}

// ─────────────────────────────────────────────────────────────────────────────
// A tiny, dependency-free Draft-07 validator covering exactly the keywords this
// repo's `skill.schema.json` uses: type, required, properties, additionalProperties,
// enum, pattern, minLength, items, and `$ref` into the same document's `$defs`.
// vean keeps schema tooling hand-rolled (see src/actions/schema-summary.ts) rather
// than pulling a transitive `ajv` into the gate, so this stays self-contained.
// ─────────────────────────────────────────────────────────────────────────────
type Schema = Record<string, unknown>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function resolveRef(root: Schema, ref: string): Schema {
  if (!ref.startsWith("#/")) throw new Error(`unsupported $ref: ${ref}`);
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    node = (node as Record<string, unknown>)[part];
    if (node == null) throw new Error(`$ref not found: ${ref}`);
  }
  return node as Schema;
}

function validate(root: Schema, schema: Schema, value: unknown, path = "$"): string[] {
  if (typeof schema.$ref === "string") {
    return validate(root, resolveRef(root, schema.$ref), value, path);
  }
  const errors: string[] = [];
  if (typeof schema.type === "string") {
    const actual = typeOf(value);
    // JSON has no integer type distinct from number; treat them as compatible.
    const ok = schema.type === "number" ? actual === "number" : actual === schema.type;
    if (!ok) {
      errors.push(`${path}: expected ${schema.type}, got ${actual}`);
      return errors; // further checks assume the right base type
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: "${value}" does not match /${schema.pattern}/`);
    }
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
  }
  if (typeOf(value) === "object") {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const required of (schema.required as string[]) ?? []) {
      if (!(required in obj)) errors.push(`${path}: missing required property "${required}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) errors.push(...validate(root, sub, obj[key], `${path}.${key}`));
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => {
      errors.push(...validate(root, schema.items as Schema, item, `${path}[${i}]`));
    });
  }
  return errors;
}

/** Pull the YAML frontmatter `name`/`description` from a SKILL.md (the schema's
 *  `$defs/frontmatter` shape). Frontmatter is a small fixed block — no YAML lib. */
function frontmatter(md: string): { name?: string; description?: string } {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) return {};
  const out: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (m?.[1] && m[2] != null) out[m[1]] = m[2].trim();
  }
  return out;
}

describe("skills catalog", () => {
  const schema = JSON.parse(readFileSync(join(skillsDir, "skill.schema.json"), "utf8")) as Schema;
  const catalogRaw = JSON.parse(readFileSync(join(skillsDir, "catalog.json"), "utf8")) as Schema;

  it("catalog.json validates against skill.schema.json (the gate)", () => {
    const errors = validate(schema, schema, catalogRaw);
    expect(errors).toEqual([]);
  });

  it("the schema rejects a malformed entry (validator is not a no-op)", () => {
    const bad = {
      $schema: "./skill.schema.json",
      version: "1.0.0",
      skills: [{ id: "Bad ID", title: "", description: "x", version: "v1", path: "nope" }],
    };
    const errors = validate(schema, schema, bad);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("loadCatalog() parses the shipped catalog through the Zod schema", () => {
    const catalog = loadCatalog();
    expect(catalog.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(catalog.skills.length).toBeGreaterThanOrEqual(3);
    const ids = catalog.skills.map((s) => s.id);
    expect(ids).toEqual(["drive", "editing", "setup", "view"]); // stable id order
  });

  it("every catalog entry points at a real SKILL.md whose frontmatter matches", () => {
    for (const entry of loadCatalog().skills) {
      const md = join(repoRoot, entry.path);
      expect(existsSync(md), `${entry.path} exists`).toBe(true);
      const fm = frontmatter(readFileSync(md, "utf8"));
      expect(fm.name, `${entry.id} frontmatter name`).toBe(entry.id);
      // The catalog description is copied verbatim from the frontmatter.
      expect(entry.description).toBe(fm.description);
    }
  });

  it("exposes skills.list and skills.install action definitions", () => {
    const ids = skillActions.map((a) => a.id);
    expect(ids).toEqual(["skills.list", "skills.install"]);
    for (const a of skillActions) {
      expect(a.surfaces.cli).toBeTruthy();
      expect(a.surfaces.mcp).toBeTruthy();
    }
  });

  it("skills.list returns the catalog (and filters by tag)", async () => {
    const all = await run<{ count: number; skills: { id: string }[] }>("skills.list", repoRoot, {});
    expect(all.count).toBe(4);
    const ui = await run<{ skills: { id: string }[] }>("skills.list", repoRoot, { tag: "ui" });
    expect(ui.skills.map((s) => s.id)).toEqual(["drive", "view"]);
  });

  it("skills.install dry-runs and then copies the SKILL.md into a host dir", async () => {
    const dest = mkdtempSync(join(tmpdir(), "vean-skills-"));

    // Pin `repo` to the temp dir so the target is deterministic (otherwise the
    // default root is the ambient active project, like every other action).
    const dry = await run<{ ok: boolean; dryRun: boolean; dest: string }>("skills.install", dest, {
      id: "editing",
      repo: dest,
      dryRun: true,
    });
    expect(dry.ok).toBe(true);
    expect(dry.dryRun).toBe(true);
    // Default host is `vean` → <projectRoot>/.vean/skills/<id>.
    expect(dry.dest).toBe(join(dest, ".vean", "skills", "editing"));
    expect(existsSync(join(dry.dest, "SKILL.md"))).toBe(false); // dry run wrote nothing

    const done = await run<{
      ok: boolean;
      installed: boolean;
      dest: string;
      touchedUris: string[];
    }>("skills.install", dest, { id: "editing", repo: dest });
    expect(done.ok).toBe(true);
    expect(done.installed).toBe(true);
    const installed = join(done.dest, "SKILL.md");
    expect(existsSync(installed)).toBe(true);
    expect(done.touchedUris).toEqual([installed]);
    // The installed copy carries the right frontmatter.
    expect(frontmatter(readFileSync(installed, "utf8")).name).toBe("editing");

    // Re-install without --force is refused; with --force it overwrites.
    const refused = await run<{ ok: boolean; kind: string }>("skills.install", dest, {
      id: "editing",
      repo: dest,
    });
    expect(refused.ok).toBe(false);
    expect(refused.kind).toBe("exists");
    const forced = await run<{ ok: boolean; overwrote: boolean }>("skills.install", dest, {
      id: "editing",
      repo: dest,
      force: true,
    });
    expect(forced.ok).toBe(true);
    expect(forced.overwrote).toBe(true);
  });

  it("skills.install targets an explicit host dir", async () => {
    const dest = mkdtempSync(join(tmpdir(), "vean-skills-"));
    const done = await run<{ ok: boolean; dest: string; host: string }>("skills.install", dest, {
      id: "setup",
      repo: dest,
      host: "claude",
    });
    expect(done.ok).toBe(true);
    expect(done.host).toBe("claude");
    expect(done.dest).toBe(join(dest, ".claude", "skills", "setup"));
    expect(existsSync(join(done.dest, "SKILL.md"))).toBe(true);
  });

  it("skills.install rejects an unknown skill", async () => {
    const dest = mkdtempSync(join(tmpdir(), "vean-skills-"));
    const res = await run<{ ok: boolean; kind: string; available: string[] }>(
      "skills.install",
      dest,
      { id: "nope" },
    );
    expect(res.ok).toBe(false);
    expect(res.kind).toBe("unknown-skill");
    expect(res.available).toEqual(["drive", "editing", "setup", "view"]);
  });
});
