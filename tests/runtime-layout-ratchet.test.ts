import { readFileSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const classifiedFiles = new Set([
  "app/src-tauri/src/lib.rs",
  "app/src-tauri/src/runtime_layout.rs",
  "src/actions/overlayBake.ts",
  "src/actions/skills.ts",
  "src/cli.ts",
  "src/driver/melt.ts",
  "src/driver/probe.ts",
  "src/driver/remotion.ts",
  "src/driver/transcode.ts",
  "src/ir/dials/generate.ts",
  "src/preview/server.ts",
  "src/preview/peaks.ts",
  "src/preview/source-proxy.ts",
  "src/preview/viteDev.ts",
  "src/runtime/environment.ts",
  "src/runtime/layout-schema.ts",
  "src/runtime/layout.ts",
  "src/state/migrate.ts",
]);

describe("package resolver ratchet", () => {
  it("classifies every package-reachable resolver named by the contract", () => {
    const targets = [
      "src/runtime",
      "src/actions/overlayBake.ts",
      "src/actions/skills.ts",
      "src/cli.ts",
      "src/driver",
      "src/ir/dials/generate.ts",
      "src/preview",
      "src/state/migrate.ts",
      "app/src-tauri/src/lib.rs",
      "app/src-tauri/src/runtime_layout.rs",
    ];
    const files: string[] = [];
    const visit = (path: string) => {
      if (statSync(path).isDirectory()) {
        for (const name of readdirSync(path)) visit(resolve(path, name));
      } else files.push(path);
    };
    for (const target of targets) visit(resolve(root, target));
    const resolver =
      /import\.meta|CARGO_MANIFEST_DIR|resolveBin|VEAN_(?:MELT|FFMPEG|FFPROBE|REMOTION|REPO|BIN|PREVIEW_MODE)|viewer\/dist|drizzle|skills|resolveRemotion|defaultRemotion|remotionWorkspace|remotion\/(?:src|node_modules)/;
    const unclassified = files
      .filter((file) => resolver.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file).replaceAll("\\", "/"))
      .filter((file) => !classifiedFiles.has(file));
    expect(unclassified).toEqual([]);
  });

  it("keeps the package contract and schema version explicit", () => {
    expect(
      readFileSync(resolve(root, "artifacts/specs/packaged-runtime-contract.md"), "utf8"),
    ).toContain("vean.runtime-layout/1");
    expect(readFileSync(resolve(root, "src/runtime/layout-schema.ts"), "utf8")).toContain(
      "RUNTIME_LAYOUT_SCHEMA_VERSION",
    );
  });
});
