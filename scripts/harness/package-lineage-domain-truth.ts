#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = realpathSync(join(import.meta.dirname, "../.."));

function canonical(value: unknown): string {
  if (value === null || ["boolean", "number", "string"].includes(typeof value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(",")}}`;
}

function hash(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function verifyDistributionIdentity(receipt: Record<string, unknown>): string {
  const claimed = receipt.candidate_id;
  if (typeof claimed !== "string") throw new Error("E_LINEAGE_CANDIDATE_ID: missing");
  const { candidate_id: _candidate, ...without } = receipt;
  const observed = hash(canonical(without));
  if (claimed !== observed) throw new Error(`E_LINEAGE_CANDIDATE_ID: ${claimed}`);
  return observed;
}

export function verifyPackageLineageDomainTruth(lineagePath: string) {
  const lineage = resolve(lineagePath);
  if (!existsSync(lineage)) throw new Error(`E_LINEAGE_PARENT_MISSING: ${lineage}`);
  const bytes = readFileSync(lineage, "utf8");
  const receipt = JSON.parse(bytes) as Record<string, unknown>;
  if (bytes !== `${canonical(receipt)}\n`) throw new Error("E_LINEAGE_NONCANONICAL: distribution");
  const candidate = verifyDistributionIdentity(receipt);
  const verifier = join(repo, "scripts", "verify-package.ts");
  const run = spawnSync(
    process.execPath,
    [verifier, "--suite", "candidate-preflight", "--lineage", lineage],
    { cwd: repo, encoding: "utf8" },
  );
  if (run.status !== 0) throw new Error(`E_DOMAIN_VERIFIER_REJECTED: ${run.stderr ?? run.stdout}`);
  const report = JSON.parse(run.stdout) as {
    ok?: boolean;
    candidate_id?: string;
    verifier_sha256?: string;
  };
  if (report.ok !== true || report.candidate_id !== candidate)
    throw new Error("E_DOMAIN_REPORT_MISMATCH");
  const verifierHash = hash(readFileSync(verifier));
  if (report.verifier_sha256 !== verifierHash) throw new Error("E_DOMAIN_VERIFIER_IDENTITY");
  return {
    schema_version: "vean.package-lineage-domain-truth/1",
    ok: true,
    candidate_id: candidate,
    lineage_sha256: hash(bytes),
    verifier_sha256: verifierHash,
    domain_verifier_sha256: hash(readFileSync(import.meta.filename)),
  };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const lineage = option("--lineage");
  if (!lineage) throw new Error("E_LINEAGE_PARENT_MISSING: --lineage");
  console.log(JSON.stringify(verifyPackageLineageDomainTruth(lineage), null, 2));
}
