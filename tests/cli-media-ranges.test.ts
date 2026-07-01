// Logged ranges, range-scoped labels, and saved-query collections — exercised
// through the real CLI → action → state → sqlite path (bun subprocess, so bun:sqlite
// runs where it's supported). The pure frame math is pinned separately in
// media-range-math.test.ts. See DESIGN-MEDIA.md.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const cli = join(repo, "src", "cli.ts");

type RangeRow = {
  id: string;
  kind: string;
  value: string | null;
  inFrame: number | null;
  outFrame: number | null;
  provenanceJson: string | null;
};
type Resolution = { assets: Array<{ relativePath: string }>; ranges: RangeRow[] };

function run(args: string[], env: NodeJS.ProcessEnv): string {
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

describe("media ranges, labels, and collections CLI", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "vean-ranges-project-"));
  const configHome = mkdtempSync(join(tmpdir(), "vean-ranges-config-"));
  const mediaRoot = join(projectRoot, "media");
  const env = { VEAN_CONFIG_HOME: configHome };
  const base = ["--repo", projectRoot, "--json"];

  beforeAll(() => {
    mkdirSync(mediaRoot, { recursive: true });
    writeFileSync(join(mediaRoot, "interview.mp4"), "fake");
    json(["project", "init", "--repo", projectRoot, "--json"], env);
    json(["media", "root", "add", mediaRoot, "--role", "raw", ...base], env);
    json(["media", "scan", ...base], env);
  });

  it("logs a subclip, a whole-asset keyword, a favorite range, and a marker", () => {
    const sub = json<RangeRow>(
      [
        "media",
        "log-range",
        "interview.mp4",
        "--in",
        "0",
        "--out",
        "120",
        "--name",
        "intro",
        ...base,
      ],
      env,
    );
    expect(sub).toMatchObject({ kind: "subclip", value: "intro", inFrame: 0, outFrame: 120 });
    // The CLI stamps human provenance (an agent surface would stamp 'agent').
    expect(JSON.parse(sub.provenanceJson ?? "{}")).toMatchObject({
      source: "human",
      tool: "media.log-range",
    });

    const kw = json<RangeRow>(
      ["media", "label", "interview.mp4", "keyword", "interview", ...base],
      env,
    );
    // No --in/--out ⇒ a whole-asset (untimed) tag: null bounds.
    expect(kw).toMatchObject({
      kind: "keyword",
      value: "interview",
      inFrame: null,
      outFrame: null,
    });

    const fav = json<RangeRow>(
      ["media", "rate", "interview.mp4", "favorite", "--in", "30", "--out", "60", ...base],
      env,
    );
    expect(fav).toMatchObject({ kind: "rating", value: "favorite", inFrame: 30, outFrame: 60 });

    const marker = json<RangeRow>(
      ["media", "marker", "interview.mp4", "--at", "90", "--comment", "key point", ...base],
      env,
    );
    // A marker is a zero-length range.
    expect(marker).toMatchObject({ kind: "marker", value: "key point", inFrame: 90, outFrame: 90 });

    const ranges = json<RangeRow[]>(["media", "range", "list", ...base], env);
    expect(ranges).toHaveLength(4);
    expect(new Set(ranges.map((r) => r.kind))).toEqual(
      new Set(["subclip", "keyword", "rating", "marker"]),
    );
  });

  it("does not duplicate an identical whole-asset tag (idempotent label)", () => {
    json(["media", "label", "interview.mp4", "keyword", "interview", ...base], env); // repeat
    const keywords = json<RangeRow[]>(
      ["media", "range", "list", "--kind", "keyword", ...base],
      env,
    );
    expect(keywords).toHaveLength(1);
  });

  it("resolves a smart collection by rating and by keyword, and excludes non-matches", () => {
    json(
      [
        "media",
        "collection",
        "save",
        "faves",
        "--query-json",
        '{"ratingAtLeast":"favorite"}',
        ...base,
      ],
      env,
    );
    const faves = json<Resolution>(["media", "collection", "resolve", "faves", ...base], env);
    expect(faves.assets.map((a) => a.relativePath)).toEqual(["interview.mp4"]);
    expect(faves.ranges.map((r) => [r.kind, r.value])).toContainEqual(["rating", "favorite"]);

    json(
      [
        "media",
        "collection",
        "save",
        "kw",
        "--query-json",
        '{"rangeKind":"keyword","value":"interview"}',
        ...base,
      ],
      env,
    );
    const kw = json<Resolution>(["media", "collection", "resolve", "kw", ...base], env);
    expect(kw.assets.map((a) => a.relativePath)).toEqual(["interview.mp4"]);

    json(
      [
        "media",
        "collection",
        "save",
        "onlyAudio",
        "--query-json",
        '{"assetKind":"audio"}',
        ...base,
      ],
      env,
    );
    const audio = json<Resolution>(["media", "collection", "resolve", "onlyAudio", ...base], env);
    expect(audio.assets).toHaveLength(0); // no audio assets ⇒ empty bin
  });
});
