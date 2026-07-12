import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { type RuntimeLayout, type RuntimeResource, runtimeLayoutSchema } from "./layout-schema";
import { compiledRuntimeMode } from "./mode";

export type RuntimeLayoutErrorCode =
  | "E_RUNTIME_LAYOUT_INVALID"
  | "E_RUNTIME_MODE_MISMATCH"
  | "E_RUNTIME_PATH_ESCAPE"
  | "E_RUNTIME_PATH_SYMLINK"
  | "E_RUNTIME_PATH_DANGLING"
  | "E_RUNTIME_PATH_TYPE"
  | "E_RUNTIME_PATH_HARDLINK"
  | "E_RUNTIME_PATH_MODE"
  | "E_RUNTIME_PATH_IDENTITY"
  | "E_RUNTIME_HASH_MISMATCH"
  | "E_RUNTIME_RESOURCE_MISSING";

export class RuntimeLayoutError extends Error {
  constructor(
    readonly code: RuntimeLayoutErrorCode,
    message: string,
    readonly resource?: string,
  ) {
    super(`${code}: ${message}${resource ? ` (${resource})` : ""}`);
    this.name = "RuntimeLayoutError";
  }
}

let activeLayout: RuntimeLayout | null = null;
const verifiedRootIdentity = new WeakMap<
  RuntimeLayout,
  { dev: number; ino: number; path: string }
>();

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function loadRuntimeLayout(
  path: string,
  expectedMode?: RuntimeLayout["mode"],
): RuntimeLayout {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new RuntimeLayoutError(
      "E_RUNTIME_LAYOUT_INVALID",
      `cannot read ${path}: ${String(error)}`,
    );
  }
  const result = runtimeLayoutSchema.safeParse(parsed);
  if (!result.success) {
    throw new RuntimeLayoutError("E_RUNTIME_LAYOUT_INVALID", result.error.message);
  }
  if (expectedMode && result.data.mode !== expectedMode) {
    throw new RuntimeLayoutError(
      "E_RUNTIME_MODE_MISMATCH",
      `compiled ${expectedMode} runtime received ${result.data.mode} layout`,
    );
  }
  return result.data;
}

export function configureRuntimeLayout(layout: RuntimeLayout): void {
  activeLayout = runtimeLayoutSchema.parse(layout);
}

export function configureRuntimeLayoutFromFile(
  path: string,
  expectedMode: RuntimeLayout["mode"] = compiledRuntimeMode(),
): RuntimeLayout {
  const layout = loadRuntimeLayout(path, expectedMode);
  configureRuntimeLayout(layout);
  return layout;
}

export function preflightRuntimeLayout(layout: RuntimeLayout): void {
  for (const resource of layout.resources) {
    if (resource.requirement !== "startup-required") continue;
    const verified = openVerifiedRuntimeResource(layout, resource.id);
    verified.close();
  }
}

export function currentRuntimeLayout(): RuntimeLayout | null {
  return activeLayout;
}

export function runtimeMode(): RuntimeLayout["mode"] {
  return activeLayout?.mode ?? "development";
}

export function packageMode(): boolean {
  return runtimeMode() === "package";
}

function isBeneath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateRelativePath(path: string): void {
  if (
    isAbsolute(path) ||
    path === "." ||
    path
      .split(/[\\/]/)
      .some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new RuntimeLayoutError(
      "E_RUNTIME_PATH_ESCAPE",
      "resource path must be normalized and relative",
      path,
    );
  }
}

export type VerifiedRuntimeResource = {
  resource: RuntimeResource;
  path: string;
  fd: number;
  close(): void;
};

/** Verify and open a runtime resource. The returned fd remains held so callers
 * can read through the verified identity instead of reopening a mutable path. */
