import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Fixture, createFixture, fixtureBehavior, hashFile } from "../scripts/harness/fixture";
import { recordProcess } from "../scripts/harness/process-ledger";

const repo = resolve(import.meta.dirname, "..");
const active: Fixture[] = [];

afterEach(() => {
  while (active.length) active.pop()?.close();
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
});
