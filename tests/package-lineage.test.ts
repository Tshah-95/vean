import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, canonicalSha256 } from "../scripts/harness/package-json";
import {
  type AppReceipt,
  type DistributionReceipt,
  type PackageLineageError,
  type RuntimeManifest,
  candidateId,
  verifyLineageDocuments,
} from "../scripts/harness/package-lineage";
import {
  decodePortableName,
  inventoryTree,
  treeManifest,
  validatePortableNames,
} from "../scripts/harness/package-manifest";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function documents() {
  const runtime: RuntimeManifest = {
    schema_version: "vean.runtime-manifest/1",
    source_sha: "a".repeat(40),
    runtime_mode: "package",
    h07: { fixture: "1".repeat(64) },
    required_closure_policy_sha256: "2".repeat(64),
    resources: [{ relative_path: "core/vean-core", sha256: "3".repeat(64) }],
  };
  const runtimeBytes = `${canonicalJson(runtime)}\n`;
  const runtimeHash = createHash("sha256").update(runtimeBytes).digest("hex");
  const app: AppReceipt = {
    schema_version: "vean.app-receipt/1",
    app_name: "Vean.app",
    app_tree_sha256: "4".repeat(64),
    runtime_manifest_sha256: runtimeHash,
    closure_policy_sha256: runtime.required_closure_policy_sha256,
    signatures: [],
    signature_kind: "adhoc",
  };
  const appBytes = `${canonicalJson(app)}\n`;
  const h07Sha = canonicalSha256(runtime.h07);
  const distribution: DistributionReceipt = {
    schema_version: "vean.distribution-receipt/1",
    dmg_name: "Vean.dmg",
    dmg_sha256: "5".repeat(64),
    app_receipt_sha256: createHash("sha256").update(appBytes).digest("hex"),
    runtime_manifest_sha256: runtimeHash,
    closure_policy_sha256: runtime.required_closure_policy_sha256,
    h07_sha256: h07Sha,
    lineage_test_sha256: "6".repeat(64),
    mutation_policy_sha256: "7".repeat(64),
  };
  distribution.candidate_id = candidateId(distribution);
  return {
    runtime,
    runtimeBytes,
    app,
    appBytes,
    distribution,
    dmgSha256: distribution.dmg_sha256,
    expectedH07Sha256: h07Sha,
  };
}

function code(run: () => void): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as PackageLineageError).code;
  }
  return undefined;
}

describe("acyclic package lineage", () => {
  it("is canonical and stable across serialization passes", () => {
    const input = documents();
    expect(canonicalJson(JSON.parse(input.runtimeBytes))).toBe(input.runtimeBytes.trim());
    expect(canonicalJson(input.distribution)).toBe(
      canonicalJson(JSON.parse(canonicalJson(input.distribution))),
    );
    expect(() => verifyLineageDocuments(input)).not.toThrow();
  });

  it("rejects runtime self-reference", () => {
    const input = documents();
    input.runtime.resources.push({ relative_path: "runtime-manifest.json" });
    expect(code(() => verifyLineageDocuments(input))).toBe("E_LINEAGE_SELF_REFERENCE");
  });

  it.each([
    [
      "wrong runtime parent",
      "E_LINEAGE_RUNTIME_PARENT",
      (input: ReturnType<typeof documents>) => {
        input.app.runtime_manifest_sha256 = "0".repeat(64);
        input.appBytes = `${canonicalJson(input.app)}\n`;
        input.distribution.app_receipt_sha256 = createHash("sha256")
          .update(input.appBytes)
          .digest("hex");
        input.distribution.candidate_id = candidateId(input.distribution);
      },
    ],
    [
      "wrong app parent",
      "E_LINEAGE_APP_PARENT",
      (input: ReturnType<typeof documents>) => {
        input.distribution.app_receipt_sha256 = "0".repeat(64);
        input.distribution.candidate_id = candidateId(input.distribution);
      },
    ],
    [
      "stale DMG",
      "E_LINEAGE_DMG_STALE",
      (input: ReturnType<typeof documents>) => {
        input.dmgSha256 = "0".repeat(64);
      },
    ],
    [
      "different H07",
      "E_LINEAGE_H07_PARENT",
      (input: ReturnType<typeof documents>) => {
        input.expectedH07Sha256 = "0".repeat(64);
      },
    ],
    [
      "candidate id",
      "E_LINEAGE_CANDIDATE_ID",
      (input: ReturnType<typeof documents>) => {
        input.distribution.candidate_id = "0".repeat(64);
      },
    ],
  ])("rejects %s with a stable code", (_name, expected, mutate) => {
    const input = documents();
    mutate(input);
    expect(code(() => verifyLineageDocuments(input))).toBe(expected);
  });
});

describe("canonical app tree", () => {
  function tree(): string {
    const root = mkdtempSync(join(tmpdir(), "vean-tree-"));
    roots.push(root);
    mkdirSync(join(root, "Contents/Resources"), { recursive: true });
    writeFileSync(join(root, "Contents/Resources/a"), "a");
    writeFileSync(join(root, "Contents/Resources/b"), "b");
    spawnSync("xattr", ["-cr", root]);
    return root;
  }

  it("orders by raw UTF-8 bytes and pins path, content, type, mode, and ownership", () => {
    const root = tree();
    const first = treeManifest(root);
    const second = treeManifest(root);
    expect(first).toEqual(second);
    expect(first.entries.map((entry) => entry.path)).toEqual(
      [...first.entries.map((entry) => entry.path)].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      ),
    );
    chmodSync(join(root, "Contents/Resources/a"), 0o600);
    expect(treeManifest(root).tree_sha256).not.toBe(first.tree_sha256);
  });

  it("rejects invalid UTF-8, NFC/case collisions, transient files, hard links, and escaping links", () => {
    expect(() => decodePortableName(Buffer.from([0xff]))).toThrowError(/E_TREE_INVALID_UTF8/);
    expect(() => validatePortableNames(["Alpha", "alpha"])).toThrowError(/E_TREE_NAME_COLLISION/);
    expect(() => validatePortableNames(["é", "e\u0301"])).toThrowError(/E_TREE_NAME_COLLISION/);
    const transient = tree();
    writeFileSync(join(transient, ".DS_Store"), "x");
    expect(() => inventoryTree(transient)).toThrowError(/E_TREE_TRANSIENT/);
    const hard = tree();
    linkSync(join(hard, "Contents/Resources/a"), join(hard, "Contents/Resources/c"));
    expect(() => inventoryTree(hard)).toThrowError(/E_TREE_HARDLINK/);
    const link = tree();
    symlinkSync("/tmp", join(link, "Contents/Resources/escape"));
    expect(() => inventoryTree(link)).toThrowError(/E_TREE_SYMLINK_ABSOLUTE/);
  });
});
