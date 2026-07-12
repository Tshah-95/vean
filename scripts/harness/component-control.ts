#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(import.meta.dirname, "../..");
export const componentControlIds = ["nc-react-components", "nc-dom-accessibility"] as const;
export type ComponentControlId = (typeof componentControlIds)[number];

// This is the complete H03 oracle authority set. Both component claims share
// the same browser runner and product semantics, so the truth manifest and the
// emitted evidence must name this exact set (neither a package.json proxy nor a
// partial subset is sufficient).
export const componentOracleImplementationPaths = [
  "scripts/verify-component.ts",
  "scripts/harness/component-control.ts",
  "viewer/vitest.browser.config.ts",
  "viewer/test/setup-browser.ts",
  "viewer/test/timeline.browser.test.tsx",
  "viewer/src/components/TimelineStrip.tsx",
  "viewer/src/components/ClipBlock.tsx",
  "viewer/src/timelineKeyboard.ts",
  "viewer/src/useTimelineEditor.ts",
] as const;

const definitions: Record<
  ComponentControlId,
  { target: string; baseline: string; mutated: string; semanticMutation: string }
> = {
  "nc-react-components": {
    target: resolve(repo, "viewer/src/timelineKeyboard.ts"),
    baseline: 'const delta = key === "ArrowUp" ? -1 : 1;',
    mutated: 'const delta = key === "ArrowUp" ? -1 : -1;',
    semanticMutation: "ArrowDown incorrectly navigates upward in real product source",
  },
  "nc-dom-accessibility": {
    target: resolve(repo, "viewer/src/components/ClipBlock.tsx"),
    baseline: "aria-label={accessibleName}",
    mutated: "aria-label={undefined}",
    semanticMutation: "selectable clip loses its accessible name in real product source",
  },
};

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function isComponentControlId(value: string): value is ComponentControlId {
  return componentControlIds.includes(value as ComponentControlId);
}

export function prepareComponentControl(controlId: ComponentControlId, requireBaseline = true) {
  const definition = definitions[controlId];
  const root = resolve(repo, ".vean/harness/controls", controlId);
  const beforeSnapshot = resolve(root, "product-source.before.tsx");
  const mutatedSnapshot = resolve(root, "product-source.mutated.tsx");
  const manifestPath = resolve(root, "mutation.json");
  const source = readFileSync(definition.target, "utf8");
  if (requireBaseline && !source.includes(definition.baseline)) {
    throw new Error(`${controlId} baseline product source is absent`);
  }
  const baseline = source.includes(definition.baseline)
    ? source
    : readFileSync(beforeSnapshot, "utf8");
  const mutated = baseline.replace(definition.baseline, definition.mutated);
  if (mutated === baseline || mutated.includes(definition.baseline)) {
    throw new Error(`${controlId} did not make its exact product-source mutation`);
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
        control_id: controlId,
        before_hash: beforeHash,
        mutated_hash: mutatedHash,
        semantic_mutation: definition.semanticMutation,
        changed_paths: [
          {
            path: relative(root, definition.target),
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
    target: definition.target,
    manifestPath,
    before_hash: beforeHash,
    mutated_hash: mutatedHash,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controlId = process.argv[2];
  if (!controlId || !isComponentControlId(controlId))
    throw new Error("component control id required");
  console.log(
    JSON.stringify(prepareComponentControl(controlId, !process.argv.includes("--allow-mutated"))),
  );
}
