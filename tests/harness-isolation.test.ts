import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Fixture,
  createFixture,
  fixtureBehavior,
  hashFile,
  reclaimStalePortLeases,
} from "../scripts/harness/fixture";
import { recordProcess } from "../scripts/harness/process-ledger";
import { superviseCommand } from "../scripts/harness/supervisor";

const repo = resolve(import.meta.dirname, "..");
const active: Fixture[] = [];

afterEach(async () => {
  while (active.length) await active.pop()?.close();
});

describe("shared hermetic fixture", () => {
  it("proves concurrent HOME/project/DB/port isolation behaviorally", async () => {
    const developerRoot = mkdtempSync(join(tmpdir(), "vean-developer-state-"));
    const canary = join(developerRoot, ".vean", "canary");
    mkdirSync(join(developerRoot, ".vean"));
    writeFileSync(canary, "poison:must-not-be-read-or-written\n");
    const before = hashFile(canary);
    const [first, second] = await Promise.all([
      createFixture({ sourceSha: "fixture-sha", developerCanary: canary }),
      createFixture({ sourceSha: "fixture-sha", developerCanary: canary }),
    ]);
    active.push(first, second);

    writeFileSync(first.descriptor.database, "run-one\n");
    writeFileSync(second.descriptor.database, "run-two\n");
    expect(readFileSync(first.descriptor.database, "utf8")).toBe("run-one\n");
    expect(readFileSync(second.descriptor.database, "utf8")).toBe("run-two\n");
    expect(statSync(first.descriptor.database).ino).not.toBe(
      statSync(second.descriptor.database).ino,
    );
    expect(
      new Set([
        first.descriptor.previewPort,
        first.descriptor.vitePort,
        first.descriptor.webdriverPort,
        second.descriptor.previewPort,
        second.descriptor.vitePort,
        second.descriptor.webdriverPort,
      ]).size,
    ).toBe(6);

    for (const fixture of [first, second]) {
      const ledger = JSON.parse(readFileSync(fixture.descriptor.processLedger, "utf8"));
      expect(ledger.ports).toEqual([
        fixture.descriptor.previewPort,
        fixture.descriptor.vitePort,
        fixture.descriptor.webdriverPort,
      ]);
      const child = spawnSync(
        "bun",
        ["-e", "console.log(JSON.stringify({home:process.env.HOME,db:process.env.VEAN_DB}))"],
        {
          cwd: fixture.descriptor.projectRoot,
          env: {
            PATH: process.env.PATH,
            HOME: fixture.descriptor.home,
            VEAN_DB: fixture.descriptor.database,
          },
          encoding: "utf8",
        },
      );
      expect(child.status).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        home: fixture.descriptor.home,
        db: fixture.descriptor.database,
      });
      expect(fixtureBehavior(fixture)).toMatchObject({
        homeIsolated: true,
        projectIsolated: true,
        databaseIsolated: true,
        authorityMode: 0o600,
        descriptorSecretSafe: true,
        developerStateUnchanged: true,
      });
    }
    expect(hashFile(canary)).toBe(before);
  });

  it("an independent watchdog detects and reaps a reparented marked descendant", async () => {
    const developerRoot = mkdtempSync(join(tmpdir(), "vean-developer-state-"));
    const canary = join(developerRoot, "canary");
    writeFileSync(canary, "poison\n");
    const fixture = await createFixture({ sourceSha: "fixture-sha", developerCanary: canary });
    active.push(fixture);
    const marker = `vean-orphan-${fixture.descriptor.runId}`;
    const launcher = spawn(
      "bun",
      [join(repo, "scripts/harness/marked-child.ts"), marker, "--reparent"],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    recordProcess(fixture.descriptor.processLedger, {
      pid: launcher.pid ?? -1,
      marker,
      executable: "bun",
      startedAt: new Date().toISOString(),
    });
    await new Promise<void>((resolveDone) => launcher.once("exit", () => resolveDone()));
    await new Promise((resolveDone) => setTimeout(resolveDone, 150));

    const first = spawnSync(
      "bun",
      [
        join(repo, "scripts/harness/watchdog.ts"),
        "--ledger",
        fixture.descriptor.processLedger,
        "--reap",
      ],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
    expect(first.status).toBe(1);
    const finding = JSON.parse(first.stdout);
    expect(finding.findings.some((item: { kind: string }) => item.kind === "marker")).toBe(true);
    await new Promise((resolveDone) => setTimeout(resolveDone, 100));
    const second = spawnSync(
      "bun",
      [join(repo, "scripts/harness/watchdog.ts"), "--ledger", fixture.descriptor.processLedger],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
    expect(second.status).toBe(0);
    expect(JSON.parse(second.stdout).findings).toEqual([]);
  });

  it("fixture failure teardown unconditionally audits and reaps its process ledger", async () => {
    const developerRoot = mkdtempSync(join(tmpdir(), "vean-developer-state-"));
    const canary = join(developerRoot, "canary");
    writeFileSync(canary, "poison\n");
    const fixture = await createFixture({ sourceSha: "fixture-sha", developerCanary: canary });
    active.push(fixture);
    const marker = `vean-failure-${fixture.descriptor.runId}`;
    const child = spawn("bun", [join(repo, "scripts/harness/marked-child.ts"), marker], {
      detached: true,
      stdio: "ignore",
    });
    recordProcess(fixture.descriptor.processLedger, {
      pid: child.pid ?? -1,
      marker,
      executable: "bun",
      startedAt: new Date().toISOString(),
    });
    const cleanup = await fixture.close();
    active.pop();
    expect(cleanup.detected.some((finding) => finding.kind === "process")).toBe(true);
    expect(() => process.kill(child.pid ?? -1, 0)).toThrow();
  });

  it("reclaims a port lease left by an abruptly exited allocator process", () => {
    const developerRoot = mkdtempSync(join(tmpdir(), "vean-developer-state-"));
    const canary = join(developerRoot, "canary");
    writeFileSync(canary, "poison\n");
    const fixtureModule = join(repo, "scripts/harness/fixture.ts");
    const code = `const {createFixture}=await import(${JSON.stringify(fixtureModule)});const f=await createFixture({sourceSha:"fixture-sha",developerCanary:${JSON.stringify(canary)}});console.log(JSON.stringify({root:f.root,port:f.descriptor.previewPort}));process.exit(0);`;
    const child = spawnSync("bun", ["-e", code], { cwd: repo, encoding: "utf8" });
    expect(child.status).toBe(0);
    const allocation = JSON.parse(child.stdout.trim()) as { root: string; port: number };
    const leasePath = join(tmpdir(), "vean-harness-port-leases", `${allocation.port}.lock`);
    expect(existsSync(leasePath)).toBe(true);
    expect(reclaimStalePortLeases()).toContain(leasePath);
    expect(existsSync(leasePath)).toBe(false);
    rmSync(allocation.root, { recursive: true, force: true });
    rmSync(developerRoot, { recursive: true, force: true });
  });

  it("an outliving supervisor reaps descendants after owner SIGKILL and timeout", async () => {
    const worker = join(repo, "scripts/harness/supervisor-fixture-worker.ts");
    const abrupt = await superviseCommand(["bun", worker, "abrupt"], {
      cwd: repo,
      timeoutMs: 5_000,
    });
    expect(abrupt.exitCode).not.toBe(0);
    expect(abrupt.detected.some((finding) => finding.kind === "marker")).toBe(true);
    expect(abrupt.remaining).toEqual([]);

    const timeout = await superviseCommand(["bun", worker, "timeout"], {
      cwd: repo,
      timeoutMs: 400,
    });
    expect(timeout.timedOut).toBe(true);
    expect(timeout.exitCode).toBe(124);
    expect(timeout.detected.length).toBeGreaterThan(0);
    expect(timeout.remaining).toEqual([]);
  });
});
