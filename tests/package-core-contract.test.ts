import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJson } from "../scripts/harness/package-json";
import { type PackageCoreOptions, packageCore } from "../scripts/package-core";
import {
  type RuntimeLayoutError,
  loadRuntimeLayout,
  openVerifiedRuntimeResource,
} from "../src/runtime/layout";
import type { RuntimeLayout } from "../src/runtime/layout-schema";

const repo = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "vean-package-core-contract-"));
const mirrors = [join(scratch, "checkout-a"), join(scratch, "checkout-b")];
const stages = [join(scratch, "stage-a"), join(scratch, "stage-b")];
const projects = [join(scratch, "project-a"), join(scratch, "project-b")];
let builds: ReturnType<typeof packageCore>[] = [];

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function makeMirror(target: string): void {
  mkdirSync(target, { recursive: true });
  for (const path of [
    "src",
    "viewer",
    "drizzle",
    ".agents",
    "package.json",
    "bun.lock",
    "tsconfig.json",
    ".git",
  ]) {
    cpSync(join(repo, path), join(target, path), {
      recursive: true,
      filter: (source) => !/(?:^|\/)(?:node_modules|dist)$/.test(source),
    });
  }
  rmSync(join(target, "viewer", "dist"), { recursive: true, force: true });
  rmSync(join(target, "viewer", "node_modules"), { recursive: true, force: true });
  symlinkSync(join(repo, "node_modules"), join(target, "node_modules"), "dir");
  symlinkSync(join(repo, "viewer", "node_modules"), join(target, "viewer", "node_modules"), "dir");
}

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: {
      HOME: join(scratch, "empty-home"),
      PATH: join(scratch, "hostile-bin"),
      LANG: "en_US.UTF-8",
      ...env,
    },
  });
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port");
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  return address.port;
}

beforeAll(() => {
  mkdirSync(join(scratch, "empty-home"), { recursive: true });
  mkdirSync(join(scratch, "hostile-bin"), { recursive: true });
  for (const name of ["bun", "node", "ffprobe", "remotion"]) {
    const marker = join(scratch, "hostile-bin", name);
    writeFileSync(
      marker,
      `#!/bin/sh\necho hostile-${name} >> '${join(scratch, "marker.log")}'\nexit 91\n`,
    );
    chmodSync(marker, 0o755);
  }
  for (const mirror of mirrors) makeMirror(mirror);
  builds = mirrors.map((sourceRoot, index) => {
    const outputRoot = stages[index];
    const projectRoot = projects[index];
    if (!outputRoot || !projectRoot) throw new Error(`missing build paths for ${index}`);
    mkdirSync(join(scratch, `build-home-${index}`), { recursive: true });
    mkdirSync(join(scratch, `build-tmp-${index}`), { recursive: true });
    return packageCore({
      outputRoot,
      projectRoot,
      sourceRoot,
      buildEnvironment: {
        ...process.env,
        HOME: join(scratch, `build-home-${index}`),
        TMPDIR: join(scratch, `build-tmp-${index}`),
      },
    } satisfies PackageCoreOptions);
  });
}, 120_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("compiled package core", () => {
  it("is byte-reproducible across different checkout, output, TMPDIR, and HOME paths", () => {
    const [a, b] = builds;
    if (!a || !b) throw new Error("missing builds");
    expect(canonicalJson(a.coreBuild.input_manifest)).toBe(
      canonicalJson(b.coreBuild.input_manifest),
    );
    expect(hash(a.executable)).toBe(hash(b.executable));
    expect(a.coreBuild.observed_executable_sha256).toBe(b.coreBuild.observed_executable_sha256);
  });

  it("runs outside the deleted checkout with empty HOME and hostile PATH", () => {
    const build = builds[0];
    if (!build) throw new Error("missing build");
    const mirror = mirrors[0];
    const project = projects[0];
    if (!mirror || !project) throw new Error("missing first build paths");
    renameSync(mirror, `${mirror}.deleted`);
    const version = run(build.executable, ["--version"], scratch);
    expect(version.status, version.stderr).toBe(0);
    expect(version.stdout.trim()).toBe("0.0.0");

    const init = run(
      build.executable,
      ["state", "init", "--repo", project, "--json", "--runtime-layout", build.layoutPath],
      scratch,
    );
    expect(init.status, init.stderr).toBe(0);
    expect(JSON.parse(init.stdout)).toMatchObject({ migrationsApplied: 4, journalMode: "wal" });

    const skills = run(
      build.executable,
      [
        "action",
        "run",
        "skills.list",
        "--input-json",
        "{}",
        "--json",
        "--runtime-layout",
        build.layoutPath,
      ],
      scratch,
    );
    expect(skills.status, skills.stderr).toBe(0);
    expect(JSON.parse(skills.stdout).output.count).toBeGreaterThan(0);
    expect(() => readFileSync(join(scratch, "marker.log"))).toThrow();
  });

  it("serves the exact hashed packaged viewer asset via the production preview", async () => {
    const build = builds[0];
    if (!build) throw new Error("missing build");
    const project = projects[0];
    if (!project) throw new Error("missing first project");
    const port = await freePort();
    const child = spawn(
      build.executable,
      [
        "preview",
        "--no-open",
        "--prod",
        "--runtime-layout",
        build.layoutPath,
        "--repo",
        project,
        "--port",
        String(port),
      ],
      {
        cwd: scratch,
        env: {
          HOME: join(scratch, "empty-home"),
          PATH: join(scratch, "hostile-bin"),
          LANG: "en_US.UTF-8",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let body = "";
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/`);
          if (response.ok) {
            body = await response.text();
            break;
          }
        } catch {}
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      expect(body).not.toBe("");
      expect(createHash("sha256").update(body).digest("hex")).toBe(
        hash(join(build.outputRoot, "viewer", "dist", "index.html")),
      );
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
  }, 20_000);

  it("attributes mutations in every staged resource class before action execution", () => {
    const build = builds[1];
    if (!build) throw new Error("missing build");
    const raw = JSON.parse(readFileSync(build.layoutPath, "utf8")) as RuntimeLayout;
    for (const cls of ["core", "viewer", "migration", "skill"] as const) {
      const resource = raw.resources.find((entry) => entry.class === cls);
      if (!resource) throw new Error(`missing ${cls} fixture`);
      const path = join(build.outputRoot, resource.relative_path);
      const original = readFileSync(path);
      writeFileSync(path, Buffer.concat([original, Buffer.from("mutant")]));
      const layout = loadRuntimeLayout(build.layoutPath, "package");
      let observed: string | undefined;
      try {
        openVerifiedRuntimeResource(layout, resource.id);
      } catch (error) {
        observed = (error as RuntimeLayoutError).code;
      }
      expect(observed, cls).toBe("E_RUNTIME_HASH_MISMATCH");
      writeFileSync(path, original);
      chmodSync(path, resource.mode);
      const restored = openVerifiedRuntimeResource(
        loadRuntimeLayout(build.layoutPath, "package"),
        resource.id,
      );
      restored.close();
    }
  });
});
