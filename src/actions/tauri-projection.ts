// Derive Tauri invoke-command descriptors + capability requirements from the
// canonical action registry — the Move-3F "generate Tauri descriptors from action
// metadata" deliverable. This is a PURE projection over `listActions()`: the app
// consumes it to know which actions exist, what they mutate, and which native
// capabilities they imply, WITHOUT duplicating domain logic or editing each action.
//
// Every action is invoked through the single generic `run_action` command (id +
// input), so `command` is constant; the per-action payload is the id, the effect
// hints already computed by the registry, and the capability set the app shell
// must grant for that action's scopes.
import { describeAction, listActions } from "./registry";
import type { ActionDescriptor, ActionScope } from "./types";

/** A Tauri-facing descriptor for one action: how the app invokes it + the native
 *  capability/effect surface it touches. */
export type TauriActionDescriptor = {
  id: string;
  title: string;
  /** Constant: the generic bridge command in `app/src-tauri/src/lib.rs`. */
  command: "run_action";
  windows: string[];
  scopes: ActionScope[];
  /** Tauri permissions the action's scopes imply for the app shell. */
  capabilities: string[];
  destructive: boolean;
  readOnly: boolean;
  approval: ActionDescriptor["effect"]["approval"];
};

/** Map a vean scope to the Tauri capability/permission it implies for the app
 *  shell. Closed-world reads/compute need nothing beyond `core:default`; writes,
 *  process execution, and fs/open access map to the plugin permissions the app
 *  must grant. This is a projection of vean's NATIVE effect metadata onto Tauri's
 *  capability model — Tauri's annotations are not the authorization source. */
const SCOPE_CAPABILITY: Partial<Record<ActionScope, string[]>> = {
  "fs:read": ["fs:allow-read"],
  "fs:write": ["fs:allow-write"],
  "process:execute": ["shell:allow-execute"],
  "external:open": ["shell:allow-open"],
};

/** The capability set a group of scopes implies, always including `core:default`. */
export function capabilitiesForScopes(scopes: ActionScope[]): string[] {
  const caps = new Set<string>(["core:default"]);
  for (const scope of scopes) {
    for (const cap of SCOPE_CAPABILITY[scope] ?? []) caps.add(cap);
  }
  return [...caps].sort();
}

/** Project one action descriptor to its Tauri form. */
export function projectTauriAction(
  descriptor: ActionDescriptor,
  windows: string[] = ["main"],
): TauriActionDescriptor {
  const tauri = descriptor.surfaces.tauri;
  return {
    id: descriptor.id,
    title: descriptor.title,
    command: "run_action",
    windows: tauri?.windows ?? windows,
    scopes: descriptor.scopes,
    capabilities: capabilitiesForScopes(descriptor.scopes),
    destructive: descriptor.effect.destructive,
    readOnly: descriptor.mcpAnnotations.readOnlyHint,
    approval: descriptor.effect.approval,
  };
}

/** The full Tauri projection of the registry — the manifest the app consumes. */
export function projectTauriActions(): TauriActionDescriptor[] {
  return listActions()
    .map((action) => projectTauriAction(describeAction(action)))
    .sort((a, b) => a.id.localeCompare(b.id));
}
