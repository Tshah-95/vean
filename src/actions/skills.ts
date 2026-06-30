import { cpSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ActionContext, ActionDefinition, ActionEffect } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Productized skills catalog (roadmap T8 / DESIGN stream S5).
//
// A skill's CAPABILITY (the method) lives in `.agents/skills/<id>/SKILL.md`; the
// catalog (`.agents/skills/catalog.json`, validated by `skill.schema.json`) is
// the typed metadata index over those files. These two actions project that
// catalog to a product surface: `skills.list` reads it, `skills.install` copies a
// skill into a host-discoverable skills dir.
//
// Host skill-dir sync (where `skills.install` can land a copy):
//   • Claude Code  — `<repo>/.claude/skills/<id>/SKILL.md` (project) or
//                    `~/.claude/skills/<id>/` (user; symlinked to `~/.agents/skills`).
//   • Codex        — `~/.agents/skills/<id>/SKILL.md` (native discovery path) and
//                    `~/.codex/skills/<id>/` (mirror maintained by the codex-skills watcher).
//   • Cursor       — `<repo>/.cursor/skills/<id>/SKILL.md` (project rules dir).
//   • vean default — `<repo>/.vean/skills/<id>/SKILL.md` (gitignored project-local
//                    install; the surface-agnostic default this action uses).
// We only WRITE the chosen `dest` here; we never mutate a user's global host
// config. A host that wants the skill globally points its own discovery path at
// the installed copy (the `setup` skill documents the symlink hoist).
// ─────────────────────────────────────────────────────────────────────────────

/** vean's own repo root — `src/actions/skills.ts` is two levels under it. The
 *  canonical catalog ships with the vean install, not the user's project. */
function veanRoot(): string {
  return resolve(new URL("../..", import.meta.url).pathname);
}

function skillsDir(): string {
  return join(veanRoot(), ".agents", "skills");
}

/** A catalog row (mirrors `skill.schema.json#/$defs/entry`). */
export const skillEntry = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string().min(1),
  description: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  path: z.string().regex(/^\.agents\/skills\/[a-z][a-z0-9-]*\/SKILL\.md$/),
  tags: z.array(z.string().min(1)).optional(),
  surfaces: z.array(z.enum(["cli", "mcp", "lsp", "tauri", "agent"])).optional(),
});
export type SkillEntry = z.infer<typeof skillEntry>;

