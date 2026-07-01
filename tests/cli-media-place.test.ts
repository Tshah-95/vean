// media.place (catalog range → timeline clip) + media.usage (derive used/unused/
// unmatched by path). Phase E of DESIGN-MEDIA. The placed clip is a PLAIN slice
// ({resource, in, out}); its label association is DERIVED from the catalog by
// media.usage — no machine-local catalog id lands in the portable .mlt.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const cli = join(repo, "src", "cli.ts");
function json<T>(args: string[], env: NodeJS.ProcessEnv): T {
  const r = spawnSync("bun", [cli, ...args], {
    cwd: repo,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`bun ${cli} ${args.join(" ")}\n${r.stderr}\n${r.stdout}`);
  return JSON.parse(r.stdout) as T;
}

// An initial timeline with one video track that already references an UNCATALOGED
// source (raw/ghost.mp4) — so media.usage has an "unmatched" to report.
const MLT = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.38.0" title="t">
  <profile description="v" width="1080" height="1920" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="9" display_aspect_den="16" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="10"><property name="resource">raw/ghost.mp4</property></producer>
  <playlist id="playlist0"><entry producer="producer0" in="0" out="10"/></playlist>
  <tractor id="timeline"><track producer="playlist0"/></tractor>
</mlt>
`;

type Placed = {
  ok: boolean;
  clipId?: string;
  placed?: { resource: string; inFrame: number; durationFrames: number; label?: string };
  consequences?: { clipsAdded: unknown[] };
};
type Usage = {
  used: Array<{ asset: { relativePath: string }; ranges: Array<{ value: string | null }> }>;
  unused: Array<{ relativePath: string }>;
  unmatched: string[];
};

describe("media place + usage CLI", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "vean-place-project-"));
  const configHome = mkdtempSync(join(tmpdir(), "vean-place-config-"));
  const raw = join(projectRoot, "raw");
  const mlt = join(projectRoot, "timeline.mlt");
  const env = { VEAN_CONFIG_HOME: configHome };
  const base = ["--repo", projectRoot, "--json"];
  let rangeId = "";

  beforeAll(() => {
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, "clip.mp4"), "clip");
    writeFileSync(join(raw, "extra.mp4"), "extra"); // cataloged but never placed → unused
    writeFileSync(mlt, MLT);
    json(["project", "init", "--repo", projectRoot, "--json"], env);
    json(["media", "root", "add", raw, "--role", "raw", ...base], env);
    json(["media", "scan", ...base], env); // catalogs clip.mp4 + extra.mp4 (not ghost.mp4)
    rangeId = json<{ id: string }>(
      ["media", "log-range", "clip.mp4", "--in", "0", "--out", "90", "--name", "intro", ...base],
      env,
    ).id;
  });

  it("places a logged range as a clip carrying its name, and marks the source used", () => {
    const r = json<Placed>(["media", "place", "--range", rangeId, "--timeline", mlt, ...base], env);
    expect(r.ok).toBe(true);
    expect(r.placed).toMatchObject({ inFrame: 0, durationFrames: 91, label: "intro" });
    expect(r.consequences?.clipsAdded).toHaveLength(1);
    expect(typeof r.clipId).toBe("string");

    const u = json<Usage>(["media", "usage", "--timeline", mlt, ...base], env);
    // clip.mp4 is used and carries its 'intro' range (derived from the catalog by path).
    expect(u.used.map((x) => x.asset.relativePath)).toEqual(["clip.mp4"]);
    expect((u.used[0]?.ranges ?? []).map((rg) => rg.value)).toContain("intro");
    // extra.mp4 is cataloged but never placed.
    expect(u.unused.map((x) => x.relativePath)).toEqual(["extra.mp4"]);
    // raw/ghost.mp4 is on the timeline but not cataloged.
    expect(u.unmatched.map((p) => p.split("/").pop())).toEqual(["ghost.mp4"]);
  });

  it("places a second, independent instance of the same source", () => {
    const r = json<Placed>(
      [
        "media",
        "place",
        "--asset",
        "clip.mp4",
        "--in",
        "30",
        "--out",
        "60",
        "--timeline",
        mlt,
        ...base,
      ],
      env,
    );
    expect(r.ok).toBe(true);
    expect(r.placed).toMatchObject({ inFrame: 30, durationFrames: 31 });
    expect(r.consequences?.clipsAdded).toHaveLength(1); // a distinct clip, same file
    // Still one used asset (dedup), now behind two placements.
    const u = json<Usage>(["media", "usage", "--timeline", mlt, ...base], env);
    expect(u.used.map((x) => x.asset.relativePath)).toEqual(["clip.mp4"]);
  });
});
