import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type WatchdogFinding, inspectAndReap } from "./watchdog-lib";

export type FixtureDescriptor = {
  version: 1;
  runId: string;
  sourceSha: string;
  home: string;
  projectRoot: string;
  database: string;
  previewPort: number;
  vitePort: number;
  webdriverPort: number;
  authorityHandle: string;
  artifactDir: string;
  processLedger: string;
  processGroup: string;
};

export type Fixture = {
  descriptor: FixtureDescriptor;
  authorityToken: string;
  root: string;
  developerCanary: string;
  developerCanaryHash: string;
  close: () => Promise<{ detected: WatchdogFinding[] }>;
};

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("no TCP address"));
      const port = address.port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

const allocatedPorts = new Set<number>();
const portLeaseDir = join(tmpdir(), "vean-harness-port-leases");

function processStart(pid: number): string | null {
  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

export function reclaimStalePortLeases(): string[] {
  if (!existsSync(portLeaseDir)) return [];
  const removed: string[] = [];
  for (const entry of readdirSync(portLeaseDir)) {
    const path = join(portLeaseDir, entry);
    try {
      const lease = JSON.parse(readFileSync(path, "utf8")) as {
        pid?: number;
        processStart?: string;
      };
      if (
        !Number.isInteger(lease.pid) ||
        !lease.processStart ||
        processStart(lease.pid as number) !== lease.processStart
      ) {
        rmSync(path, { force: true });
        removed.push(path);
      }
    } catch {
      rmSync(path, { force: true });
      removed.push(path);
    }
  }
  return removed;
}

async function uniquePort(): Promise<{ port: number; leasePath: string }> {
  mkdirSync(portLeaseDir, { recursive: true });
  reclaimStalePortLeases();
  for (;;) {
    const port = await reservePort();
    const leasePath = join(portLeaseDir, `${port}.lock`);
    if (allocatedPorts.has(port)) continue;
    try {
      const fd = openSync(leasePath, "wx", 0o600);
      writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, processStart: processStart(process.pid) })}\n`,
      );
      closeSync(fd);
      allocatedPorts.add(port);
      return { port, leasePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export async function createFixture(options: {
  sourceSha: string;
  developerCanary: string;
  baseDir?: string;
}): Promise<Fixture> {
  const root = mkdtempSync(join(options.baseDir ?? tmpdir(), "vean-harness-"));
  const home = join(root, "home");
  const projectRoot = join(root, "project");
  const artifactDir = join(root, "artifacts");
  const stateDir = join(projectRoot, ".vean");
  for (const dir of [home, projectRoot, artifactDir, stateDir]) mkdirSync(dir, { recursive: true });

  if (!existsSync(options.developerCanary)) {
    mkdirSync(dirname(options.developerCanary), { recursive: true });
    writeFileSync(options.developerCanary, "developer-state:poisoned\n", { mode: 0o600 });
  }
  const developerCanaryHash = hashFile(options.developerCanary);
  const authorityToken = randomBytes(32).toString("base64url");
  const authorityHandle = join(root, "authority");
  writeFileSync(authorityHandle, authorityToken, { mode: 0o600 });
  chmodSync(authorityHandle, 0o600);
  const database = join(stateDir, "vean.db");
  writeFileSync(database, `fixture-db:${randomUUID()}\n`, { mode: 0o600 });
  const processLedger = join(artifactDir, "process-ledger.json");
  writeFileSync(processLedger, JSON.stringify({ version: 1, processes: [], ports: [] }, null, 2));
  const leases = await Promise.all([uniquePort(), uniquePort(), uniquePort()] as const);
  const [previewLease, viteLease, webdriverLease] = leases;
  const previewPort = previewLease.port;
  const vitePort = viteLease.port;
  const webdriverPort = webdriverLease.port;
  if (new Set([previewPort, vitePort, webdriverPort]).size !== 3) {
    rmSync(root, { recursive: true, force: true });
    throw new Error("port allocator returned duplicate ports");
  }
  writeFileSync(
    processLedger,
    JSON.stringify(
      { version: 1, processes: [], ports: [previewPort, vitePort, webdriverPort] },
      null,
      2,
    ),
  );
  const runId = randomUUID();
  const descriptor: FixtureDescriptor = {
    version: 1,
    runId,
    sourceSha: options.sourceSha,
    home,
    projectRoot,
    database,
    previewPort,
    vitePort,
    webdriverPort,
    authorityHandle,
    artifactDir,
    processLedger,
    processGroup: `vean-harness-${runId}`,
  };
  writeFileSync(join(artifactDir, "fixture.json"), JSON.stringify(descriptor, null, 2));
  return {
    descriptor,
    authorityToken,
    root,
    developerCanary: options.developerCanary,
    developerCanaryHash,
    close: async () => {
      const detected = await inspectAndReap(processLedger, { reap: true });
      await new Promise((done) => setTimeout(done, 75));
      const remaining = await inspectAndReap(processLedger, { reap: false });
      if (remaining.findings.length > 0) {
        throw new Error(`fixture cleanup left resources: ${JSON.stringify(remaining.findings)}`);
      }
      if (hashFile(options.developerCanary) !== developerCanaryHash) {
        throw new Error("developer-state canary changed during hermetic run");
      }
      rmSync(authorityHandle, { force: true });
      for (const lease of leases) {
        allocatedPorts.delete(lease.port);
        rmSync(lease.leasePath, { force: true });
      }
      rmSync(root, { recursive: true, force: true });
      return { detected: detected.findings };
    },
  };
}

export function fixtureBehavior(fixture: Fixture): Record<string, unknown> {
  const descriptorPath = join(fixture.descriptor.artifactDir, "fixture.json");
  const descriptorText = readFileSync(descriptorPath, "utf8");
  return {
    homeIsolated: fixture.descriptor.home.startsWith(fixture.root),
    projectIsolated: fixture.descriptor.projectRoot.startsWith(fixture.root),
    databaseIsolated: fixture.descriptor.database.startsWith(fixture.root),
    databaseInode: statSync(fixture.descriptor.database).ino,
    authorityMode: statSync(fixture.descriptor.authorityHandle).mode & 0o777,
    descriptorSecretSafe: !descriptorText.includes(fixture.authorityToken),
    developerStateUnchanged: hashFile(fixture.developerCanary) === fixture.developerCanaryHash,
  };
}
