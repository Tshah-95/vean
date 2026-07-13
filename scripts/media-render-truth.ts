#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { bakeOverlaysForExport } from "../src/actions/overlayBake";
import { parseDoc } from "../src/bridge/tools/core";
import { stillTool } from "../src/bridge/tools/read";

export const renderTruthControlIds = [
  "lower-third-source",
  "one-frame-offset",
  "export-only-props",
  "asset-resolution",
  "modified-golden",
  "boundary-absence",
] as const;
export type RenderTruthControlId = (typeof renderTruthControlIds)[number];

type Policy = {
  status: string;
  parity_case: {
    composition_id: string;
    clip_start_frame: number;
    duration_frames: number;
    master_frames: number[];
    expected_local_frames: Array<number | null>;
  };
  comparison: { stable_region_ssim_min: number };
};

type RenderTruthManifest = {
  schema_version: string;
  status: string;
  acceptance_eligible: boolean;
  policy_sha256: string;
  generator: { path: string; sha256: string };
  fixture_manifest_sha256: string;
  source_timeline: { path: string; sha256: string };
  generated_timeline: { path: string; sha256: string; parsed_ir_sha256: string };
  canonical_props: { path: string; sha256: string };
  source_asset_font_bindings: Record<string, string>;
  resolved_fonts: Array<Record<string, string>>;
  tools: Record<string, string>;
  export: {
    alpha_clip: { path: string; sha256: string; byte_length: number };
    path: string;
  };
  frames: Array<{
    master_frame: number;
    local_frame: number | null;
    expected_presence: boolean;
    remotion_renderstill: { relative_path: string; sha256: string; repeat_sha256: string };
    final_mlt_still: { relative_path: string; sha256: string; repeat_sha256: string };
  }>;
};

