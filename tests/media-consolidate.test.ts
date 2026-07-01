// media.consolidate — Collect Files (copy every source a timeline references into a
// dest). Pure resource-collection is pinned directly; the copy + manifest go through the
// real CLI → action → parse path. Phase C of DESIGN-MEDIA.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { timelineSourceFiles } from "../src/driver/consolidate";
import { audioTrack, clip, colorClip, timeline, videoTrack } from "../src/ir/builder";
import { VERTICAL } from "../src/ir/profile";

describe("timelineSourceFiles — pure resource collection", () => {
  const doc = timeline(VERTICAL, {
    video: [
      videoTrack(
        clip("/abs/a.mp4", { id: "a1", in: 0, out: 10, length: 100 }),
        clip("/abs/a.mp4", { id: "a2", in: 20, out: 30, length: 100 }), // dup source
        colorClip(15, "#ff0000", { id: "c" }), // color generator — excluded
        clip("/abs/logo.png", { id: "g", in: 0, out: 5, length: 100, label: "graphic logo" }), // graphic — excluded
        clip("raw/rel.mp4", { id: "rel", in: 0, out: 5, length: 100 }), // relative — baseDir-resolved
      ),
    ],
    audio: [audioTrack(clip("/abs/voice.wav", { id: "v", in: 0, out: 10, length: 100 }))],
  });

  it("dedups sources, spans video+audio, excludes color/graphic, resolves relatives", () => {
    expect(timelineSourceFiles(doc, "/base")).toEqual([
      "/abs/a.mp4",
      "/base/raw/rel.mp4",
      "/abs/voice.wav",
    ]);
  });

  it("leaves a relative resource untouched when no baseDir is given", () => {
    expect(timelineSourceFiles(doc)).toEqual(["/abs/a.mp4", "raw/rel.mp4", "/abs/voice.wav"]);
  });
});

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

const MLT = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.38.0" title="t">
  <profile description="v" width="1080" height="1920" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="9" display_aspect_den="16" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="10"><property name="resource">raw/a.mp4</property></producer>
  <producer id="producer1" in="0" out="10"><property name="resource">raw/b.mp4</property></producer>
  <playlist id="playlist0">
    <entry producer="producer0" in="0" out="10"/>
    <entry producer="producer1" in="0" out="10"/>
  </playlist>
  <tractor id="timeline"><track producer="playlist0"/></tractor>
</mlt>
`;

type Consolidation = {
  dest: string;
  copied: Array<{ from: string; to: string }>;
  missing: string[];
};

describe("media consolidate CLI", () => {
  const projectRoot = mkdtempSync(join(tmpdir(), "vean-consolidate-project-"));
  const configHome = mkdtempSync(join(tmpdir(), "vean-consolidate-config-"));
  const raw = join(projectRoot, "raw");
  const mlt = join(projectRoot, "timeline.mlt");
  const env = { VEAN_CONFIG_HOME: configHome };

  beforeAll(() => {
    mkdirSync(raw, { recursive: true });
    writeFileSync(join(raw, "a.mp4"), "aaa");
    writeFileSync(join(raw, "b.mp4"), "bbb");
    writeFileSync(mlt, MLT);
    json(["project", "init", "--repo", projectRoot, "--json"], env);
  });

  it("copies every referenced source into the destination", () => {
    const dest = join(projectRoot, "collected");
    const r = json<Consolidation>(
      ["media", "consolidate", "--timeline", mlt, "--dest", dest, "--repo", projectRoot, "--json"],
      env,
    );
    expect(r.copied.map((c) => c.to.split("/").pop()).sort()).toEqual(["a.mp4", "b.mp4"]);
    expect(r.missing).toHaveLength(0);
    expect(existsSync(join(dest, "a.mp4"))).toBe(true);
    expect(existsSync(join(dest, "b.mp4"))).toBe(true);
  });

  it("reports a referenced source that is missing on disk", () => {
    rmSync(join(raw, "b.mp4"));
    const dest = join(projectRoot, "collected2");
    const r = json<Consolidation>(
      ["media", "consolidate", "--timeline", mlt, "--dest", dest, "--repo", projectRoot, "--json"],
      env,
    );
    expect(r.copied.map((c) => c.to.split("/").pop())).toEqual(["a.mp4"]);
    expect(r.missing.map((m) => m.split("/").pop())).toEqual(["b.mp4"]);
  });
});