/** The whole catalog file (mirrors `skill.schema.json`). */
export const skillCatalog = z.object({
  $schema: z.string().optional(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  skills: z.array(skillEntry),
});
export type SkillCatalog = z.infer<typeof skillCatalog>;

/** Read + validate the catalog that ships with this vean install. Throws a
 *  readable error if the file is missing or fails the schema (a packaging bug,
 *  not a user error). */
export function loadCatalog(): SkillCatalog {
  const file = join(skillsDir(), "catalog.json");
  if (!existsSync(file)) {
    throw new Error(`skills catalog not found at ${file}`);
  }
  const parsed = skillCatalog.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(
      `invalid skills catalog (${file}): ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")} ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Known host skill directories, relative to a project root. `vean` (the default)
 *  is the gitignored project-local install; the others target a host's own
 *  discovery path. Pass an absolute `dir` to override entirely. */
const HOST_SKILL_DIRS = {
  vean: [".vean", "skills"],
  claude: [".claude", "skills"],
  cursor: [".cursor", "skills"],
  codex: [".codex", "skills"],
} as const;
type HostKey = keyof typeof HOST_SKILL_DIRS;

const stateWrite: ActionEffect = {
  kind: "create",
  mutates: ["filesystem"],
  openWorld: false,
  destructive: false,
  idempotency: "idempotent",
  reversibility: "manual",
  dryRun: "supported",
  approval: "ask",
  audit: "metadata",
};

function projectRoot(ctx: ActionContext, repo?: string): string {
  return repo ?? ctx.project?.rootPath ?? ctx.cwd;
}

/** Identity helper that preserves each definition's inferred input/output types
 *  (mirrors `action()` in registry.ts) so `execute(ctx, input)` is typed. */
function action<I, O>(definition: ActionDefinition<I, O>): ActionDefinition<I, O> {
  return definition;
}

const installInput = z
  .object({
    id: z.string().min(1),
    repo: z.string().optional(),
    host: z.enum(["vean", "claude", "cursor", "codex"]).default("vean"),
    dir: z.string().optional(),
    force: z.boolean().default(false),
    dryRun: z.boolean().default(false),
  })
  .strict();

/** The set of skill catalog actions, spread into the registry's `actions` array
 *  (see the commented registration block in `registry.ts`). */
export const skillActions: ActionDefinition[] = [
  action({
    id: "skills.list",
    title: "List Vean Skills",
    description:
      "List the productized vean skills (the capability catalog) with id, title, description, version, and SKILL.md path. Use this when an agent or human wants to discover the available editing/setup/drive methods before installing one.",
    relatedDiscovery: ["skills.install"],
    input: z.object({ tag: z.string().optional() }).strict(),
    output: z.unknown(),
    scopes: ["fs:read"],
    effect: {
      kind: "read",
      mutates: [],
      openWorld: false,
      destructive: false,
      idempotency: "pure",
      reversibility: "none-needed",
      dryRun: "none",
      approval: "auto",
      audit: "none",
    },
    surfaces: { cli: { command: "skills list" }, mcp: { name: "skills-list" } },
    execute(_ctx, input) {
      const catalog = loadCatalog();
      const skills = input.tag
        ? catalog.skills.filter((entry) => entry.tags?.includes(input.tag as string))
        : catalog.skills;
      return { ok: true, catalogVersion: catalog.version, count: skills.length, skills };
    },
  }),
  action({
    id: "skills.install",
    title: "Install Vean Skill",
    description:
      "Copy a vean skill (its SKILL.md and any sibling files) from the catalog into a local, host-discoverable skills dir so an agent host (Claude Code, Codex, Cursor) can load it. Defaults to the gitignored project-local `.vean/skills/<id>/`; pass `host` to target `.claude`/`.cursor`/`.codex`, or an absolute `dir` to place it anywhere.",
    relatedDiscovery: ["skills.list"],
    input: installInput,
    output: z.unknown(),
    scopes: ["fs:read", "fs:write"],
    effect: stateWrite,
    surfaces: { cli: { command: "skills install" }, mcp: { name: "skills-install" } },
    execute(ctx, input) {
      const catalog = loadCatalog();
      const entry = catalog.skills.find((skill) => skill.id === input.id);
      if (!entry) {
        return {
          ok: false,
          kind: "unknown-skill",
          detail: `unknown skill: ${input.id}`,
          available: catalog.skills.map((skill) => skill.id),
        };
      }
      // Source: the skill's directory inside this vean install. `entry.path` is
      // the repo-relative SKILL.md; its dirname is the skill dir we copy.
      const srcSkill = join(veanRoot(), entry.path);
      if (!existsSync(srcSkill)) {
        return { ok: false, kind: "missing-source", detail: `skill source not found: ${srcSkill}` };
      }
      const srcDir = dirname(srcSkill);

      // Dest: an explicit absolute dir wins; otherwise <projectRoot>/<host-dir>/<id>.
      const host = (input.host ?? "vean") as HostKey;
      const destBase = input.dir
        ? resolve(input.dir)
        : join(projectRoot(ctx, input.repo), ...HOST_SKILL_DIRS[host]);
      const destDir = input.dir ? destBase : join(destBase, entry.id);
      const destSkill = join(destDir, "SKILL.md");

      const exists = existsSync(destSkill);
      if (exists && !input.force) {
        return {
          ok: false,
          kind: "exists",
          detail: `skill already installed at ${destSkill}; pass --force to overwrite`,
          dest: destDir,
        };
      }

      if (input.dryRun) {
        return {
          ok: true,
          dryRun: true,
          skill: entry.id,
          version: entry.version,
          from: srcDir,
          dest: destDir,
          wouldOverwrite: exists,
          host,
        };
      }

      mkdirSync(dirname(destDir), { recursive: true });
      // Copy the whole skill dir (SKILL.md + any scripts/assets). `recursive` +
      // `force` makes a re-install idempotent. Skill files are small; this is a
      // plain fs copy, no symlink — a symlinked install would break once the vean
      // checkout moves, and a project-local copy is what hosts expect to discover.
      cpSync(srcDir, destDir, { recursive: true, force: true, dereference: true });

      const stat = statSync(destSkill);
      return {
        ok: true,
        installed: true,
        skill: entry.id,
        version: entry.version,
        from: srcDir,
        dest: destDir,
        host,
        overwrote: exists,
        bytes: stat.size,
        touchedUris: [destSkill],
      };
    },
  }),
];
