#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(import.meta.dirname, "../..");
export const nativeMacosControlId = "nc-native-macos-shell";
const root = resolve(repo, ".vean/harness/controls", nativeMacosControlId);
const target = resolve(repo, "app/src-tauri/src/lib.rs");
const beforeSnapshot = resolve(root, "lib.before.rs");
const mutatedSnapshot = resolve(root, "lib.mutated.rs");
const manifestPath = resolve(root, "mutation.json");
const baselineNeedle = 'MenuItemBuilder::with_id("open_project", "Open Project Folder…")';
const mutatedNeedle = 'MenuItemBuilder::with_id("open_project", "Open Different Folder…")';

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export type NativeMacosControl = {
  target: string;
  manifestPath: string;
  beforeHash: string;
  mutatedHash: string;
};

export function prepareNativeMacosControl(requireBaseline = true): NativeMacosControl {
  const source = readFileSync(target, "utf8");
  if (requireBaseline && !source.includes(baselineNeedle)) {
    throw new Error("native menu control baseline label is absent");
  }
  const baseline = source.includes(baselineNeedle) ? source : readFileSync(beforeSnapshot, "utf8");
  const mutated = baseline.replace(baselineNeedle, mutatedNeedle);
  if (mutated === baseline || mutated.includes(baselineNeedle)) {
    throw new Error("native menu control did not make the exact semantic label substitution");
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(beforeSnapshot, baseline);
  writeFileSync(mutatedSnapshot, mutated);
  const beforeHash = hash(beforeSnapshot);
  const mutatedHash = hash(mutatedSnapshot);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        contract_version: "1.0.0",
        control_id: nativeMacosControlId,
        before_hash: beforeHash,
        mutated_hash: mutatedHash,
        semantic_mutation: {
          surface: "File menu",
          baseline_accessible_name: "Open Project Folder…",
          mutated_accessible_name: "Open Different Folder…",
        },
        changed_paths: [
          {
            path: relative(root, target),
            before_snapshot_path: relative(root, beforeSnapshot),
            mutated_snapshot_path: relative(root, mutatedSnapshot),
            before_hash: beforeHash,
            mutated_hash: mutatedHash,
            restored_hash: beforeHash,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  return { target, manifestPath, beforeHash, mutatedHash };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const control = prepareNativeMacosControl(process.argv.includes("--allow-mutated") === false);
  console.log(JSON.stringify(control));
}