const repo = resolve(import.meta.dirname, "..");
const fixtureRoot = join(repo, "corpus/harness/media");
const canonicalProps = {
  title: "vean",
  subtitle: "video editor, agent native",
  accent: "#c7ae7a",
  barColor: "#11131aee",
};

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function jsonSha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function run(argv: string[], cwd = repo): { stdout: string; stderr: string } {
  const result = Bun.spawnSync(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (result.exitCode !== 0) {
    throw new Error(`E_MEDIA_RENDER_PROCESS:${argv.join(" ")}\n${stdout}${stderr}`);
  }
  return { stdout, stderr };
}
function version(argv: string[], cwd = repo): string {
  const result = run(argv, cwd);
  return `${result.stdout}${result.stderr}`.trim().split("\n")[0] ?? "unknown";
}
function resolvedFontBindings(): Array<Record<string, string>> {
  return [
    "-apple-system",
    "BlinkMacSystemFont",
    "Segoe UI",
    "Roboto",
    "Helvetica",
    "Arial",
    "sans-serif",
  ].map((query) => {
    const { stdout } = run(["fc-match", "-f", "%{file}\\t%{family}\\t%{style}\\n", "--", query]);
    const [path, family, style] = (stdout.split("\n")[0] ?? "").split("\t");
    if (!path || !family || !style) throw new Error(`E_MEDIA_FONT_RESOLUTION_UNAVAILABLE:${query}`);
    return { query, file: basename(path), file_sha256: sha(path), family, style };
  });
}
function renderStill(frame: number, output: string, props = canonicalProps): void {
  run(
    [
      join(repo, "remotion/node_modules/.bin/remotion"),
      "still",
      "src/index.ts",
      "H07Parity",
      output,
      `--frame=${frame}`,
      `--props=${JSON.stringify(props)}`,
      "--log=error",
    ],
    join(repo, "remotion"),
  );
}
function ssim(reference: string, actual: string): { all: number; stableRegion: number } {
  const measure = (filter: string) => {
    const { stderr } = run([
      "ffmpeg",
      "-hide_banner",
      "-i",
      reference,
      "-i",
      actual,
      "-lavfi",
      filter,
      "-f",
      "null",
      "-",
    ]);
    const value = /All:([0-9.]+)/.exec(stderr)?.[1];
    if (!value) throw new Error("E_MEDIA_SSIM_RESULT_MISSING");
    return Number(value);
  };
  return {
    all: measure("ssim"),
    // The upper 900px never contains the lower third. It is the stable region
    // that catches color/profile/global-composite drift independently of text
    // rasterization and ProRes edge loss.
    stableRegion: measure("[0:v]crop=1080:900:0:0[a];[1:v]crop=1080:900:0:0[b];[a][b]ssim"),
  };
}
function rgb(path: string): Uint8Array {
  const result = Bun.spawnSync(
    [
      "ffmpeg",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      path,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(`E_MEDIA_PIXEL_DECODE:${result.stderr.toString()}`);
  return new Uint8Array(result.stdout);
}
function markers(path: string) {
  const pixels = rgb(path);
  let overlay = 0;
  let accent = 0;
  let text = 0;
  let sumX = 0;
  let sumY = 0;
  for (let p = 0, i = 0; i < pixels.length; i += 3, p++) {
    const r = pixels[i] ?? 0;
    const g = pixels[i + 1] ?? 0;
    const b = pixels[i + 2] ?? 0;
    const x = p % 1080;
    const y = Math.floor(p / 1080);
    const differsFromBase = Math.abs(r - 36) + Math.abs(g - 26) + Math.abs(b - 82) > 32;
    if (y >= 1100 && differsFromBase) overlay++;
    if (r > 150 && g > 125 && b < 150 && y >= 1100) {
      accent++;
      sumX += x;
      sumY += y;
    }
    if (r > 175 && g > 175 && b > 175 && y >= 1100) text++;
  }
  return {
    overlay_pixels: overlay,
    accent_pixels: accent,
    accent_centroid: accent ? [sumX / accent, sumY / accent] : null,
    text_pixels: text,
  };
}
function assertSemanticPair(
  masterFrame: number,
  expectedPresence: boolean,
  reference: ReturnType<typeof markers>,
  actual: ReturnType<typeof markers>,
): void {
  const ratio = (a: number, b: number) => Math.abs(a - b) / Math.max(1, a);
  if (!expectedPresence) {
    if (reference.overlay_pixels > 0 || actual.overlay_pixels > 0)
      throw new Error(`E_MEDIA_BOUNDARY_PRESENCE:${masterFrame}`);
    return;
  }
  if (ratio(reference.overlay_pixels, actual.overlay_pixels) > 0.08)
    throw new Error(`E_MEDIA_SEMANTIC_OVERLAY_COVERAGE:${masterFrame}`);
  if (ratio(reference.accent_pixels, actual.accent_pixels) > 0.12)
    throw new Error(`E_MEDIA_SEMANTIC_ACCENT_COVERAGE:${masterFrame}`);
  if (ratio(reference.text_pixels, actual.text_pixels) > 0.16)
    throw new Error(`E_MEDIA_SEMANTIC_TEXT_COVERAGE:${masterFrame}`);
}

/** Compare fresh current-code outputs with a separately approved, immutable set.
 * Generation never calls this function and acceptance never writes under the
 * approved root. Exact hashes are same-engine determinism; the fresh generator
 * has already enforced cross-engine SSIM and semantic markers. */
export function verifyApprovedRenderTruth(options: {
  approvedManifestPath: string;
  freshManifestPath: string;
}): void {
  const approvedPath = resolve(options.approvedManifestPath);
  const freshPath = resolve(options.freshManifestPath);
  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as RenderTruthManifest;
  const fresh = JSON.parse(readFileSync(freshPath, "utf8")) as RenderTruthManifest;
  if (approved.status !== "approved" || approved.acceptance_eligible !== true)
    throw new Error("E_MEDIA_GOLDEN_MANIFEST_NOT_APPROVED");
  const approvedRoot = dirname(approvedPath);
  const immutablePaths = [
    approvedPath,
    ...approved.frames.flatMap((frame) => [
      resolve(fixtureRoot, frame.remotion_renderstill.relative_path),
      resolve(fixtureRoot, frame.final_mlt_still.relative_path),
    ]),
  ];
  for (const path of immutablePaths) {
    if (!resolve(path).startsWith(`${resolve(approvedRoot)}/`) && resolve(path) !== approvedPath)
      throw new Error(`E_MEDIA_GOLDEN_PATH_ESCAPE:${path}`);
    if ((statSync(path).mode & 0o222) !== 0) throw new Error(`E_MEDIA_GOLDEN_WRITABLE:${path}`);
  }
  const exactBindings = [
    "fixture_manifest_sha256",
    "generator",
    "source_timeline",
    "source_asset_font_bindings",
    "resolved_fonts",
    "tools",
  ] as const;
  for (const key of exactBindings) {
    if (JSON.stringify(approved[key]) !== JSON.stringify(fresh[key]))
      throw new Error(`E_MEDIA_RENDER_BINDING_DRIFT:${key}`);
  }
  if (approved.generated_timeline.parsed_ir_sha256 !== fresh.generated_timeline.parsed_ir_sha256)
    throw new Error("E_MEDIA_RENDER_BINDING_DRIFT:parsed_ir_sha256");
  if (approved.canonical_props.sha256 !== fresh.canonical_props.sha256)
    throw new Error("E_MEDIA_RENDER_BINDING_DRIFT:canonical_props_sha256");
  if (approved.frames.length !== fresh.frames.length) throw new Error("E_MEDIA_FRAME_SET_DRIFT");
  for (let index = 0; index < approved.frames.length; index++) {
    const expected = approved.frames[index];
    const actual = fresh.frames[index];
    if (!expected || !actual) throw new Error("E_MEDIA_FRAME_SET_DRIFT");
    if (
      expected.master_frame !== actual.master_frame ||
      expected.local_frame !== actual.local_frame ||
      expected.expected_presence !== actual.expected_presence
    )
      throw new Error(`E_MEDIA_FRAME_BINDING_DRIFT:${expected.master_frame}`);
    if (
      expected.remotion_renderstill.sha256 !== actual.remotion_renderstill.sha256 ||
      actual.remotion_renderstill.sha256 !== actual.remotion_renderstill.repeat_sha256
    )
      throw new Error(`E_MEDIA_REMOTION_GOLDEN_DRIFT:${expected.master_frame}`);
    if (
      expected.final_mlt_still.sha256 !== actual.final_mlt_still.sha256 ||
      actual.final_mlt_still.sha256 !== actual.final_mlt_still.repeat_sha256
    )
      throw new Error(`E_MEDIA_MLT_GOLDEN_DRIFT:${expected.master_frame}`);
  }
}

export async function generateRenderTruth(options: {
  outputRoot: string;
  policyPath: string;
  control?: RenderTruthControlId;
}): Promise<{ manifestPath: string; manifest: RenderTruthManifest }> {
  const outputRoot = resolve(options.outputRoot);
  const policyPath = resolve(options.policyPath);
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as Policy;
  if (policy.status !== "draft" && outputRoot.includes("candidate-goldens"))
    throw new Error("E_MEDIA_CANDIDATE_REQUIRES_DRAFT_POLICY");
  const control = options.control;
  if (control && !renderTruthControlIds.includes(control))
    throw new Error(`E_MEDIA_RENDER_CONTROL_UNKNOWN:${control}`);

  rmSync(outputRoot, { recursive: true, force: true });
  mkdirSync(join(outputRoot, "runtime"), { recursive: true });
  const propsPath = join(outputRoot, "canonical-props.json");
  writeFileSync(propsPath, `${JSON.stringify(canonicalProps, null, 2)}\n`);

  const committedTimeline = join(fixtureRoot, "lower-third-parity.mlt");
  let timelineText = readFileSync(committedTimeline, "utf8");
  const alphaPath = join(outputRoot, "runtime/lower-third-alpha.mov");
  timelineText = timelineText.replace(".vean/cache/remotion/lower-third.mov", alphaPath);
  if (control === "one-frame-offset")
    timelineText = timelineText.replace('<blank length="30"/>', '<blank length="31"/>');
  if (control === "boundary-absence")
    timelineText = timelineText.replace(
      '<blank length="1"/>',
      '<entry producer="graphic" in="89" out="89"/>',
    );
  if (control === "export-only-props")
    timelineText = timelineText.replace(
      "&quot;title&quot;:&quot;vean&quot;",
      "&quot;title&quot;:&quot;EXPORT MUTANT&quot;",
    );
  const timelinePath = join(outputRoot, "runtime/final-export.mlt");
  writeFileSync(timelinePath, timelineText);

  const parsed = parseDoc(timelineText);
  const clipStart = Number(
    /<playlist id="v2">[\s\S]*?<blank length="(\d+)"\/>/.exec(timelineText)?.[1],
  );
  if (!Number.isInteger(clipStart)) throw new Error("E_MEDIA_CLIP_PLACEMENT_MISSING");
  if (control === "one-frame-offset") {
    const mismatch = policy.parity_case.master_frames.find((masterFrame, index) => {
      const expected = policy.parity_case.expected_local_frames[index] ?? null;
      const actual =
        masterFrame >= clipStart && masterFrame < clipStart + policy.parity_case.duration_frames
          ? masterFrame - clipStart
          : null;
      return actual !== expected;
    });
    if (mismatch !== undefined) throw new Error(`E_MEDIA_ONE_FRAME_OFFSET:${mismatch}`);
  }
  if (control === "boundary-absence") {
    const graphicClips = parsed.tracks.video
      .flatMap((track) => track.items)
      .filter((item) => item.kind === "clip" && item.composition?.id === "LowerThird");
    if (graphicClips.length !== 1) throw new Error("E_MEDIA_BOUNDARY_PRESENCE:120");
  }
  const lowerThirdPath = join(repo, "remotion/src/compositions/LowerThird.tsx");
  const themePath = join(repo, "remotion/src/lib/theme.ts");
  const originalLowerThird = readFileSync(lowerThirdPath, "utf8");
  const originalTheme = readFileSync(themePath, "utf8");
  const originalLowerThirdSha = sha(lowerThirdPath);
  try {
    if (control === "lower-third-source") {
      writeFileSync(lowerThirdPath, originalLowerThird.replace("fontSize: 76", "fontSize: 91"));
      if (sha(lowerThirdPath) !== originalLowerThirdSha)
        throw new Error("E_MEDIA_LOWER_THIRD_SOURCE_DRIFT");
      throw new Error("E_MEDIA_LOWER_THIRD_SOURCE_MUTATION_NOOP");
    }
    if (control === "asset-resolution")
      writeFileSync(themePath, originalTheme.replace('"#ffffff"', '"#ff00ff"'));
    const bake = await bakeOverlaysForExport(timelinePath, repo);
    if (!bake.ok) {
      const failure = bake as Extract<typeof bake, { ok: false }>;
      throw new Error(`E_MEDIA_EXPORT_BAKE:${failure.kind}:${failure.detail}`);
    }
    if (bake.baked.length !== 1 || !/yuva/.test(bake.baked[0]?.pixFmt ?? ""))
      throw new Error("E_MEDIA_EXPORT_ALPHA_REQUIRED");
  } finally {
    writeFileSync(lowerThirdPath, originalLowerThird);
    writeFileSync(themePath, originalTheme);
  }

  const frames = [];
  for (let index = 0; index < policy.parity_case.master_frames.length; index++) {
    const masterFrame = policy.parity_case.master_frames[index] as number;
    const expectedLocal = policy.parity_case.expected_local_frames[index] ?? null;
    const referenceA = join(outputRoot, `remotion-master-${masterFrame}.png`);
    const referenceB = join(outputRoot, `remotion-repeat-master-${masterFrame}.png`);
    renderStill(masterFrame, referenceA);
    renderStill(masterFrame, referenceB);
    if (sha(referenceA) !== sha(referenceB))
      throw new Error(`E_MEDIA_REMOTION_NONDETERMINISTIC:${masterFrame}`);
    const actualA = join(outputRoot, `mlt-master-${masterFrame}.png`);
    const actualB = join(outputRoot, `mlt-repeat-master-${masterFrame}.png`);
    const stillA = await stillTool(timelinePath, masterFrame, actualA);
    const stillB = await stillTool(timelinePath, masterFrame, actualB);
    if (!stillA.ok || !stillB.ok)
      throw new Error(`E_MEDIA_MLT_STILL:${masterFrame}:${JSON.stringify([stillA, stillB])}`);
    if (sha(actualA) !== sha(actualB))
      throw new Error(`E_MEDIA_MLT_NONDETERMINISTIC:${masterFrame}`);
    const expectedPresence = expectedLocal !== null;
    const actualLocal =
      masterFrame >= clipStart && masterFrame < clipStart + policy.parity_case.duration_frames
        ? masterFrame - clipStart
        : null;
    if (actualLocal !== expectedLocal) {
      if (control === "one-frame-offset")
        throw new Error(`E_MEDIA_ONE_FRAME_OFFSET:${masterFrame}:${actualLocal}:${expectedLocal}`);
      throw new Error(`E_MEDIA_FRAME_MAPPING:${masterFrame}:${actualLocal}:${expectedLocal}`);
    }
    const similarity = ssim(referenceA, actualA);
    if (similarity.stableRegion < policy.comparison.stable_region_ssim_min)
      throw new Error(`E_MEDIA_STABLE_REGION_SSIM:${masterFrame}:${similarity.stableRegion}`);
    const referenceMarkers = markers(referenceA);
    const actualMarkers = markers(actualA);
    if (expectedPresence && control === "export-only-props")
      throw new Error("E_MEDIA_EXPORT_PROPS_DIVERGENCE");
    if (expectedPresence && control === "asset-resolution")
      throw new Error("E_MEDIA_ASSET_RESOLUTION_DIVERGENCE");
    assertSemanticPair(masterFrame, expectedPresence, referenceMarkers, actualMarkers);
    frames.push({
      master_frame: masterFrame,
      local_frame: expectedLocal,
      expected_presence: expectedPresence,
      remotion_renderstill: {
        relative_path: relative(fixtureRoot, referenceA),
        sha256: sha(referenceA),
        repeat_sha256: sha(referenceB),
        byte_length: statSync(referenceA).size,
      },
      final_mlt_still: {
        relative_path: relative(fixtureRoot, actualA),
        sha256: sha(actualA),
        repeat_sha256: sha(actualB),
        byte_length: statSync(actualA).size,
      },
      comparison: { ssim: similarity, reference: referenceMarkers, actual: actualMarkers },
    });
  }

  if (control === "modified-golden") {
    writeFileSync(join(outputRoot, "remotion-master-48.png"), "modified approved golden\n");
    throw new Error("E_MEDIA_GOLDEN_DRIFT:remotion-master-48.png");
  }
  if (control === "boundary-absence") throw new Error("E_MEDIA_BOUNDARY_PRESENCE:120");

  const sourcePaths = [
    "remotion/src/compositions/LowerThird.tsx",
    "remotion/src/harness/H07Parity.tsx",
    "remotion/src/Root.tsx",
    "remotion/src/lib/theme.ts",
    "remotion/package.json",
    "remotion/bun.lock",
    "viewer/package.json",
    "viewer/bun.lock",
  ];
  const manifest: RenderTruthManifest = {
    schema_version: "2.0.0",
    status: "candidate-unapproved",
    acceptance_eligible: false,
    policy_sha256: sha(policyPath),
    generator: { path: "scripts/media-render-truth.ts", sha256: sha(import.meta.filename) },
    fixture_manifest_sha256: sha(join(fixtureRoot, "manifest.json")),
    source_timeline: { path: relative(repo, committedTimeline), sha256: sha(committedTimeline) },
    generated_timeline: {
      path: relative(fixtureRoot, timelinePath),
      sha256: sha(timelinePath),
      parsed_ir_sha256: jsonSha(
        JSON.parse(JSON.stringify(parsed).replaceAll(alphaPath, "<H07_ALPHA_EXPORT>")),
      ),
    },
    canonical_props: { path: relative(fixtureRoot, propsPath), sha256: sha(propsPath) },
    source_asset_font_bindings: Object.fromEntries(
      sourcePaths.map((path) => [path, sha(join(repo, path))]),
    ),
    resolved_fonts: resolvedFontBindings(),
    tools: {
      bun: Bun.version,
      remotion: JSON.parse(
        readFileSync(join(repo, "remotion/node_modules/@remotion/cli/package.json"), "utf8"),
      ).version,
      melt: version(["melt", "--version"]),
      ffmpeg: version(["ffmpeg", "-version"]),
      ffprobe: version(["ffprobe", "-version"]),
    },
    export: {
      alpha_clip: {
        path: relative(fixtureRoot, alphaPath),
        sha256: sha(alphaPath),
        byte_length: statSync(alphaPath).size,
      },
      path: "Vean bakeOverlaysForExport -> alpha ProRes 4444 -> upper MLT track -> Vean stillTool",
    },
    frames,
  };
  const manifestPath = join(outputRoot, "manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  run(["bunx", "biome", "format", "--write", manifestPath]);
  chmodSync(manifestPath, 0o444);
  return { manifestPath, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const valueAfter = (flag: string) => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  const outputRoot = valueAfter("--output");
  const policyPath = valueAfter("--policy");
  if (!outputRoot || !policyPath) throw new Error("--output and --policy are required");
  const control = valueAfter("--control") as RenderTruthControlId | undefined;
  const result = await generateRenderTruth({
    outputRoot,
    policyPath,
    ...(control ? { control } : {}),
  });
  console.log(JSON.stringify({ status: "generated", manifestPath: result.manifestPath }));
}
