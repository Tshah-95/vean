#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(import.meta.dirname, "../..");
export const browserControlIds = ["nc-browser-editor", "nc-browser-current-uri"] as const;
export type BrowserControlId = (typeof browserControlIds)[number];

export const browserOracleImplementationPaths = [
  "scripts/verify-browser.ts",
  "scripts/harness/browser-control.ts",
  "scripts/harness/browser-domain-truth.ts",
  "e2e/browser/editor.spec.ts",
  "viewer/src/api.ts",
  "viewer/src/useTimelineEditor.ts",
  "src/preview/server.ts",
] as const;

const baseline = 'return postJson<SaveResult>("/api/save", { route });';
const definitions: Record<BrowserControlId, { mutated: string; semanticMutation: string }> = {
  "nc-browser-editor": {
    mutated: 'return Promise.resolve({ ok: true, path: route ?? "timeline:main" });',
    semanticMutation: "the visible editor reports save success without persisting the working IR",
  },
  "nc-browser-current-uri": {
    mutated:
      'return postJson<SaveResult>("/api/save", { route: new URLSearchParams(window.location.search).get("decoyRoute") ?? route });',
    semanticMutation: "save persists the expected edit to a different timeline URI",
  },
};

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function isBrowserControlId(value: string): value is BrowserControlId {
  return browserControlIds.includes(value as BrowserControlId);
}

export function prepareBrowserControl(controlId: BrowserControlId, requireBaseline = true) {
  const definition = definitions[controlId];
  const target = resolve(repo, "viewer/src/api.ts");
  const root = resolve(repo, ".vean/harness/controls", controlId);
  const beforeSnapshot = resolve(root, "product-source.before.ts");
  const mutatedSnapshot = resolve(root, "product-source.mutated.ts");
  const manifestPath = resolve(root, "mutation.json");
  const source = readFileSync(target, "utf8");
  if (requireBaseline && !source.includes(baseline)) {
    throw new Error(`${controlId} baseline product source is absent`);
  }
  const before = source.includes(baseline) ? source : readFileSync(beforeSnapshot, "utf8");
  const mutated = before.replace(baseline, definition.mutated);
  if (mutated === before || mutated.includes(baseline)) {
    throw new Error(`${controlId} did not make its exact product-source mutation`);
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(beforeSnapshot, before);
  writeFileSync(mutatedSnapshot, mutated);
  const beforeHash = hash(beforeSnapshot);
  const mutatedHash = hash(mutatedSnapshot);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        contract_version: "1.0.0",
        control_id: controlId,
        before_hash: beforeHash,
        mutated_hash: mutatedHash,
        semantic_mutation: definition.semanticMutation,
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
  return {
    control_id: controlId,
    target,
    manifestPath,
    before_hash: beforeHash,
    mutated_hash: mutatedHash,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controlId = process.argv[2];
  if (!controlId || !isBrowserControlId(controlId)) throw new Error("browser control id required");
  console.log(
    JSON.stringify(prepareBrowserControl(controlId, !process.argv.includes("--allow-mutated"))),
  );
}