export function openVerifiedRuntimeResource(
  layout: RuntimeLayout,
  id: string,
  testHookBeforeOpen?: () => void,
): VerifiedRuntimeResource {
  const resource = layout.resources.find((entry) => entry.id === id);
  if (!resource)
    throw new RuntimeLayoutError("E_RUNTIME_RESOURCE_MISSING", "resource is not inventoried", id);
  validateRelativePath(resource.relative_path);

  let root: string;
  try {
    root = realpathSync(layout.package_root);
  } catch {
    throw new RuntimeLayoutError(
      "E_RUNTIME_PATH_DANGLING",
      "package root does not exist",
      layout.package_root,
    );
  }
  const rootStat = lstatSync(root);
  const priorRoot = verifiedRootIdentity.get(layout);
  if (
    priorRoot &&
    (priorRoot.dev !== rootStat.dev || priorRoot.ino !== rootStat.ino || priorRoot.path !== root)
  ) {
    throw new RuntimeLayoutError(
      "E_RUNTIME_PATH_IDENTITY",
      "package root identity changed",
      layout.package_root,
    );
  }
  verifiedRootIdentity.set(layout, { dev: rootStat.dev, ino: rootStat.ino, path: root });
  const components = resource.relative_path.split("/");
  let cursor = root;
  for (const component of components) {
    if (!readdirSync(cursor).includes(component)) {
      throw new RuntimeLayoutError(
        "E_RUNTIME_PATH_DANGLING",
        "resource component casing or normalization differs",
        resource.relative_path,
      );
    }
    cursor = resolve(cursor, component);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(cursor);
    } catch {
      throw new RuntimeLayoutError(
        "E_RUNTIME_PATH_DANGLING",
        "resource component does not exist",
        resource.relative_path,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new RuntimeLayoutError(
        "E_RUNTIME_PATH_SYMLINK",
        "runtime resource paths may not contain symlinks",
        resource.relative_path,
      );
    }
  }
  let canonical: string;
  try {
    canonical = realpathSync(cursor);
  } catch {
    throw new RuntimeLayoutError(
      "E_RUNTIME_PATH_DANGLING",
      "resource target does not exist",
      resource.relative_path,
    );
  }
  if (!isBeneath(root, canonical)) {
    throw new RuntimeLayoutError(
      "E_RUNTIME_PATH_ESCAPE",
      "canonical target escaped package root",
      resource.relative_path,
    );
  }

  const before = lstatSync(canonical);
  if (!before.isFile())
    throw new RuntimeLayoutError(
      "E_RUNTIME_PATH_TYPE",
      "resource is not a regular file",
      resource.relative_path,
    );
  if (before.nlink !== 1)
    throw new RuntimeLayoutError(
      "E_RUNTIME_PATH_HARDLINK",
      "resource has an unapproved hard link",
      resource.relative_path,
    );
  if ((before.mode & 0o777) !== resource.mode) {
    throw new RuntimeLayoutError(
      "E_RUNTIME_PATH_MODE",
      `expected ${resource.mode.toString(8)}, got ${(before.mode & 0o777).toString(8)}`,
      resource.relative_path,
    );
  }
  testHookBeforeOpen?.();
  const afterPath = lstatSync(canonical);
  if (
    afterPath.isSymbolicLink() ||
    afterPath.dev !== before.dev ||
    afterPath.ino !== before.ino ||
    afterPath.mode !== before.mode
  ) {
    throw new RuntimeLayoutError(
      "E_RUNTIME_PATH_IDENTITY",
      "resource path identity changed before open",
      resource.relative_path,
    );
  }
  const fd = openSync(canonical, resource.executable ? "r" : "r");
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.mode !== before.mode) {
      throw new RuntimeLayoutError(
        "E_RUNTIME_PATH_IDENTITY",
        "resource identity changed during verification",
        resource.relative_path,
      );
    }
    const bytes = readFileSync(fd);
    if (sha256(bytes) !== resource.sha256) {
      throw new RuntimeLayoutError(
        "E_RUNTIME_HASH_MISMATCH",
        "resource bytes differ from inventory",
        resource.relative_path,
      );
    }
    return { resource, path: canonical, fd, close: () => closeSync(fd) };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

export function resolveRuntimeResource(id: string): string {
  if (!activeLayout)
    throw new RuntimeLayoutError(
      "E_RUNTIME_RESOURCE_MISSING",
      "runtime layout is not configured",
      id,
    );
  const verified = openVerifiedRuntimeResource(activeLayout, id);
  verified.close();
  return verified.path;
}

export function packageRoot(): string | null {
  return activeLayout?.mode === "package" ? activeLayout.package_root : null;
}

export function runtimeResourceRoot(
  kind: "viewer" | "migrations" | "skills" | "remotion",
): string | null {
  const root = packageRoot();
  if (!root) return null;
  const names = { viewer: "viewer", migrations: "drizzle", skills: "skills", remotion: "remotion" };
  return resolve(root, names[kind]);
}
