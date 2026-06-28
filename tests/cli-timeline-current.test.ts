import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = join(import.meta.dirname, "..");
const cli = join(repo, "src", "cli.ts");
const fixture = resolve(repo, "corpus", "vean-multitrack.mlt");

type ProjectHarness = {
  projectRoot: string;
  neutralCwd: string;
  env: NodeJS.ProcessEnv;
  timelinePath: string;
};

function run(args: string[], harness?: ProjectHarness) {
  return spawnSync("bun", [cli, ...args], {
    cwd: repo,
    env: { ...process.env, ...(harness?.env ?? {}) },
    encoding: "utf8",
  });
}

function json<T>(args: string[], harness?: ProjectHarness): T {
  const result = run(args, harness);
  if (result.status !== 0) {
    throw new Error(
      `command failed: bun ${cli} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`,
    );
  }
  return JSON.parse(result.stdout) as T;
}

function failJson<T = { ok: false; kind: string; detail: string; suggestions?: string[] }>(
  args: string[],
  harness?: ProjectHarness,
): T {
  const result = run(args, harness);
  expect(result.status).not.toBe(0);
  return JSON.parse(result.stdout) as T;
}

function setupProject(): ProjectHarness {
  const projectRoot = mkdtempSync(join(tmpdir(), "vean-timeline-project-"));
  const neutralCwd = mkdtempSync(join(tmpdir(), "vean-timeline-cwd-"));
  const configHome = mkdtempSync(join(tmpdir(), "vean-timeline-config-"));
  const timelines = join(projectRoot, "timelines");
  mkdirSync(timelines);
  const timelinePath = join(timelines, "main.mlt");
  cpSync(fixture, timelinePath);
  const harness = { projectRoot, neutralCwd, env: { VEAN_CONFIG_HOME: configHome }, timelinePath };
  json(["project", "init", "--repo", projectRoot, "--json"], harness);
  return harness;
}

