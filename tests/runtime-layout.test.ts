import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type RuntimeLayoutError,
  loadRuntimeLayout,
  openVerifiedRuntimeResource,
  sha256,
} from "../src/runtime/layout";
import type { RuntimeLayout, RuntimeResource } from "../src/runtime/layout-schema";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(
  relativePath = "bin/tool",
  content = "tool",
): { root: string; layout: RuntimeLayout; resource: RuntimeResource } {
  const root = mkdtempSync(join(tmpdir(), "vean-runtime-"));
  roots.push(root);
  const target = join(root, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: 0o755 });
  chmodSync(target, 0o755);
  const resource: RuntimeResource = {
    id: "renderer.melt",
    class: "renderer-executable",
    relative_path: relativePath,
    sha256: sha256(content),
    mode: 0o755,
    executable: true,
    requirement: "startup-required",
  };
  return {
    root,
    resource,
    layout: {
      schema_version: "vean.runtime-layout/1",
      mode: "package",
      package_root: root,
      project_root: join(root, "project"),
      development_checkout_root: null,
      manifest_relative_path: "runtime-manifest.json",
      resources: [resource],
    },
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return (error as RuntimeLayoutError).code;
  }
  return undefined;
}

describe("packaged runtime containment", () => {
  it("opens a hash-, mode-, inode-, and root-bound regular resource", () => {
    const { layout } = fixture();
    const verified = openVerifiedRuntimeResource(layout, "renderer.melt");
    expect(verified.path).toContain("/bin/tool");
    verified.close();
  });

  it.each([
    ["traversal", "../escape", "E_RUNTIME_PATH_ESCAPE"],
    ["absolute escape", "/tmp/escape", "E_RUNTIME_PATH_ESCAPE"],
    ["empty component", "bin//tool", "E_RUNTIME_PATH_ESCAPE"],
    ["case variant", "BIN/tool", "E_RUNTIME_PATH_DANGLING"],
  ])("rejects %s", (_name, path, expected) => {
    const { layout, resource } = fixture();
    layout.resources = [{ ...resource, relative_path: path }];
    expect(code(() => openVerifiedRuntimeResource(layout, resource.id))).toBe(expected);
  });

  it.each(["relative", "absolute", "loop", "dangling"])("rejects %s symlinks", (kind) => {
    const { root, layout } = fixture("real/tool");
    const link = join(root, "bin", "tool");
    mkdirSync(dirname(link), { recursive: true });
    if (kind === "relative") symlinkSync("../../real/tool", link);
    if (kind === "absolute") symlinkSync(join(root, "real/tool"), link);
    if (kind === "loop") symlinkSync("tool", link);
    if (kind === "dangling") symlinkSync("missing", link);
    const resource = layout.resources[0];
    if (!resource) throw new Error("missing fixture resource");
    layout.resources[0] = { ...resource, relative_path: "bin/tool" };
    expect(code(() => openVerifiedRuntimeResource(layout, "renderer.melt"))).toBe(
      "E_RUNTIME_PATH_SYMLINK",
    );
  });

  it("rejects an external hard link", () => {
    const { root, layout } = fixture();
    linkSync(join(root, "bin/tool"), join(root, "external-link"));
    expect(code(() => openVerifiedRuntimeResource(layout, "renderer.melt"))).toBe(
      "E_RUNTIME_PATH_HARDLINK",
    );
  });

  it("rejects package-root replacement after preflight", () => {
    const { root, layout } = fixture();
    const first = openVerifiedRuntimeResource(layout, "renderer.melt");
    first.close();
    const old = `${root}.old`;
    renameSync(root, old);
    roots.push(old);
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(root, "bin/tool"), "tool", { mode: 0o755 });
    chmodSync(join(root, "bin/tool"), 0o755);
    expect(code(() => openVerifiedRuntimeResource(layout, "renderer.melt"))).toBe(
      "E_RUNTIME_PATH_IDENTITY",
    );
  });

  it("rejects a post-verification link swap using the held-identity boundary", () => {
    const { root, layout } = fixture();
    const target = join(root, "bin/tool");
    expect(
      code(() =>
        openVerifiedRuntimeResource(layout, "renderer.melt", () => {
          renameSync(target, `${target}.old`);
          symlinkSync(`${target}.old`, target);
        }),
      ),
    ).toBe("E_RUNTIME_PATH_IDENTITY");
  });

  it("fails mode and content mutation with attributed codes", () => {
    const mode = fixture();
    chmodSync(join(mode.root, "bin/tool"), 0o644);
    expect(code(() => openVerifiedRuntimeResource(mode.layout, "renderer.melt"))).toBe(
      "E_RUNTIME_PATH_MODE",
    );
    const hash = fixture();
    writeFileSync(join(hash.root, "bin/tool"), "mutant", { mode: 0o755 });
    expect(code(() => openVerifiedRuntimeResource(hash.layout, "renderer.melt"))).toBe(
      "E_RUNTIME_HASH_MISMATCH",
    );
  });

  it("rejects environment attempts to select package mode or roots", () => {
    const { root, layout } = fixture();
    const file = join(root, "layout.json");
    writeFileSync(
      file,
      JSON.stringify({ ...layout, mode: "development", development_checkout_root: root }),
    );
    process.env.VEAN_RUNTIME_MODE = "package";
    expect(code(() => loadRuntimeLayout(file, "package"))).toBe("E_RUNTIME_MODE_MISMATCH");
    process.env.VEAN_RUNTIME_MODE = undefined;
  });
});
