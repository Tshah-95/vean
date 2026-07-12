import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalSha256 } from "../scripts/harness/package-json";
import {
  type H07Lineage,
  expandDyldToken,
  generateRequiredClosurePolicy,
  verifyRequiredClosurePolicy,
} from "../scripts/harness/required-closure-policy";
import { packageCompliance } from "../scripts/package-compliance";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const h07: H07Lineage = {
  fixture_manifest_sha256: "1".repeat(64),
  semantic_oracle_version: "vean.media-golden-manifest/1",
  semantic_oracle_sha256: "2".repeat(64),
  runtime_matrix_sha256: "3".repeat(64),
  expected_output_set_sha256: "4".repeat(64),
};

function runtime(): string {
  const root = mkdtempSync(join(tmpdir(), "vean-closure-"));
  roots.push(root);
  for (const [path, content] of [
    ["core/vean-core.txt", "core"],
    ["viewer/dist/index.html", "viewer"],
    ["drizzle/0000.sql", "migration"],
    ["skills/catalog.json", "skills"],
    ["sidecars/share/mlt/profiles/profile", "renderer"],
    ["remotion/src/index.ts", "remotion"],
    ["compliance/SPDX.json", "compliance"],
  ] as const) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}

describe("required package closure", () => {
  it("binds exact inventory, modes, hashes, requirement classes, source, and H07 parents", () => {
    const root = runtime();
    const { policy } = generateRequiredClosurePolicy(root, "a".repeat(40), h07);
    expect(policy.h07).toEqual(h07);
    expect(
      policy.entries.find((entry) => entry.relative_path === "core/vean-core.txt")?.requirement,
    ).toBe("startup-required");
    expect(
      policy.entries.find((entry) => entry.relative_path === "remotion/src/index.ts")?.requirement,
    ).toBe("operation-lazy");
    expect(
      policy.entries.find((entry) => entry.relative_path === "compliance/SPDX.json")?.requirement,
    ).toBe("distribution-only");
    expect(() => verifyRequiredClosurePolicy(root, policy)).not.toThrow();
  });

  it("rejects content mutation, removal, and unclassified addition against the fixed policy", () => {
    const root = runtime();
    const { policy } = generateRequiredClosurePolicy(root, "a".repeat(40), h07);
    const target = join(root, "viewer/dist/index.html");
    writeFileSync(target, "mutant");
    expect(() => verifyRequiredClosurePolicy(root, policy)).toThrowError(
      /E_CLOSURE_REQUIRED_MISMATCH: viewer\/dist\/index.html/,
    );
    writeFileSync(target, "viewer");
    expect(() => verifyRequiredClosurePolicy(root, policy)).not.toThrow();
    rmSync(target);
    expect(() => verifyRequiredClosurePolicy(root, policy)).toThrowError(
      /E_CLOSURE_REQUIRED_MISSING/,
    );
    writeFileSync(target, "viewer");
    writeFileSync(join(root, "extra"), "extra");
    expect(() => verifyRequiredClosurePolicy(root, policy)).toThrowError(
      /E_CLOSURE_UNCLASSIFIED_EXTRA/,
    );
  });

  it("prevents a coherent mutant from replacing the fixed policy or H07 identity", () => {
    const root = runtime();
    const baseline = generateRequiredClosurePolicy(root, "a".repeat(40), h07);
    writeFileSync(join(root, "remotion/src/index.ts"), "coherent mutant");
    const mutant = generateRequiredClosurePolicy(root, "a".repeat(40), {
      ...h07,
      runtime_matrix_sha256: "9".repeat(64),
    });
    expect(mutant.sha256).not.toBe(baseline.sha256);
    expect(() => verifyRequiredClosurePolicy(root, baseline.policy)).toThrowError(
      /E_CLOSURE_REQUIRED_MISMATCH/,
    );
  });

  it("rejects absolute and escaping symlinks", () => {
    const absolute = runtime();
    symlinkSync("/tmp", join(absolute, "absolute-link"));
    expect(() => generateRequiredClosurePolicy(absolute, "a".repeat(40), h07)).toThrowError(
      /E_CLOSURE_SYMLINK_ABSOLUTE/,
    );
    const escaping = runtime();
    const outside = mkdtempSync(join(tmpdir(), "vean-outside-"));
    roots.push(outside);
    writeFileSync(join(outside, "file"), "outside");
    symlinkSync(
      join("..", outside.split("/").at(-1) ?? "missing", "file"),
      join(escaping, "escape-link"),
    );
    expect(() => generateRequiredClosurePolicy(escaping, "a".repeat(40), h07)).toThrowError(
      /E_CLOSURE_SYMLINK_ESCAPE|ENOENT/,
    );
  });

  it("resolves dyld tokens and exposes escaping, missing, and duplicate candidates", () => {
    const loader = "/App/Contents/Resources/runtime/sidecars/lib/libA.dylib";
    const executable = "/App/Contents/Resources/runtime/sidecars/bin/melt";
    expect(expandDyldToken("@loader_path/libB.dylib", loader, executable, [])).toEqual([
      "/App/Contents/Resources/runtime/sidecars/lib/libB.dylib",
    ]);
    expect(
      expandDyldToken("@rpath/libB.dylib", loader, executable, [
        "@loader_path",
        "@loader_path/../other",
      ]),
    ).toEqual([
      "/App/Contents/Resources/runtime/sidecars/lib/libB.dylib",
      "/App/Contents/Resources/runtime/sidecars/other/libB.dylib",
    ]);
    expect(
      expandDyldToken("@rpath/libB.dylib", loader, executable, [
        "@loader_path/../../../../../escape",
      ])[0],
    ).not.toContain("/runtime/");
    expect(expandDyldToken("/opt/homebrew/lib/libB.dylib", loader, executable, [])).toEqual([
      "/opt/homebrew/lib/libB.dylib",
    ]);
  });

  it("builds a hash-complete mechanical compliance payload without legal approval", async () => {
    const root = runtime();
    for (const [path, content] of [
      ["node/LICENSE", "node license"],
      ["browser/LICENSE.headless_shell", "chrome license"],
      ["sidecars/MANIFEST.json", "{}"],
    ] as const) {
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
    const result = await packageCompliance(root);
    expect(result.spdx.public_distribution_legal_approval).toBe(false);
    expect(existsSync(join(root, "compliance/SPDX.json"))).toBe(true);
    expect(existsSync(join(root, "compliance/source-and-build-recipe.json"))).toBe(true);
    for (const id of ["GPL-2.0", "GPL-3.0", "LGPL-2.1"]) {
      const path = join(root, "compliance/licenses", `${id}.txt`);
      expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toMatch(
        /^[a-f0-9]{64}$/,
      );
    }
    expect(canonicalSha256(result.spdx)).toMatch(/^[a-f0-9]{64}$/);
  });
});
