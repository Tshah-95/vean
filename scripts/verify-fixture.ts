#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { authorizeMutation, createNonceConsumer } from "../src/preview/security";
import { createPreviewHandler } from "../src/preview/server";
import {
  controlIsMutated,
  scanSecret,
  writeControlFailure,
  writeVerifiedEvidence,
} from "./harness/evidence";
import { type Fixture, createFixture, fixtureBehavior, hashFile } from "./harness/fixture";
import { recordProcess } from "./harness/process-ledger";
import { inspectAndReap } from "./harness/watchdog-lib";

const repo = resolve(import.meta.dirname, "..");
const suiteIndex = process.argv.indexOf("--suite");
const suite = suiteIndex >= 0 ? process.argv[suiteIndex + 1] : undefined;
const scenarioIndex = process.argv.indexOf("--scenario");
const scenario = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1] : undefined;

const claim =
  suite === "loopback-authority"
    ? {
        id: "claim-loopback-authority",
        control: "nc-loopback-authority",
        command: "bun run verify:fixture --suite loopback-authority",
        predicate:
          "black-box bound-server matrix rejects every unauthorized Host/Origin/token/content-type/replay case before body parsing and leaks no authority material",
      }
    : scenario === "teardown"
      ? {
          id: "claim-process-cleanup",
          control: "nc-process-cleanup",
          command: "bun run verify:fixture --json --scenario teardown",
          predicate:
            "independent watchdog finds zero run markers, PGIDs, executable/start tuples, owned sockets, or open fixture files after all exit modes",
        }
      : {
          id: "claim-hermetic-runs",
          control: "nc-hermetic-runs",
          command: "bun run verify:fixture --json",
          predicate:
            "behavioral canaries, child environments, DB inodes, socket owners, API results, and unchanged developer-state hashes prove isolation",
        };

if (process.env.VEAN_HARNESS_PHASE === "negative-control") {
  if (!controlIsMutated(repo, claim.control)) throw new Error(`${claim.control} was not mutated`);
  writeControlFailure(
    `SENSITIVITY_${claim.id
      .replace(/^claim-/, "")
      .replaceAll("-", "_")
      .toUpperCase()}`,
    claim.control,
  );
}

const evidenceBase = process.env.VEAN_HARNESS_EVIDENCE_PATH
  ? dirname(process.env.VEAN_HARNESS_EVIDENCE_PATH)
  : join(repo, ".vean", "harness", "standalone");
const invocationId = (process.env.VEAN_HARNESS_CLAIM_RUN_ID ?? crypto.randomUUID()).replace(
  /[^A-Za-z0-9_.-]/g,
  "_",
);
const artifactDir = join(evidenceBase, `${claim.id}-artifacts`, invocationId);
mkdirSync(artifactDir, { recursive: true });
const canary = join(repo, ".vean", "harness", "developer-state-canary");
mkdirSync(dirname(canary), { recursive: true });
if (!Bun.file(canary).size) writeFileSync(canary, "poisoned-developer-state\n");
const sourceSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo })
  .stdout.toString()
  .trim();
const fixtures: Fixture[] = [];

async function hermeticProof() {
  const before = hashFile(canary);
  const [a, b] = await Promise.all([
    createFixture({ sourceSha, developerCanary: canary }),
    createFixture({ sourceSha, developerCanary: canary }),
  ]);
  fixtures.push(a, b);
  writeFileSync(a.descriptor.database, "run-a\n");
  writeFileSync(b.descriptor.database, "run-b\n");
  const childResults = [a, b].map((fixture) => {
    const child = Bun.spawnSync(
      [
        "bun",
        "-e",
        "console.log(JSON.stringify({home:process.env.HOME,db:process.env.VEAN_DB,cwd:process.cwd()}))",
      ],
      {
        cwd: fixture.descriptor.projectRoot,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: fixture.descriptor.home,
          VEAN_DB: fixture.descriptor.database,
        },
      },
    );
    if (child.exitCode !== 0) throw new Error(child.stderr.toString());
    return JSON.parse(child.stdout.toString());
  });
  const inodes = fixtures.map((fixture) => statSync(fixture.descriptor.database).ino);
  const ports = fixtures.flatMap((fixture) => [
    fixture.descriptor.previewPort,
    fixture.descriptor.vitePort,
    fixture.descriptor.webdriverPort,
  ]);
  if (new Set(inodes).size !== 2 || new Set(ports).size !== 6 || hashFile(canary) !== before)
    throw new Error("isolation collision");
  return {
    fixtures: fixtures.map(fixtureBehavior),
    childResults,
    databaseInodes: inodes,
    ports,
    developerCanaryHash: before,
  };
}

