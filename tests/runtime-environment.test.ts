import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  releaseEnvironmentKeyIsForbidden,
  sanitizeChildEnvironment,
} from "../src/runtime/environment";
import { sha256 } from "../src/runtime/layout";
import type { RuntimeLayout, RuntimeResource } from "../src/runtime/layout-schema";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function layout(): RuntimeLayout {
  const root = mkdtempSync(join(tmpdir(), "vean-env-"));
  roots.push(root);
  const defs: Array<[string, RuntimeResource["class"], string, boolean]> = [
    ["renderer.melt", "renderer-executable", "sidecars/bin/melt", true],
    ["renderer.ffmpeg", "renderer-executable", "sidecars/bin/ffmpeg", true],
    ["renderer.ffprobe", "renderer-executable", "sidecars/bin/ffprobe", true],
    ["renderer.mlt-modules", "renderer-data", "sidecars/lib/mlt/.vean-runtime", false],
    ["renderer.mlt-data", "renderer-data", "sidecars/share/mlt/.vean-runtime", false],
    ["renderer.mlt-profiles", "renderer-data", "sidecars/share/mlt/profiles/.vean-runtime", false],
    ["renderer.mlt-presets", "renderer-data", "sidecars/share/mlt/presets/.vean-runtime", false],
  ];
  const resources = defs.map(([id, cls, path, executable]) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, id, { mode: executable ? 0o755 : 0o644 });
    chmodSync(target, executable ? 0o755 : 0o644);
    return {
      id,
      class: cls,
      relative_path: path,
      sha256: sha256(id),
      mode: executable ? 0o755 : 0o644,
      executable,
      requirement: "startup-required" as const,
    };
  });
  return {
    schema_version: "vean.runtime-layout/1",
    mode: "package",
    package_root: root,
    project_root: join(root, "project"),
    development_checkout_root: null,
    manifest_relative_path: "runtime-manifest.json",
    resources,
  };
}

describe("release child environment", () => {
  it("enumerates hostile runtime, loader, proxy, browser, and package-manager variables", () => {
    const keys = [
      "VEAN_REPO",
      "VEAN_BIN",
      "VEAN_PREVIEW_MODE",
      "VEAN_MELT",
      "VEAN_FFMPEG_BIN",
      "VEAN_FFPROBE",
      "VEAN_REMOTION_BIN",
      "DYLD_INSERT_LIBRARIES",
      "MLT_DATA",
      "NODE_OPTIONS",
      "PLAYWRIGHT_BROWSERS_PATH",
      "HTTP_PROXY",
      "npm_config_registry",
      "BUN_INSTALL",
    ];
    for (const key of keys) expect(releaseEnvironmentKeyIsForbidden(key), key).toBe(true);
  });

  it("ignores hostile overrides and emits only verified package bindings", () => {
    const marker = "/tmp/vean-hostile-marker";
    const env = sanitizeChildEnvironment(layout(), {
      VEAN_MELT: marker,
      VEAN_REPO: "/Users/attacker/Github/vean",
      DYLD_INSERT_LIBRARIES: marker,
      NODE_OPTIONS: "--require=/tmp/marker.js",
      HTTP_PROXY: "http://attacker.invalid",
      PATH: `/opt/homebrew/bin:${marker}`,
      LANG: "en_US.UTF-8",
    });
    expect(env.VEAN_MELT).not.toBe(marker);
    expect(JSON.stringify(env)).not.toContain(marker);
    expect(JSON.stringify(env)).not.toContain("homebrew");
    expect(env.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(env.VEAN_RUNTIME_MODE).toBe("package");
  });

  it("preserves documented overrides in development mode", () => {
    const dev = {
      ...layout(),
      mode: "development" as const,
      development_checkout_root: "/tmp/checkout",
    };
    expect(sanitizeChildEnvironment(dev, { VEAN_MELT: "/custom/melt" }).VEAN_MELT).toBe(
      "/custom/melt",
    );
  });
});
