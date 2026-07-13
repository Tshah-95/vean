#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
// Independent package verifier: deliberately imports no producer manifest,
// lineage, closure-policy, or candidate assembly modules.
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const repo = realpathSync(join(import.meta.dirname, ".."));

class VerificationError extends Error {
  constructor(
    readonly code: string,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (["boolean", "number", "string"].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  throw new VerificationError("E_VERIFY_CANONICAL", typeof value);
}

function hashBytes(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function hashFile(path: string): string {
  return hashBytes(readFileSync(path));
}
function canonicalHash(value: unknown): string {
  return hashBytes(canonical(value));
}
function parseCanonical<T>(path: string): { value: T; bytes: string } {
  const bytes = readFileSync(path, "utf8");
  const value = JSON.parse(bytes) as T;
  if (bytes !== `${canonical(value)}\n`)
    throw new VerificationError("E_LINEAGE_NONCANONICAL", path);
  return { value, bytes };
}

type TreeEntry = {
  path: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  uid: 0;
  gid: 0;
  size: number;
  sha256: string | null;
  symlink_target: string | null;
};

function independentTree(root: string): { entries: TreeEntry[]; tree_sha256: string } {
  const canonicalRoot = realpathSync(root);
  const entries: TreeEntry[] = [];
  const hardlinks = new Map<string, string>();
  const visit = (dir: string) => {
    const children = readdirSync(dir, { encoding: "buffer" })
      .map((bytes) => {
        const value = bytes.toString("utf8");
        if (!Buffer.from(value).equals(bytes))
          throw new VerificationError("E_TREE_INVALID_UTF8", bytes.toString("hex"));
        if ([".DS_Store", ".Trashes", ".fseventsd"].includes(value))
          throw new VerificationError("E_TREE_TRANSIENT", value);
        return { bytes, value };
      })
      .sort((a, b) => Buffer.compare(a.bytes, b.bytes));
    const names = new Map<string, string>();
    for (const child of children) {
      const key = child.value.normalize("NFC").toLocaleLowerCase("en-US");
      if (names.has(key)) throw new VerificationError("E_TREE_NAME_COLLISION", child.value);
      names.set(key, child.value);
      const path = join(dir, child.value);
      const rel = relative(root, path).replaceAll("\\", "/");
      const stat = lstatSync(path);
      if (stat.isSocket() || stat.isFIFO() || stat.isCharacterDevice() || stat.isBlockDevice()) {
        throw new VerificationError("E_TREE_SPECIAL_FILE", rel);
      }
      if (stat.isFile() && stat.nlink > 1) {
        const id = `${stat.dev}:${stat.ino}`;
        if (hardlinks.has(id)) throw new VerificationError("E_TREE_HARDLINK", rel);
        hardlinks.set(id, rel);
      }
      const type = stat.isDirectory()
        ? "directory"
        : stat.isSymbolicLink()
          ? "symlink"
          : stat.isFile()
            ? "file"
            : null;
      if (!type) throw new VerificationError("E_TREE_SPECIAL_FILE", rel);
      const target = type === "symlink" ? readlinkSync(path) : null;
      if (target) {
        if (target.startsWith("/")) throw new VerificationError("E_TREE_SYMLINK_ABSOLUTE", rel);
        let resolved: string;
        try {
          resolved = realpathSync(path);
        } catch {
          throw new VerificationError("E_TREE_SYMLINK_DANGLING", rel);
        }
        if (!resolved.startsWith(`${canonicalRoot}/`))
          throw new VerificationError("E_TREE_SYMLINK_ESCAPE", rel);
      }
      entries.push({
        path: rel,
        type,
        mode: stat.mode & 0o777,
        uid: 0,
        gid: 0,
        size:
          type === "file" ? stat.size : type === "symlink" ? Buffer.byteLength(target ?? "") : 0,
        sha256:
          type === "file" ? hashFile(path) : type === "symlink" ? hashBytes(target ?? "") : null,
        symlink_target: target,
      });
      if (type === "directory") visit(path);
    }
  };
  visit(root);
  return { entries, tree_sha256: canonicalHash(entries) };
}

function run(program: string, args: string[]): string {
  const result = spawnSync(program, args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new VerificationError(
      "E_VERIFY_COMMAND",
      `${program} ${args.join(" ")} ${result.stderr ?? ""}`,
    );
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

type Distribution = {
  candidate_id: string;
  dmg_name: string;
  dmg_sha256: string;
  app_receipt_sha256: string;
  runtime_manifest_sha256: string;
  closure_policy_sha256: string;
  h07_sha256: string;
  lineage_test_sha256: string;
  mutation_policy_sha256: string;
};

export function independentCandidateId(receipt: Distribution): string {
  const { candidate_id: _candidate, ...without } = receipt;
  return canonicalHash(without);
}

export function verifyCandidate(lineagePath: string) {
  const lineage = resolve(lineagePath);
  const dir = resolve(lineage, "..");
  const distribution = parseCanonical<Distribution>(lineage).value;
  if (distribution.candidate_id !== independentCandidateId(distribution)) {
    throw new VerificationError("E_LINEAGE_CANDIDATE_ID", distribution.candidate_id);
  }
  const dmg = join(dir, distribution.dmg_name);
  if (hashFile(dmg) !== distribution.dmg_sha256)
    throw new VerificationError("E_LINEAGE_DMG_STALE", dmg);
  const appReceiptPath = join(dir, "app-receipt.json");
  if (hashFile(appReceiptPath) !== distribution.app_receipt_sha256)
    throw new VerificationError("E_LINEAGE_APP_PARENT", appReceiptPath);
  const appReceipt = parseCanonical<{
    app_tree_sha256: string;
    runtime_manifest_sha256: string;
    closure_policy_sha256: string;
    signature_kind: string;
    signatures: Array<{
      path: string;
      signature: string;
      team_identifier: null;
      timestamp: null;
      notarization_ticket: null;
    }>;
  }>(appReceiptPath).value;
  if (appReceipt.signature_kind !== "adhoc")
    throw new VerificationError("E_SIGNATURE_NOT_ADHOC", appReceipt.signature_kind);
  const policyPath = join(dir, "required-closure-policy.json");
  if (
    hashFile(policyPath) !== distribution.closure_policy_sha256 ||
    appReceipt.closure_policy_sha256 !== distribution.closure_policy_sha256
  ) {
    throw new VerificationError("E_LINEAGE_POLICY_PARENT", policyPath);
  }
  const policy = parseCanonical<{
    h07: Record<string, string>;
    entries: Array<Record<string, unknown>>;
  }>(policyPath).value;
  if (canonicalHash(policy.h07) !== distribution.h07_sha256)
    throw new VerificationError("E_LINEAGE_H07_PARENT", policyPath);
  if (hashFile(join(repo, "tests/package-lineage.test.ts")) !== distribution.lineage_test_sha256) {
    throw new VerificationError("E_LINEAGE_TEST_IDENTITY", "package-lineage.test.ts");
  }
  if (
    hashFile(join(repo, "artifacts/specs/harness-scenarios/package.json")) !==
    distribution.mutation_policy_sha256
  ) {
    throw new VerificationError("E_LINEAGE_MUTATION_POLICY", "package scenario");
  }

  const mount = mkdtempSync(join(tmpdir(), "vean-h08-dmg-"));
  try {
    run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg]);
    const apps = readdirSync(mount).filter((name) => name.endsWith(".app"));
    if (apps.length !== 1) throw new VerificationError("E_DMG_APP_COUNT", String(apps.length));
    const app = join(mount, apps[0] ?? "");
    const tree = independentTree(app);
    if (tree.tree_sha256 !== appReceipt.app_tree_sha256)
      throw new VerificationError("E_APP_TREE_MISMATCH", app);
    const runtimeRoot = join(app, "Contents/Resources/package-runtime");
    const runtimePath = join(runtimeRoot, "runtime-manifest.json");
    if (
      hashFile(runtimePath) !== distribution.runtime_manifest_sha256 ||
      appReceipt.runtime_manifest_sha256 !== distribution.runtime_manifest_sha256
    ) {
      throw new VerificationError("E_LINEAGE_RUNTIME_PARENT", runtimePath);
    }
    const runtime = parseCanonical<{
      required_closure_policy_sha256: string;
      h07: Record<string, string>;
      resources: Array<Record<string, unknown>>;
    }>(runtimePath).value;
    if (runtime.required_closure_policy_sha256 !== distribution.closure_policy_sha256) {
      throw new VerificationError("E_LINEAGE_POLICY_PARENT", runtimePath);
    }
    if (canonical(runtime.resources) !== canonical(policy.entries))
      throw new VerificationError("E_RUNTIME_POLICY_INVENTORY", runtimePath);
    if (canonicalHash(runtime.h07) !== distribution.h07_sha256)
      throw new VerificationError("E_LINEAGE_H07_PARENT", runtimePath);
    for (const signature of appReceipt.signatures) {
      if (
        signature.signature !== "adhoc" ||
        signature.team_identifier !== null ||
        signature.timestamp !== null ||
        signature.notarization_ticket !== null
      ) {
        throw new VerificationError("E_SIGNATURE_CLAIM", signature.path);
      }
      const target = signature.path === "." ? app : join(app, signature.path);
      run("codesign", ["--verify", "--strict", target]);
      const detail = run("codesign", ["-d", "--verbose=4", target]);
      if (!/Signature=adhoc/.test(detail) || /TeamIdentifier=(?!not set)/.test(detail)) {
        throw new VerificationError("E_SIGNATURE_NOT_ADHOC", signature.path);
      }
    }
    run("codesign", ["--verify", "--deep", "--strict", app]);
    return {
      schema_version: "vean.candidate-preflight-evidence/1",
      ok: true,
      candidate_id: distribution.candidate_id,
      lineage_sha256: hashFile(lineage),
      verifier_sha256: hashFile(import.meta.filename),
      app_tree_sha256: tree.tree_sha256,
      runtime_manifest_sha256: distribution.runtime_manifest_sha256,
      closure_policy_sha256: distribution.closure_policy_sha256,
      lineage_test_sha256: distribution.lineage_test_sha256,
      mutation_policy_sha256: distribution.mutation_policy_sha256,
      signature_kind: "adhoc",
      release_claims: {
        developer_id: false,
        notarized: false,
        stapled: false,
        updater: false,
        manual_accessibility: false,
      },
    };
  } finally {
    spawnSync("hdiutil", ["detach", "-force", mount], { encoding: "utf8" });
    rmSync(mount, { recursive: true, force: true });
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  if (option("--suite") !== "candidate-preflight")
    throw new VerificationError("E_VERIFY_SUITE", option("--suite") ?? "missing");
  const lineage = option("--lineage");
  if (!lineage) throw new VerificationError("E_LINEAGE_PARENT_MISSING", "--lineage");
  const report = verifyCandidate(lineage);
  const reportPath = join(resolve(lineage, ".."), "candidate-preflight-report.json");
  writeFileSync(reportPath, `${canonical(report)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