function cwdArgs(harness: ProjectHarness, args: string[]): string[] {
  return ["--cwd", harness.neutralCwd, ...args];
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("active timeline routing", () => {
  it("uses timeline:main from a neutral cwd and routes all omitted-URI timeline verbs", () => {
    const h = setupProject();

    const beforeUse = json<{ activeTimeline: null; next: string[] }>(
      cwdArgs(h, ["timeline", "current", "--json"]),
      h,
    );
    expect(beforeUse.activeTimeline).toBeNull();
    expect(beforeUse.next).toContain("vean timeline use <path> --json");

    const use = json<{
      canonicalRoute: string;
      activeTimeline: { uri: string; resolvedPath: string; outsideProject: boolean };
    }>(cwdArgs(h, ["timeline", "use", "timelines/main.mlt", "--json"]), h);
    expect(use.canonicalRoute).toBe("timeline:main");
    expect(use.activeTimeline.resolvedPath).toBe(h.timelinePath);
    expect(use.activeTimeline.outsideProject).toBe(false);

    const current = json<{ activeTimeline: { uri: string; resolvedPath: string } }>(
      cwdArgs(h, ["timeline", "current", "--json"]),
      h,
    );
    expect(current.activeTimeline.resolvedPath).toBe(h.timelinePath);

    const diagnose = json<{
      ok: true;
      uri: string;
      resolvedPath: string;
      project: { rootPath: string };
    }>(cwdArgs(h, ["timeline", "diagnose", "--json"]), h);
    expect(diagnose.ok).toBe(true);
    expect(diagnose.uri).toBe(h.timelinePath);
    expect(diagnose.project.rootPath).toBe(h.projectRoot);

    const preview = json<{ ok: true; invocation: { op: string }; uri: string }>(
      cwdArgs(h, [
        "timeline",
        "preview-op",
        "gain",
        "--args-json",
        '{"uuid":"clip-5","db":-6}',
        "--json",
      ]),
      h,
    );
    expect(preview).toMatchObject({ ok: true, invocation: { op: "gain" }, uri: h.timelinePath });

    const original = sha(h.timelinePath);
    const applied = json<{
      ok: true;
      invocation: { op: string; resolvedFrom: string };
      inverse: { op: string; args: unknown };
      uri: string;
      resolvedPath: string;
      project: { rootPath: string };
    }>(
      cwdArgs(h, [
        "timeline",
        "apply-op",
        "volume",
        "--args-json",
        '{"uuid":"clip-5","db":-6}',
        "--json",
      ]),
      h,
    );
    expect(applied.invocation).toEqual({ op: "gain", resolvedFrom: "volume" });
    expect(applied.inverse.op).not.toBe("volume");
    expect(sha(h.timelinePath)).not.toBe(original);

    const undone = json<{ ok: true; uri: string; resolvedPath: string }>(
      cwdArgs(h, ["timeline", "undo", "--inverse-json", JSON.stringify(applied.inverse), "--json"]),
      h,
    );
    expect(undone.uri).toBe(h.timelinePath);
    expect(sha(h.timelinePath)).toBe(original);

    const resolved = json<{ ok: true; result: unknown; uri: string }>(
      cwdArgs(h, [
        "timeline",
        "resolve-value-at-frame",
        "0",
        "--target-json",
        '{"scope":"fade","clip":"clip-0","direction":"in"}',
        "--json",
      ]),
      h,
    );
    expect(resolved).toMatchObject({ ok: true, uri: h.timelinePath });

    const refs = json<{ ok: true; result: unknown; uri: string }>(
      cwdArgs(h, [
        "timeline",
        "find-references",
        "--query-json",
        '{"kind":"clip","clip":"clip-0"}',
        "--json",
      ]),
      h,
    );
    expect(refs).toMatchObject({ ok: true, uri: h.timelinePath });
  });

  it("returns typed JSON failures when an omitted timeline is missing or stale", () => {
    const h = setupProject();

    const missing = failJson(cwdArgs(h, ["timeline", "diagnose", "--json"]), h);
    expect(missing).toMatchObject({
      ok: false,
      kind: "missing-active-timeline",
      suggestions: ["vean timeline list --json", "vean timeline use <path> --json"],
    });

    json(cwdArgs(h, ["timeline", "use", h.timelinePath, "--json"]), h);
    rmSync(h.timelinePath);
    expect(existsSync(h.timelinePath)).toBe(false);
    const stale = failJson(cwdArgs(h, ["timeline", "diagnose", "--json"]), h);
    expect(stale).toMatchObject({ ok: false, kind: "stale-route" });
  });

  it("accepts absolute, file URI, uppercase, outside-project, and one-hop alias targets", () => {
    const h = setupProject();
    const uppercase = join(h.projectRoot, "timelines", "UPPER.MLT");
    cpSync(fixture, uppercase);
    const upper = json<{ activeTimeline: { resolvedPath: string } }>(
      cwdArgs(h, ["timeline", "use", "timelines/UPPER.MLT", "--json"]),
      h,
    );
    expect(upper.activeTimeline.resolvedPath).toBe(uppercase);

    const fileUri = `file://${encodeURIComponent(h.timelinePath).replaceAll("%2F", "/")}`;
    const fromUri = json<{ activeTimeline: { resolvedPath: string } }>(
      cwdArgs(h, ["timeline", "use", fileUri, "--json"]),
      h,
    );
    expect(fromUri.activeTimeline.resolvedPath).toBe(h.timelinePath);

    const outsideRoot = mkdtempSync(join(tmpdir(), "vean-external-timeline-"));
    const outside = join(outsideRoot, "external.mlt");
    cpSync(fixture, outside);
    const outsideResult = json<{
      activeTimeline: { resolvedPath: string; outsideProject: boolean };
    }>(cwdArgs(h, ["timeline", "use", outside, "--json"]), h);
    expect(outsideResult.activeTimeline).toMatchObject({
      resolvedPath: outside,
      outsideProject: true,
    });

    json(["route", "set", "timeline:review", h.timelinePath, "--repo", h.projectRoot, "--json"], h);
    json(
      ["route", "set", "timeline:main", "timeline:review", "--repo", h.projectRoot, "--json"],
      h,
    );
    const chained = json<{ activeTimeline: { routeChain: string[]; resolvedPath: string } }>(
      cwdArgs(h, ["timeline", "current", "--json"]),
      h,
    );
    expect(chained.activeTimeline.routeChain).toEqual(["timeline:main", "timeline:review"]);
    expect(chained.activeTimeline.resolvedPath).toBe(h.timelinePath);
  });

  it("rejects invalid timeline targets without overwriting the prior active route", () => {
    const h = setupProject();
    json(cwdArgs(h, ["timeline", "use", h.timelinePath, "--json"]), h);
    const prior = json<{ activeTimeline: { resolvedPath: string } }>(
      cwdArgs(h, ["timeline", "current", "--json"]),
      h,
    ).activeTimeline.resolvedPath;

    const dir = join(h.projectRoot, "timelines");
    const txt = join(h.projectRoot, "timelines", "notes.txt");
    writeFileSync(txt, "not an mlt");
    const missing = join(h.projectRoot, "timelines", "missing.mlt");
    const broken = join(h.projectRoot, "timelines", "broken.mlt");
    symlinkSync(join(h.projectRoot, "timelines", "nope.mlt"), broken);

    json(["route", "set", "timeline:dir", dir, "--repo", h.projectRoot, "--json"], h);
    json(["route", "set", "timeline:text", txt, "--repo", h.projectRoot, "--json"], h);
    json(["route", "set", "media:raw", dir, "--repo", h.projectRoot, "--json"], h);
    json(["route", "set", "timeline:loop", "timeline:loop", "--repo", h.projectRoot, "--json"], h);

    const cases: Array<[string, string]> = [
      [missing, "stale-route"],
      [dir, "directory"],
      [txt, "not-timeline"],
      [broken, "stale-route"],
      ["timeline:unknown", "unknown-route"],
      ["timeline:dir", "directory"],
      ["timeline:text", "not-timeline"],
      ["media:raw", "directory"],
      ["timeline:loop", "route-chain"],
    ];

    for (const [target, kind] of cases) {
      const failure = failJson(cwdArgs(h, ["timeline", "use", target, "--json"]), h);
      expect(failure).toMatchObject({ ok: false, kind });
      const current = json<{ activeTimeline: { resolvedPath: string } }>(
        cwdArgs(h, ["timeline", "current", "--json"]),
        h,
      );
      expect(current.activeTimeline.resolvedPath).toBe(prior);
    }

    json(["route", "set", "timeline:alt", h.timelinePath, "--repo", h.projectRoot, "--json"], h);
    json(["route", "set", "timeline:review", "timeline:alt", "--repo", h.projectRoot, "--json"], h);
    json(
      ["route", "set", "timeline:main", "timeline:review", "--repo", h.projectRoot, "--json"],
      h,
    );
    const tooDeep = failJson(cwdArgs(h, ["timeline", "diagnose", "--json"]), h);
    expect(tooDeep).toMatchObject({ ok: false, kind: "route-chain" });
  });

  it("lists cataloged and routed timelines with stable de-duped source metadata", () => {
    const h = setupProject();
    const second = join(h.projectRoot, "timelines", "second.mlt");
    cpSync(fixture, second);

    json(["media", "root", "add", "timelines", "--repo", h.projectRoot, "--json"], h);
    json(["media", "scan", "--repo", h.projectRoot, "--json"], h);
    json(cwdArgs(h, ["timeline", "use", h.timelinePath, "--json"]), h);
    json(
      ["route", "set", "timeline:stale", "timelines/stale.mlt", "--repo", h.projectRoot, "--json"],
      h,
    );

    const out = json<Array<{ path: string; source: string; aliases: string[]; stale: boolean }>>(
      cwdArgs(h, ["timeline", "list", "--json"]),
      h,
    );
    expect(out.map((entry) => entry.path)).toEqual([...out.map((entry) => entry.path)].sort());
    expect(out.filter((entry) => entry.path === h.timelinePath)).toHaveLength(1);
    expect(out.find((entry) => entry.path === h.timelinePath)).toMatchObject({
      source: "both",
      aliases: ["timeline:main"],
      stale: false,
    });
    expect(out.find((entry) => entry.path === second)).toMatchObject({
      source: "catalog",
      stale: false,
    });
    expect(out.find((entry) => entry.aliases.includes("timeline:stale"))).toMatchObject({
      source: "route",
      stale: true,
    });
  });
});
