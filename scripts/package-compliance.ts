#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "./harness/package-json";
import {
  CHROME_ARCHIVE_SHA256,
  CHROME_VERSION,
  NODE_ARCHIVE_SHA256,
  NODE_VERSION,
} from "./package-remotion";

const repo = realpathSync(join(import.meta.dirname, ".."));
const licenseInputs = {
  "GPL-2.0": [
    "https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt",
    "edaef632cbb643e4e7a221717a6c441a4c1a7c918e6e4d56debc3d8739b233f6",
  ],
  "GPL-3.0": [
    "https://www.gnu.org/licenses/gpl-3.0.txt",
    "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986",
  ],
  "LGPL-2.1": [
    "https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt",
    "20e50fe7aae3e56378ebf0417d9de904f55a0e61e4df315333e632a4d3555d95",
  ],
} as const;

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ensureLicense(id: keyof typeof licenseInputs): string {
  const [, expected] = licenseInputs[id];
  const path = join(repo, "compliance", "licenses", `${id}.txt`);
  if (!existsSync(path)) throw new Error(`E_COMPLIANCE_LICENSE_MISSING: ${id}`);
  if (hash(path) !== expected) throw new Error(`E_COMPLIANCE_LICENSE_HASH: ${id}`);
  return path;
}

export async function packageCompliance(runtimeRoot: string) {
  const root = resolve(runtimeRoot);
  const out = join(root, "compliance");
  mkdirSync(join(out, "licenses"), { recursive: true });
  for (const id of Object.keys(licenseInputs) as Array<keyof typeof licenseInputs>) {
    cpSync(ensureLicense(id), join(out, "licenses", `${id}.txt`));
  }
  for (const file of ["LICENSE", "LICENSING.md", "CONTRIBUTING.md"])
    cpSync(join(repo, file), join(out, file));
  for (const [source, target] of [
    [join(root, "node", "LICENSE"), join(out, "licenses", "Node-LICENSE")],
    [
      join(root, "browser", "LICENSE.headless_shell"),
      join(out, "licenses", "Chrome-Headless-Shell-LICENSE"),
    ],
    [join(root, "sidecars", "MANIFEST.json"), join(out, "sidecars-MANIFEST.json")],
  ] as const) {
    if (!existsSync(source)) throw new Error(`E_COMPLIANCE_INPUT_MISSING: ${source}`);
    cpSync(source, target);
  }
  const spdx = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "Vean-H08-candidate-runtime",
    documentNamespace: "https://vean.studio/spdx/h08/build-host",
    packages: [
      {
        SPDXID: "SPDXRef-Vean",
        name: "vean",
        versionInfo: "0.0.0",
        licenseConcluded: "AGPL-3.0-only",
        downloadLocation: "https://github.com/tejas/vean",
      },
      {
        SPDXID: "SPDXRef-Node",
        name: "node",
        versionInfo: NODE_VERSION,
        licenseConcluded: "MIT",
        downloadLocation: `https://nodejs.org/dist/v${NODE_VERSION}/`,
        checksums: [{ algorithm: "SHA256", checksumValue: NODE_ARCHIVE_SHA256 }],
      },
      {
        SPDXID: "SPDXRef-Remotion",
        name: "remotion",
        versionInfo: "4.0.484",
        licenseConcluded: "SEE-FILES",
        downloadLocation: "https://www.npmjs.com/package/remotion/v/4.0.484",
      },
      {
        SPDXID: "SPDXRef-Chrome",
        name: "chrome-headless-shell",
        versionInfo: CHROME_VERSION,
        licenseConcluded: "BSD-3-Clause",
        downloadLocation: `https://storage.googleapis.com/chrome-for-testing-public/${CHROME_VERSION}/mac-arm64/`,
        checksums: [{ algorithm: "SHA256", checksumValue: CHROME_ARCHIVE_SHA256 }],
      },
      {
        SPDXID: "SPDXRef-MLT",
        name: "MLT",
        versionInfo: "7.38.0",
        licenseConcluded: "GPL-2.0-or-later AND LGPL-2.1-or-later",
        downloadLocation: "https://github.com/mltframework/mlt",
      },
      {
        SPDXID: "SPDXRef-FFmpeg",
        name: "FFmpeg",
        versionInfo: "8.1.2",
        licenseConcluded: "GPL-3.0-or-later",
        downloadLocation: "https://github.com/FFmpeg/FFmpeg",
      },
    ],
    public_distribution_legal_approval: false,
  };
  writeFileSync(join(out, "SPDX.json"), `${canonicalJson(spdx)}\n`);
  const recipe = {
    schema_version: "vean.compliance-build-recipe/1",
    sources: {
      vean: {
        repository: "https://github.com/tejas/vean",
        recipe: "package.json package:* facades",
      },
      node: { version: NODE_VERSION, archive_sha256: NODE_ARCHIVE_SHA256 },
      remotion: { version: "4.0.484", lock_sha256: hash(join(repo, "remotion", "bun.lock")) },
      chrome: { version: CHROME_VERSION, archive_sha256: CHROME_ARCHIVE_SHA256 },
      media_sidecars: JSON.parse(readFileSync(join(root, "sidecars", "MANIFEST.json"), "utf8")),
    },
    corresponding_source_offer: {
      duration_years: 3,
      contact: "maintainers via the Vean repository",
      build_recipes_included: true,
    },
    public_distribution_legal_approval: false,
  };
  writeFileSync(join(out, "source-and-build-recipe.json"), `${canonicalJson(recipe)}\n`);
  return { spdx, recipe };
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const runtime = option("--runtime") ?? join(repo, ".vean", "package-stage", "runtime");
  console.log(JSON.stringify(await packageCompliance(runtime), null, 2));
}
