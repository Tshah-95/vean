import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { canonicalJson, canonicalSha256 } from "./package-json";

export type TreeEntry = {
  path: string;
  type: "directory" | "file" | "symlink";
  mode: number;
  uid: 0;
  gid: 0;
  size: number;
  sha256: string | null;
  symlink_target: string | null;
};

function byteCompare(a: Buffer, b: Buffer): number {
  return Buffer.compare(a, b);
}

export function decodePortableName(bytes: Buffer): string {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes))
    throw new Error(`E_TREE_INVALID_UTF8: ${bytes.toString("hex")}`);
  if ([".DS_Store", ".Trashes", ".fseventsd"].includes(value))
    throw new Error(`E_TREE_TRANSIENT: ${value}`);
  return value;
}

export function validatePortableNames(values: string[]): void {
  const normalized = new Map<string, string>();
  for (const value of values) {
    const key = value.normalize("NFC").toLocaleLowerCase("en-US");
    const prior = normalized.get(key);
    if (prior) throw new Error(`E_TREE_NAME_COLLISION: ${prior} <> ${value}`);
    normalized.set(key, value);
  }
}

function names(path: string): Array<{ bytes: Buffer; value: string }> {
  return readdirSync(path, { encoding: "buffer" })
    .map((bytes) => ({ bytes, value: decodePortableName(bytes) }))
    .sort((a, b) => byteCompare(a.bytes, b.bytes));
}

export function inventoryTree(root: string): TreeEntry[] {
  const canonicalRoot = realpathSync(root);
  const entries: TreeEntry[] = [];
  const hardlinks = new Map<string, string>();
  const visit = (dir: string) => {
    const children = names(dir);
    validatePortableNames(children.map((child) => child.value));
    for (const child of children) {
      const path = join(dir, child.value);
      const relativePath = relative(root, path).replaceAll("\\", "/");
      const stat = lstatSync(path);
      if (stat.isSocket() || stat.isFIFO() || stat.isCharacterDevice() || stat.isBlockDevice()) {
        throw new Error(`E_TREE_SPECIAL_FILE: ${relativePath}`);
      }
      if (stat.isFile() && stat.nlink > 1) {
        const identity = `${stat.dev}:${stat.ino}`;
        const priorLink = hardlinks.get(identity);
        if (priorLink) throw new Error(`E_TREE_HARDLINK: ${priorLink} <> ${relativePath}`);
        hardlinks.set(identity, relativePath);
      }
      const type = stat.isDirectory()
        ? "directory"
        : stat.isSymbolicLink()
          ? "symlink"
          : stat.isFile()
            ? "file"
            : null;
      if (!type) throw new Error(`E_TREE_SPECIAL_FILE: ${relativePath}`);
      const target = type === "symlink" ? readlinkSync(path) : null;
      if (target && isAbsolute(target)) throw new Error(`E_TREE_SYMLINK_ABSOLUTE: ${relativePath}`);
      if (target) {
        let resolved: string;
        try {
          resolved = realpathSync(path);
        } catch {
          throw new Error(`E_TREE_SYMLINK_DANGLING: ${relativePath}`);
        }
        if (!resolved.startsWith(`${canonicalRoot}/`))
          throw new Error(`E_TREE_SYMLINK_ESCAPE: ${relativePath}`);
      }
      entries.push({
        path: relativePath,
        type,
        mode: stat.mode & 0o777,
        uid: 0,
        gid: 0,
        size:
          type === "file" ? stat.size : type === "symlink" ? Buffer.byteLength(target ?? "") : 0,
        sha256:
          type === "file"
            ? createHash("sha256").update(readFileSync(path)).digest("hex")
            : type === "symlink"
              ? createHash("sha256")
                  .update(target ?? "")
                  .digest("hex")
              : null,
        symlink_target: target,
      });
      if (type === "directory") visit(path);
    }
  };
  visit(root);
  return entries;
}

export function treeManifest(root: string) {
  const xattrNames = (() => {
    if (process.platform !== "darwin") return [];
    const xattrs = spawnSync("xattr", ["-lr", root], { encoding: "utf8" });
    if (xattrs.status !== 0) throw new Error(`E_TREE_XATTR_SCAN: ${xattrs.stderr ?? ""}`);
    return [...xattrs.stdout.matchAll(/: (com\.apple\.[^:]+):(?: |$)/gm)].map(
      (match) => match[1] ?? "",
    );
  })();
  const unclassified = xattrNames.find((name) => name !== "com.apple.provenance");
  if (unclassified) throw new Error(`E_TREE_XATTR_UNCLASSIFIED: ${unclassified}`);
  const entries = inventoryTree(root);
  return {
    schema_version: "vean.tree-manifest/1",
    ordering: "raw-utf8-bytewise",
    ownership: "normalized-uid-gid-zero",
    approved_xattrs: xattrNames.includes("com.apple.provenance")
      ? ["com.apple.provenance:platform-managed"]
      : [],
    entries,
    tree_sha256: canonicalSha256(entries),
  };
}

export function hashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function canonicalFileHash(value: unknown): string {
  return createHash("sha256")
    .update(`${canonicalJson(value)}\n`)
    .digest("hex");
}
