#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const controlRoot = resolve(root, ".vean/harness/static-control");
const target = resolve(root, "app/src-tauri/src/harness_static_probe.rs");
const beforeSnapshot = resolve(controlRoot, "harness_static_probe.before.rs");
const mutatedSnapshot = resolve(controlRoot, "harness_static_probe.mutated.rs");
const mutationManifest = resolve(controlRoot, "mutation.json");
const controlId = "nc-static-owned-code";

const BASELINE = [
  "// H01 macOS-cfg sensitivity probe. The harness temporarily replaces this file",
  "// with a dead-code warning and requires pinned-target Clippy to reject it.",
  "",
].join("\n");
const MUTATED = [
  "// Intentional H01 negative control: valid Rust that warns only for the macOS target.",
  '#[cfg(target_os = "macos")]',
  "fn intentionally_unused_macos_static_probe() {}",
  "",
].join("\n");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export type StaticControl = {
  controlId: string;
  target: string;
  beforeSnapshot: string;
  mutatedSnapshot: string;
  mutationManifest: string;
  beforeHash: string;
  mutatedHash: string;
};

export function prepareStaticControl(requireBaseline = true): StaticControl {
  mkdirSync(controlRoot, { recursive: true });
  writeFileSync(beforeSnapshot, BASELINE);
  writeFileSync(mutatedSnapshot, MUTATED);
  if (requireBaseline && readFileSync(target, "utf8") !== BASELINE) {
    throw new Error(`${relative(root, target)} is not at the controlled baseline`);
  }
  const beforeHash = sha256(beforeSnapshot);
  const mutatedHash = sha256(mutatedSnapshot);
  writeJson(mutationManifest, {
    contract_version: "1.0.0",
    control_id: controlId,
    before_hash: beforeHash,
    mutated_hash: mutatedHash,
    changed_paths: [
      {
        path: relative(dirname(mutationManifest), target),
        before_snapshot_path: relative(dirname(mutationManifest), beforeSnapshot),
        mutated_snapshot_path: relative(dirname(mutationManifest), mutatedSnapshot),
        before_hash: beforeHash,
        mutated_hash: mutatedHash,
        restored_hash: beforeHash,
      },
    ],
  });
  return {
    controlId,
    target,
    beforeSnapshot,
    mutatedSnapshot,
    mutationManifest,
    beforeHash,
    mutatedHash,
  };
}

export function mutateStaticControl(mode: "control" | "restore"): StaticControl {
  const prepared = prepareStaticControl(mode === "control");
  writeFileSync(
    prepared.target,
    readFileSync(mode === "control" ? prepared.mutatedSnapshot : prepared.beforeSnapshot),
  );
  const expected = mode === "control" ? prepared.mutatedHash : prepared.beforeHash;
  if (sha256(prepared.target) !== expected) throw new Error(`failed to ${mode} static probe`);
  return prepared;
}

function cli(): void {
  const requestedId = process.argv.includes("--control")
    ? process.argv[process.argv.indexOf("--control") + 1]
    : undefined;
  if (requestedId && requestedId !== controlId) {
    throw new Error(`unsupported control: ${requestedId}`);
  }
  const mode = process.argv.includes("--restore") ? "restore" : "control";
  const result = mutateStaticControl(mode);
  console.log(
    JSON.stringify({
      control_id: result.controlId,
      mode,
      before_hash: result.beforeHash,
      mutated_hash: result.mutatedHash,
    }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.dirname, "static-owned-control.ts")
)
  cli();
