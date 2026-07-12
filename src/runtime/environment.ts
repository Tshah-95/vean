import { dirname } from "node:path";
import { RuntimeLayoutError, currentRuntimeLayout, openVerifiedRuntimeResource } from "./layout";
import type { RuntimeLayout } from "./layout-schema";

const FORBIDDEN_PREFIXES = ["DYLD_", "MLT_", "npm_", "NPM_", "BUN_", "PNPM_", "YARN_"];
const FORBIDDEN_EXACT = new Set([
  "VEAN_REPO",
  "VEAN_BIN",
  "VEAN_PREVIEW_MODE",
  "NODE_OPTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PUPPETEER_CACHE_DIR",
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROME_PATH",
]);

function forbidden(key: string): boolean {
  return (
    FORBIDDEN_EXACT.has(key) ||
    FORBIDDEN_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
    /^VEAN_(MELT|FFMPEG|FFPROBE|REMOTION)/.test(key)
  );
}

function assertSafeValue(key: string, value: string): void {
  if (
    /\/opt\/homebrew|\/usr\/local|\/(?:Users|home)\/[^/]+\/(?:\.bun|\.npm|\.pnpm|Github)\b/.test(
      value,
    )
  ) {
    throw new RuntimeLayoutError(
      "E_RUNTIME_PATH_ESCAPE",
      `forbidden package environment value for ${key}`,
    );
  }
}

export function sanitizeChildEnvironment(
  layout: RuntimeLayout,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  if (layout.mode === "development") {
    return Object.fromEntries(
      Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
  }

  const output: Record<string, string> = {
    LANG: source.LANG ?? "en_US.UTF-8",
    LC_ALL: source.LC_ALL ?? "en_US.UTF-8",
    HOME: layout.project_root,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    VEAN_RUNTIME_MODE: "package",
  };
  const bindings = {
    VEAN_MELT: ["renderer.melt", false],
    VEAN_FFMPEG: ["renderer.ffmpeg", false],
    VEAN_FFPROBE: ["renderer.ffprobe", false],
    MLT_REPOSITORY: ["renderer.mlt-modules", true],
    MLT_DATA: ["renderer.mlt-data", true],
    MLT_PROFILES_PATH: ["renderer.mlt-profiles", true],
    MLT_PRESETS_PATH: ["renderer.mlt-presets", true],
  } as const;
  for (const [key, [id, useParent]] of Object.entries(bindings)) {
    const resource = openVerifiedRuntimeResource(layout, id);
    output[key] = useParent ? dirname(resource.path) : resource.path;
    resource.close();
  }
  for (const [key, value] of Object.entries(output)) assertSafeValue(key, value);
  for (const key of Object.keys(source)) {
    if (forbidden(key)) continue;
  }
  return output;
}

export function releaseEnvironmentKeyIsForbidden(key: string): boolean {
  return forbidden(key);
}

export function runtimeChildEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const layout = currentRuntimeLayout();
  return layout
    ? sanitizeChildEnvironment(layout, source)
    : Object.fromEntries(
        Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
}
