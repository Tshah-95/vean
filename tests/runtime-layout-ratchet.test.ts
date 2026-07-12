import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  "src/preview/source-proxy.ts",
  "src/preview/viteDev.ts",
  "src/runtime/environment.ts",
  "src/runtime/layout-schema.ts",
  "src/runtime/layout.ts",
  "src/state/migrate.ts",
]);

describe("package resolver ratchet", () => {
  it("classifies every package-reachable resolver named by the contract", () => {
    const output = spawnSync(
      "rg",
      [
        "-n",
        "import\\.meta|CARGO_MANIFEST_DIR|resolveBin|VEAN_(?:MELT|FFMPEG|FFPROBE|REMOTION|REPO|BIN|PREVIEW_MODE)|viewer/dist|drizzle|skills|resolveRemotion|defaultRemotion|remotionWorkspace|remotion/(?:src|node_modules)",
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
      ],
      { cwd: root, encoding: "utf8" },
    );
    expect(output.status).toBe(0);
    const unclassified = (output.stdout ?? "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const file = line.split(":", 1)[0] ?? "";
        return !classifiedFiles.has(file);
      });
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