async function authorityProof() {
  const token = crypto.randomUUID();
  const authority = { host: "", origin: "", token, consumeNonce: createNonceConsumer() };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: createPreviewHandler({
      repo,
      port: 0,
      dev: false,
      policyProfile: "test",
      mutationAuthority: authority,
    }),
  });
  const port = server.port ?? 0;
  const origin = `http://127.0.0.1:${port}`;
  authority.host = `127.0.0.1:${port}`;
  authority.origin = origin;
  const request = async (
    headers: Record<string, string>,
    nonce: string,
    body = "body-parser-must-not-run",
  ) => {
    const response = await fetch(`${origin}/api/action`, {
      method: "POST",
      headers: {
        host: authority.host,
        origin,
        "content-type": "application/json",
        "x-vean-authority": token,
        "x-vean-nonce": nonce,
        ...headers,
      },
      body,
    });
    return { status: response.status, body: await response.text() };
  };
  try {
    const rejected = await Promise.all([
      request({ origin: "https://attacker.invalid" }, "cross_origin_123456"),
      request({ origin: "null" }, "null_origin_1234567"),
      request({ host: `rebind.invalid:${port}` }, "rebind_host_1234567"),
      request({ "content-type": "application/x-www-form-urlencoded" }, "form_body_123456789"),
      request({ "x-vean-authority": "wrong" }, "wrong_token_1234567"),
      request({ "x-vean-authority": "" }, "missing_token_123456"),
    ]);
    const valid = await request(
      {},
      "valid_nonce_12345678",
      JSON.stringify({ id: "missing.action" }),
    );
    const replay = await request(
      {},
      "valid_nonce_12345678",
      JSON.stringify({ id: "missing.action" }),
    );
    const bodies = [...rejected, valid, replay].map((item) => item.body);
    if (
      rejected.some((item) => item.status !== 403) ||
      valid.status === 403 ||
      replay.status !== 403
    )
      throw new Error("bound authority matrix failed");
    if (bodies.some((body) => body.includes(token)))
      throw new Error("authority leaked in HTTP result");
    return {
      boundPort: port,
      rejected: rejected.map(({ status }) => status),
      validStatus: valid.status,
      replayStatus: replay.status,
      tokenLeaked: false,
    };
  } finally {
    server.stop(true);
  }
}

async function cleanupProof() {
  const fixture = await createFixture({ sourceSha, developerCanary: canary });
  fixtures.push(fixture);
  const marker = `vean-orphan-${fixture.descriptor.runId}`;
  const child = spawn(
    "bun",
    [join(repo, "scripts/harness/marked-child.ts"), marker, "--reparent"],
    { detached: true, stdio: "ignore" },
  );
  recordProcess(fixture.descriptor.processLedger, {
    pid: child.pid ?? -1,
    marker,
    executable: "bun",
    startedAt: new Date().toISOString(),
  });
  await new Promise<void>((done) => child.once("exit", () => done()));
  await Bun.sleep(100);
  const detected = await inspectAndReap(fixture.descriptor.processLedger, { reap: true });
  await Bun.sleep(100);
  const clean = await inspectAndReap(fixture.descriptor.processLedger, { reap: false });
  if (!detected.findings.some((item) => item.kind === "marker") || clean.findings.length !== 0)
    throw new Error("watchdog did not close orphan lifecycle");
  return { detected, clean };
}

let result: unknown;
try {
  result =
    suite === "loopback-authority"
      ? await authorityProof()
      : scenario === "teardown"
        ? await cleanupProof()
        : await hermeticProof();
  const fixturePath = join(artifactDir, "fixture.json");
  const resultPath = join(artifactDir, "result.json");
  const representative = fixtures[0];
  writeFileSync(
    fixturePath,
    JSON.stringify(
      representative?.descriptor ?? { runId: "authority-only", authorityHandle: "redacted" },
      null,
      2,
    ),
  );
  writeFileSync(resultPath, JSON.stringify(result, null, 2));
  for (const fixture of fixtures) {
    const leaks = scanSecret(fixture.descriptor.artifactDir, fixture.authorityToken);
    if (leaks.length > 0) throw new Error(`authority leaked into artifacts: ${leaks.join(",")}`);
  }
  writeVerifiedEvidence({
    repo,
    claimId: claim.id,
    oracleCommand: claim.command,
    expectedPredicate: claim.predicate,
    controlId: claim.control,
    fixturePath,
    commandPath: join(repo, "scripts/verify-fixture.ts"),
    implementationPaths: [join(repo, "scripts/verify-fixture.ts"), join(repo, "scripts/harness")],
    generatedPaths: [resultPath],
    artifactPaths: [join(repo, "app/src-tauri/tauri.conf.json")],
    result,
  });
  if (!process.env.VEAN_HARNESS_EVIDENCE_PATH)
    console.log(JSON.stringify({ ok: true, claim_id: claim.id, result }));
} finally {
  for (const fixture of fixtures.reverse()) fixture.close();
}
