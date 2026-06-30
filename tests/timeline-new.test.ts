// timeline.new — assert the builder produces a blank .mlt that parses and
// round-trips byte-identically, and that the CLI verb writes a file + sets
// timeline:main. The pure builder is tested directly (IR-shape). The file-writing
// path uses `Bun.write`, so — like cli-edit — it is exercised through the REAL
// CLI under `bun` (vitest workers run under Node, where `Bun` is undefined).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { newTimeline } from "../src/actions/timelineBuild";
import { fromMlt } from "../src/ir/parse";
import { toMlt } from "../src/ir/serialize";

const ROOT = resolve(import.meta.dirname, "..");
const CLI = join(ROOT, "src", "cli.ts");

function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("bun", [CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("timeline.new builder", () => {
  it("builds a blank vertical timeline with the requested track counts", () => {
    const tl = newTimeline({
      profile: "vertical",
      title: "demo",
      videoTracks: 2,
      audioTracks: 1,
    });
    expect(tl.profile.width).toBe(1080);
    expect(tl.profile.height).toBe(1920);
    expect(tl.profile.fps).toEqual([30, 1]);
    expect(tl.tracks.video).toHaveLength(2);
    expect(tl.tracks.audio).toHaveLength(1);
    expect(tl.tracks.video.every((t) => t.items.length === 0)).toBe(true);
    expect(tl.title).toBe("demo");
  });

  it("serializes + parses + round-trips byte-identically", () => {
    const tl = newTimeline({
      profile: "square",
      title: "rt",
      videoTracks: 1,
      audioTracks: 1,
    });
    const xml = toMlt(tl);
    const parsed = fromMlt(xml);
    // A second serialization of the parsed IR is byte-identical (fixpoint).
    expect(toMlt(parsed)).toBe(xml);
  });
});

describe("timeline.new CLI", () => {
  it("writes a .mlt to disk and points timeline:main at it", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "vean-tlnew-"));
    const configHome = mkdtempSync(join(tmpdir(), "vean-tlnew-config-"));
    const env = { VEAN_CONFIG_HOME: configHome };

    const init = runCli(["project", "init", "--repo", projectRoot, "--json"], env);
    expect(init.status).toBe(0);

    const out = join(projectRoot, "demo.mlt");
    const created = runCli(
      [
        "--cwd",
        projectRoot,
        "timeline",
        "new",
        out,
        "--profile",
        "vertical",
        "--title",
        "demo",
        "--json",
      ],
      env,
    );
    if (created.status !== 0) {
      throw new Error(`timeline new failed: ${created.stderr}\n${created.stdout}`);
    }
    const output = JSON.parse(created.stdout) as { ok: boolean; path: string; set: boolean };
    expect(output.ok).toBe(true);
    expect(output.set).toBe(true);
    expect(output.path.endsWith("demo.mlt")).toBe(true);

    // The written file parses to a valid timeline and round-trips byte-identically.
    const xml = readFileSync(output.path, "utf8");
    const parsed = fromMlt(xml);
    expect(parsed.tracks.video).toHaveLength(1);
    expect(toMlt(parsed)).toBe(xml);

    // timeline:main now resolves to the new file.
    const current = runCli(["--cwd", projectRoot, "timeline", "current", "--json"], env);
    expect(current.status).toBe(0);
    const resolved = JSON.parse(current.stdout) as {
      activeTimeline: { resolvedPath: string } | null;
    };
    expect(resolved.activeTimeline?.resolvedPath).toBe(output.path);
  });
});
