import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VERTICAL, clip, timeline, toMlt, videoTrack } from "../src";

const repo = join(import.meta.dirname, "..");
const cli = join(repo, "src", "cli.ts");
const corpusTimeline = resolve(repo, "corpus", "vean-multitrack.mlt");

type Harness = {
  projectRoot: string;
  neutralCwd: string;
  env: NodeJS.ProcessEnv;
  timelinePath: string;
};

function run(args: string[], harness?: Harness) {
  return spawnSync("bun", [cli, ...args], {
    cwd: repo,
    env: { ...process.env, ...(harness?.env ?? {}) },
    encoding: "utf8",
  });
}

function json<T>(args: string[], harness?: Harness): T {
  const result = run(args, harness);
  if (result.status !== 0) {
    throw new Error(
      `command failed: bun ${cli} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

function failJson<T = { ok: false; kind: string; detail: string; suggestions?: unknown[] }>(
  args: string[],
  harness?: Harness,
): T {
  const result = run(args, harness);
  expect(result.status).not.toBe(0);
  return JSON.parse(result.stdout) as T;
}

function setup(useGenerated = false): Harness {
  const projectRoot = mkdtempSync(join(tmpdir(), "vean-parse-project-"));
  const neutralCwd = mkdtempSync(join(tmpdir(), "vean-parse-cwd-"));
  const configHome = mkdtempSync(join(tmpdir(), "vean-parse-config-"));
  mkdirSync(join(projectRoot, "timelines"));
  const timelinePath = join(projectRoot, "timelines", "main.mlt");
  if (useGenerated) {
    writeFileSync(
      timelinePath,
      toMlt(
        timeline(VERTICAL, {
          video: [
            videoTrack(
              clip("/tmp/left.mp4", { id: "left", dur: 80, length: 200 }),
              clip("/tmp/right.mp4", { id: "right", dur: 80, length: 200 }),
            ),
          ],
        }),
      ),
    );
  } else {
    cpSync(corpusTimeline, timelinePath);
  }
  const harness = { projectRoot, neutralCwd, env: { VEAN_CONFIG_HOME: configHome }, timelinePath };
  json(["project", "init", "--repo", projectRoot, "--json"], harness);
  json(["--cwd", neutralCwd, "timeline", "use", "timelines/main.mlt", "--json"], harness);
  return harness;
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("timeline command parsing and aliases", () => {
  it("dispatches one-positional, old explicit URI, and --timeline forms consistently", () => {
    const h = setup();
    const one = json<{ ok: true; invocation: { op: string; resolvedFrom: string }; uri: string }>(
      [
        "--cwd",
        h.neutralCwd,
        "timeline",
        "preview-op",
        "trim-out",
        "--args-json",
        '{"uuid":"clip-3","delta":5}',
        "--json",
      ],
      h,
    );
    expect(one).toMatchObject({
      ok: true,
      invocation: { op: "trimOut", resolvedFrom: "trim-out" },
      uri: h.timelinePath,
    });

    const old = json<{ ok: true; invocation: { op: string; resolvedFrom: string }; uri: string }>(
      [
        "timeline",
        "preview-op",
        h.timelinePath,
        "trim-out",
        "--args-json",
        '{"uuid":"clip-3","delta":5}',
        "--json",
      ],
      h,
    );
    expect(old).toMatchObject({
      ok: true,
      invocation: { op: "trimOut", resolvedFrom: "trim-out" },
      uri: h.timelinePath,
    });

    const routed = json<{ ok: true; invocation: { op: string; resolvedFrom: string } }>(
      [
        "--cwd",
        h.neutralCwd,
        "timeline",
        "preview-op",
        "volume",
        "--timeline",
        "timeline:main",
        "--args-json",
        '{"uuid":"clip-5","db":-6}',
        "--json",
      ],
      h,
    );
    expect(routed.invocation).toEqual({ op: "gain", resolvedFrom: "volume" });

    const resolved = json<{ ok: true; uri: string }>(
      [
        "--cwd",
        h.neutralCwd,
        "timeline",
        "resolve-value-at-frame",
        h.timelinePath,
        "0",
        "--target-json",
        '{"scope":"fade","clip":"clip-0","direction":"in"}',
        "--json",
      ],
      h,
    );
    expect(resolved).toMatchObject({ ok: true, uri: h.timelinePath });
  });

  it("help text advertises the active timeline default and --timeline escape hatch", () => {
    const result = run(["timeline", "preview-op", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/omit URI to use\s+timeline:main/);
    expect(result.stdout).toContain("--timeline <uri-or-route>");
  });

  it("normalizes crossfade and volume aliases at execution and restores alias edits with undo", () => {
    const crossfade = setup(true);
    const preview = json<{ ok: true; invocation: { op: string; resolvedFrom: string } }>(
      [
        "--cwd",
        crossfade.neutralCwd,
        "timeline",
        "preview-op",
        "timeline:main",
        "crossfade",
        "--args-json",
        '{"track":{"trackId":"playlist0"},"leftUuid":"left","rightUuid":"right","frames":8}',
        "--json",
      ],
      crossfade,
    );
    expect(preview.invocation).toEqual({ op: "dissolve", resolvedFrom: "crossfade" });

    const h = setup();
    const original = sha(h.timelinePath);
    const applied = json<{
      ok: true;
      invocation: { op: string; resolvedFrom: string };
      inverse: { op: string; args: unknown };
    }>(
      [
        "--cwd",
        h.neutralCwd,
        "timeline",
        "apply-op",
        "timeline:main",
        "volume",
        "--args-json",
        '{"uuid":"clip-5","db":-6}',
        "--json",
      ],
      h,
    );
    expect(applied.invocation).toEqual({ op: "gain", resolvedFrom: "volume" });
    expect(applied.inverse.op).toBe("_setGain");
    expect(sha(h.timelinePath)).not.toBe(original);

    json(
      [
        "--cwd",
        h.neutralCwd,
        "timeline",
        "undo",
        "timeline:main",
        "--inverse-json",
        JSON.stringify(applied.inverse),
        "--json",
      ],
      h,
    );
    expect(sha(h.timelinePath)).toBe(original);
  });

  it("unknown op apply returns deterministic suggestions and does not write the file", () => {
    const h = setup();
    const before = sha(h.timelinePath);
    const failure = failJson<{
      ok: false;
      kind: string;
      detail: string;
      suggestions: Array<{ canonicalOp: string }>;
      command: string;
    }>(
      [
        "--cwd",
        h.neutralCwd,
        "timeline",
        "apply-op",
        "crossfdae",
        "--args-json",
        '{"track":{"trackId":"video-0"},"leftUuid":"left","rightUuid":"right","frames":8}',
        "--json",
      ],
      h,
    );
    expect(failure).toMatchObject({
      ok: false,
      kind: "unknown-op",
      command: "vean timeline ops list --json",
    });
    expect(failure.suggestions[0]).toMatchObject({ canonicalOp: "dissolve" });
    expect(sha(h.timelinePath)).toBe(before);
  });
});
