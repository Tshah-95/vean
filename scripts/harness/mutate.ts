#!/usr/bin/env bun
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { controlRoot } from "./evidence";
import { nativeMacosControlId, prepareNativeMacosControl } from "./native-macos-control";

const controlIndex = process.argv.indexOf("--control");
const controlId =
  controlIndex >= 0
    ? process.argv[controlIndex + 1]
    : process.argv.find((value) => /^nc-[a-z0-9-]+$/.test(value));
if (!controlId || !/^nc-[a-z0-9-]+$/.test(controlId))
  throw new Error("valid --control is required");
if (controlId === nativeMacosControlId) {
  prepareNativeMacosControl(!process.argv.includes("--restore"));
}
const root = controlRoot(process.cwd(), controlId);
const manifest = JSON.parse(readFileSync(join(root, "mutation.json"), "utf8")) as {
  control_id: string;
  changed_paths: Array<{
    path: string;
    before_snapshot_path: string;
    mutated_snapshot_path: string;
  }>;
};
if (
  manifest.control_id !== controlId ||
  !Array.isArray(manifest.changed_paths) ||
  manifest.changed_paths.length === 0
) {
  throw new Error(`invalid mutation definition for ${controlId}`);
}
for (const changed of manifest.changed_paths) {
  const source = process.argv.includes("--restore")
    ? changed.before_snapshot_path
    : changed.mutated_snapshot_path;
  copyFileSync(join(root, source), join(root, changed.path));
}
