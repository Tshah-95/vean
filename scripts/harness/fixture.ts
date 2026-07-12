import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
  close: () => void;
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

async function uniquePort(): Promise<number> {
  for (;;) {
    const port = await reservePort();
    if (!allocatedPorts.has(port)) {
      allocatedPorts.add(port);
      return port;
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
  const [previewPort, vitePort, webdriverPort] = await Promise.all([
    uniquePort(),
    uniquePort(),
    uniquePort(),
  ]);
  if (new Set([previewPort, vitePort, webdriverPort]).size !== 3) {
    rmSync(root, { recursive: true, force: true });
    throw new Error("port allocator returned duplicate ports");
  }
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
    close: () => {
      if (hashFile(options.developerCanary) !== developerCanaryHash) {
        throw new Error("developer-state canary changed during hermetic run");
      }
      rmSync(authorityHandle, { force: true });
      rmSync(root, { recursive: true, force: true });
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
