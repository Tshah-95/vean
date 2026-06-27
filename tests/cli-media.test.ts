import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const cli = join(repo, "src", "cli.ts");

function run(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync("bun", [cli, ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed: bun ${cli} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`,
    );
  }
  return result.stdout;
}

function json<T>(args: string[], env: NodeJS.ProcessEnv): T {
  return JSON.parse(run(args, env)) as T;
}

describe("media routing CLI", () => {
  it("registers a media root, scans files, finds assets, and resolves route aliases", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vean-media-project-"));
    const configHome = mkdtempSync(join(tmpdir(), "vean-media-config-"));
    const mediaRoot = join(projectRoot, "media");
    mkdirSync(join(mediaRoot, "nested"), { recursive: true });
    writeFileSync(join(mediaRoot, "scene.mov"), "fake");
    writeFileSync(join(mediaRoot, "nested", "voice.wav"), "fake");
    const env = { VEAN_CONFIG_HOME: configHome };

    json(["project", "init", "--repo", projectRoot, "--json"], env);

    const added = json<{
      root: { id: string; role: string; path: string };
      route: { alias: string; target: string };
    }>(["media", "root", "add", mediaRoot, "--role", "raw", "--json"], env);
    expect(added.root.role).toBe("raw");
    expect(added.root.path).toBe(mediaRoot);
    expect(added.route.alias).toBe("media:raw");
    expect(added.route.target).toBe(mediaRoot);

    const scan = json<{ scanned: number; upserted: number; root: { id: string } }>(
      ["media", "scan", "--root-id", added.root.id, "--json"],
      env,
    );
    expect(scan.root.id).toBe(added.root.id);
    expect(scan.scanned).toBe(2);
    expect(scan.upserted).toBe(2);

    const videos = json<Array<{ relativePath: string; kind: string }>>(
      ["media", "list", "--kind", "video", "--json"],
      env,
    );
    expect(videos).toContainEqual(
      expect.objectContaining({ relativePath: "scene.mov", kind: "video" }),
    );

    const found = json<Array<{ relativePath: string; kind: string }>>(
      ["media", "find", "voice", "--json"],
      env,
    );
    expect(found).toContainEqual(
      expect.objectContaining({ relativePath: join("nested", "voice.wav"), kind: "audio" }),
    );

    const route = json<{ alias: string; target: string }>(
      ["route", "resolve", "media:raw", "--json"],
      env,
    );
    expect(route.target).toBe(mediaRoot);
  });
});
