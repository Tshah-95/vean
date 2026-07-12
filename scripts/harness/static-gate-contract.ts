import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type StaticGateDescriptor = { id: string; command: string };
export type StaticGateProfiles = Record<"developer" | "macos", StaticGateDescriptor[]>;

type StaticGatePolicy = {
  contract_version: string;
  profiles: StaticGateProfiles;
};

const policyPath = resolve(import.meta.dirname, "static-gates-policy.json");

export function readStaticGatePolicy(): StaticGatePolicy {
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as StaticGatePolicy;
  if (policy.contract_version !== "1.0.0") throw new Error("E_STATIC_GATE_POLICY_VERSION");
  return policy;
}

export function assertStaticGateInventory(actual: StaticGateProfiles): void {
  const expected = readStaticGatePolicy().profiles;
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
}
