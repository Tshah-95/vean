// media.import (link / copy) and media.relink — Phase C of DESIGN-MEDIA, through the
// real CLI → action → state → sqlite path (bun subprocess). Import is always explicit
// (never a scan side-effect); relink re-resolves a moved file by basename + content hash.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const cli = join(repo, "src", "cli.ts");

function attempt(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync("bun", [cli, ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}
function run(args: string[], env: NodeJS.ProcessEnv): string {
  const r = attempt(args, env);
  if (r.status !== 0) {
    throw new Error(`command failed: bun ${cli} ${args.join(" ")}\n${r.stderr}\n${r.stdout}`);
  }
  return r.stdout;
}
function json<T>(args: string[], env: NodeJS.ProcessEnv): T {
  return JSON.parse(run(args, env)) as T;
}

type ImportResult = { copied: boolean; to?: string; asset: { relativePath: string; path: string } };

describe("media import + relink CLI", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "vean-import-project-"));
  const configHome = mkdtempSync(join(tmpdir(), "vean-import-config-"));
  const raw = join(projectRoot, "raw");
  const env = { VEAN_CONFIG_HOME: configHome };
  const base = ["--repo", projectRoot, "--json"];

  beforeAll(() => {
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, "a.mp4"), "vid");
    json(["project", "init", "--repo", projectRoot, "--json"], env);
    json(["media", "root", "add", raw, "--role", "raw", ...base], env);
  });

  it("links a file that already sits under a root (no copy)", () => {
    const r = json<ImportResult>(["media", "import", join(raw, "a.mp4"), ...base], env);
    expect(r.copied).toBe(false);
    expect(r.asset.relativePath).toBe("a.mp4");
    expect(r.asset.path).toBe(join(raw, "a.mp4"));
  });

  it("refuses to link a file with no containing root", () => {
    const loose = join(projectRoot, "loose.mp4");
    writeFileSync(loose, "x");
    const res = attempt(["media", "import", loose, ...base], env);
    expect(res.status).not.toBe(0);
    const envelope = JSON.parse(res.stdout) as { ok: boolean; detail: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.detail).toMatch(/no media root contains/);
  });

  it("copies a loose file into a route destination and catalogs the copy", () => {
    const loose = join(projectRoot, "b.mp4");
    writeFileSync(loose, "loose");
    json(["route", "set", "media:proxy", join(projectRoot, "proxy"), ...base], env);
    const r = json<ImportResult>(
      ["media", "import", loose, "--copy", "--dest", "media:proxy", ...base],
      env,
    );
    expect(r.copied).toBe(true);
    expect(r.to).toBe(join(projectRoot, "proxy", "b.mp4"));
    expect(existsSync(join(projectRoot, "proxy", "b.mp4"))).toBe(true); // bytes really copied
    expect(r.asset.relativePath).toBe("b.mp4");
  });

  it("relinks a moved file by basename", () => {
    // a.mp4 (linked under raw) moves within the root — it goes offline until relinked.
    mkdirSync(join(raw, "sub"), { recursive: true });
    renameSync(join(raw, "a.mp4"), join(raw, "sub", "a.mp4"));
    const r = json<{ relinked: Array<{ from: string; to: string }>; stillMissing: unknown[] }>(
      ["media", "relink", ...base],
      env,
    );
    expect(r.stillMissing).toHaveLength(0);
    expect(r.relinked.map((x) => x.to)).toContain(join(raw, "sub", "a.mp4"));

    const assets = json<Array<{ relativePath: string; path: string }>>(
      ["media", "list", ...base],
      env,
    );
    const moved = assets.find((x) => x.path === join(raw, "sub", "a.mp4"));
    expect(moved?.relativePath).toBe(join("sub", "a.mp4"));
  });
});
