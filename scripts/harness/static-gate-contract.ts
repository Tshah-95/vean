import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type StaticGateDescriptor = { id: string; command: string };
export type StaticGateProfiles = Record<"developer" | "macos", StaticGateDescriptor[]>;
export type StaticPackageScripts = Record<string, Record<string, string>>;

type StaticGatePolicy = {
  contract_version: string;
  script_bodies: StaticPackageScripts;
  profiles: StaticGateProfiles;
};

const policyPath = resolve(import.meta.dirname, "static-gates-policy.json");

export function readStaticGatePolicy(): StaticGatePolicy {
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as StaticGatePolicy;
  if (policy.contract_version !== "1.0.0") throw new Error("E_STATIC_GATE_POLICY_VERSION");
  return policy;
}

export function readStaticPackageScripts(): StaticPackageScripts {
  const root = resolve(import.meta.dirname, "../..");
  const paths = ["package.json", "viewer/package.json", "remotion/package.json"];
  return Object.fromEntries(
    paths.map((path) => {
      const manifest = JSON.parse(readFileSync(resolve(root, path), "utf8")) as {
        scripts?: Record<string, string>;
      };
      return [path, manifest.scripts ?? {}];
    }),
  );
}

export function assertStaticGateInventory(
  actual: StaticGateProfiles,
  actualScripts = readStaticPackageScripts(),
): void {
  const policy = readStaticGatePolicy();
  const expected = policy.profiles;
  for (const profile of ["developer", "macos"] as const) {
    const expectedById = new Map(expected[profile].map((gate) => [gate.id, gate.command]));
    const actualById = new Map(actual[profile].map((gate) => [gate.id, gate.command]));
    for (const [id, command] of expectedById) {
      if (!actualById.has(id)) throw new Error(`E_STATIC_GATE_MISSING:${profile}:${id}`);
      if (actualById.get(id) !== command) {
        throw new Error(`E_STATIC_GATE_COMMAND:${profile}:${id}`);
      }
    }
    for (const id of actualById.keys()) {
      if (!expectedById.has(id)) throw new Error(`E_STATIC_GATE_UNAPPROVED:${profile}:${id}`);
    }
    if (actualById.size !== expectedById.size) {
      throw new Error(`E_STATIC_GATE_COUNT:${profile}`);
    }
  }
  for (const [manifest, scripts] of Object.entries(policy.script_bodies)) {
    for (const [name, body] of Object.entries(scripts)) {
      if (actualScripts[manifest]?.[name] !== body) {
        throw new Error(`E_STATIC_SCRIPT_BODY:${manifest}:${name}`);
      }
    }
  }
}
