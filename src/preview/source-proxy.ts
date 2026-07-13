// Per-source decode-proxy builder for the live preview. Proxies are derived,
// content-addressed artifacts, but they are still product data: publishing an
// opaque, truncated, stale, or half-written proxy changes what the user sees.
// This module therefore treats the cache as a tiny transactional artifact store.
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveBin } from "../driver/melt";

const STATE_DIR_NAME = ".vean";
/** Bump whenever codec flags, validation, or manifest semantics change. */
export const SOURCE_PROXY_SCHEMA = "vean-source-proxy-v2";
const LOCK_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 20;

export type SourceProxyErrorCode =
  | "SOURCE_NOT_FOUND"
  | "ALPHA_PROBE_UNKNOWN"
  | "ENCODER_IDENTITY_UNKNOWN"
  | "ENCODER_FAILED"
  | "ENCODER_NO_OUTPUT"
  | "SOURCE_CHANGED"
  | "PROXY_VALIDATION_FAILED"
  | "PROXY_LOCK_TIMEOUT";

/** Product-facing, attributable failure. `sourcePath` is intentionally carried
 * through the API and viewer so a failed overlay is never an anonymous black box. */
export class SourceProxyError extends Error {
  constructor(
    readonly code: SourceProxyErrorCode,
    readonly sourcePath: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(detail, options);
    this.name = "SourceProxyError";
  }
}

const SOURCE_PROXY_ERROR_CODES = new Set<SourceProxyErrorCode>([
  "SOURCE_NOT_FOUND",
  "ALPHA_PROBE_UNKNOWN",
  "ENCODER_IDENTITY_UNKNOWN",
  "ENCODER_FAILED",
  "ENCODER_NO_OUTPUT",
  "SOURCE_CHANGED",
  "PROXY_VALIDATION_FAILED",
  "PROXY_LOCK_TIMEOUT",
]);

/** Hot reload can evaluate the module twice, so API mapping must not rely solely
 * on constructor identity across the reload boundary. */
export function isSourceProxyError(error: unknown): error is SourceProxyError {
  if (error instanceof SourceProxyError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown; sourcePath?: unknown };
  return (
    candidate.name === "SourceProxyError" &&
    typeof candidate.code === "string" &&
    SOURCE_PROXY_ERROR_CODES.has(candidate.code as SourceProxyErrorCode) &&
    typeof candidate.sourcePath === "string"
  );
}

export function sourceProxyCacheDir(repo = process.cwd()): string {
  return resolve(repo, STATE_DIR_NAME, "cache", "source-proxy");
}

function evenDim(value: number): number {
  return Math.max(2, Math.round(value / 2) * 2);
}

export type SourceProxyOpts = {
  maxEdge?: number;
  gop?: number;
  intra?: boolean;
  force?: boolean;
};

export type SourceProxyResult = {
  proxyPath: string;
  key: string;
  width: number;
  height: number;
  cached: boolean;
  hasAlpha: boolean;
  contentType: "video/mp4" | "video/webm";
};

type SourceProbe = {
  pixFmt: string;
  width: number;
  height: number;
  hasAlpha: boolean;
};

type ArtifactProbe = {
  codecName: string;
  pixFmt: string;
  width: number;
  height: number;
  alphaMode: string | null;
};

type SourceProxyManifest = {
  schema: typeof SOURCE_PROXY_SCHEMA;
  key: string;
  sourcePath: string;
  sourceSha256: string;
  encoderIdentity: string;
  encoderArgv: string[];
  hasAlpha: boolean;
  codecName: "h264" | "vp9";
  pixFmt: string;
  width: number;
  height: number;
  artifactSha256: string;
  artifactBytes: number;
};

type SpawnCapture = { code: number; stdout: string; stderr: string };

async function spawnCapture(argv: string[]): Promise<SpawnCapture> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

function alphaPixFmt(pixFmt: string): boolean {
  return (
    /^yuva/.test(pixFmt) ||
    /^ya\d/.test(pixFmt) ||
    /^gbra/.test(pixFmt) ||
    ["rgba", "bgra", "argb", "abgr", "pal8"].includes(pixFmt) ||
    pixFmt.includes("rgba") ||
    pixFmt.includes("bgra")
  );
}

/** Alpha is a routing decision, so an unavailable/malformed probe is not an
 * opaque result. It is an attributed 422 product error and produces no cache. */
async function probeSource(sourcePath: string): Promise<SourceProbe> {
  let result: SpawnCapture;
  try {
    result = await spawnCapture([
      resolveBin("ffprobe"),
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=pix_fmt,width,height",
      "-of",
      "json",
      sourcePath,
    ]);
  } catch (error) {
    throw new SourceProxyError(
      "ALPHA_PROBE_UNKNOWN",
      sourcePath,
      `Cannot determine whether the source has alpha: ${String((error as Error)?.message ?? error)}`,
      { cause: error },
    );
  }
  if (result.code !== 0) {
    throw new SourceProxyError(
      "ALPHA_PROBE_UNKNOWN",
      sourcePath,
      `Cannot determine whether the source has alpha: ${result.stderr.trim() || `ffprobe exited ${result.code}`}`,
    );
  }
  try {
    const raw = JSON.parse(result.stdout) as {
      streams?: Array<{ pix_fmt?: unknown; width?: unknown; height?: unknown }>;
    };
    const stream = raw.streams?.[0];
    const pixFmt = typeof stream?.pix_fmt === "string" ? stream.pix_fmt.trim().toLowerCase() : "";
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (
      !pixFmt ||
      !Number.isInteger(width) ||
      width <= 0 ||
      !Number.isInteger(height) ||
      height <= 0
    ) {
      throw new Error("ffprobe returned no usable video pix_fmt/dimensions");
    }
    return { pixFmt, width, height, hasAlpha: alphaPixFmt(pixFmt) };
  } catch (error) {
    throw new SourceProxyError(
      "ALPHA_PROBE_UNKNOWN",
      sourcePath,
      `Cannot determine whether the source has alpha: ${String((error as Error).message)}`,
      { cause: error },
    );
  }
}

async function encoderIdentity(sourcePath: string): Promise<string> {
  // Both variants are direct per-file ffmpeg transcodes. MLT remains the timeline
  // renderer, but routing a single source through melt would add an implicit,
  // hard-to-record profile file to the artifact lineage.
  const bin = resolveBin("ffmpeg");
  let result: SpawnCapture;
  try {
    result = await spawnCapture([bin, "-version"]);
  } catch (error) {
    throw new SourceProxyError(
      "ENCODER_IDENTITY_UNKNOWN",
      sourcePath,
      `Cannot identify proxy encoder ${bin}: ${String((error as Error)?.message ?? error)}`,
      { cause: error },
    );
  }
  const version = (result.stdout || result.stderr).trim().split(/\r?\n/)[0]?.trim();
  if (result.code !== 0 || !version) {
    throw new SourceProxyError(
      "ENCODER_IDENTITY_UNKNOWN",
      sourcePath,
      `Cannot identify proxy encoder ${bin}: ${result.stderr.trim() || `exit ${result.code}`}`,
    );
  }
  return `${bin}::${version}`;
}

function dimensions(probe: SourceProbe, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(probe.width, probe.height);
  const scale = longest > maxEdge ? maxEdge / longest : 1;
  return { width: evenDim(probe.width * scale), height: evenDim(probe.height * scale) };
}

function cacheKey(input: {
  sourcePath: string;
  sourceSha256: string;
  encoderIdentity: string;
  maxEdge: number;
  gop: number;
  hasAlpha: boolean;
  intra: boolean;
}): string {
  return createHash("sha256")
    .update(JSON.stringify({ schema: SOURCE_PROXY_SCHEMA, ...input }))
    .digest("hex")
    .slice(0, 32);
}

async function probeArtifact(path: string, sourcePath: string): Promise<ArtifactProbe> {
  let result: SpawnCapture;
  try {
    result = await spawnCapture([
      resolveBin("ffprobe"),
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,pix_fmt,width,height:stream_tags=alpha_mode",
      "-of",
      "json",
      path,
    ]);
  } catch (error) {
    throw new SourceProxyError(
      "PROXY_VALIDATION_FAILED",
      sourcePath,
      `Proxy validation could not run: ${String((error as Error)?.message ?? error)}`,
      { cause: error },
    );
  }
  if (result.code !== 0) {
    throw new SourceProxyError(
      "PROXY_VALIDATION_FAILED",
      sourcePath,
      `Proxy is not decodable: ${result.stderr.trim() || `ffprobe exited ${result.code}`}`,
    );
  }
  try {
    const raw = JSON.parse(result.stdout) as {
      streams?: Array<{
        codec_name?: unknown;
        pix_fmt?: unknown;
        width?: unknown;
        height?: unknown;
        tags?: { alpha_mode?: unknown };
      }>;
    };
    const stream = raw.streams?.[0];
    const codecName = typeof stream?.codec_name === "string" ? stream.codec_name : "";
    const pixFmt = typeof stream?.pix_fmt === "string" ? stream.pix_fmt.toLowerCase() : "";
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (!codecName || !pixFmt || !Number.isInteger(width) || !Number.isInteger(height)) {
      throw new Error("ffprobe returned incomplete video metadata");
    }
    return {
      codecName,
      pixFmt,
      width,
      height,
      alphaMode: typeof stream?.tags?.alpha_mode === "string" ? stream.tags.alpha_mode : null,
    };
  } catch (error) {
    throw new SourceProxyError(
      "PROXY_VALIDATION_FAILED",
      sourcePath,
      `Proxy metadata is invalid: ${String((error as Error).message)}`,
      { cause: error },
    );
  }
}

function assertArtifact(
  probe: ArtifactProbe,
  expected: { sourcePath: string; hasAlpha: boolean; width: number; height: number },
): void {
  const codec = expected.hasAlpha ? "vp9" : "h264";
  const alpha = alphaPixFmt(probe.pixFmt) || probe.alphaMode === "1";
  const pixFmtOk = expected.hasAlpha ? alpha : probe.pixFmt === "yuv420p" && !alpha;
  if (
    probe.codecName !== codec ||
    !pixFmtOk ||
    probe.width !== expected.width ||
    probe.height !== expected.height
  ) {
    throw new SourceProxyError(
      "PROXY_VALIDATION_FAILED",
      expected.sourcePath,
      `Proxy stream mismatch: expected ${codec}/${expected.hasAlpha ? "alpha" : "yuv420p"} ${expected.width}x${expected.height}, got ${probe.codecName || "none"}/${probe.pixFmt || "none"} ${probe.width}x${probe.height}${probe.alphaMode ? ` alpha_mode=${probe.alphaMode}` : ""}`,
    );
  }
}

function removeArtifacts(...paths: string[]): void {
  for (const path of paths) rmSync(path, { force: true, recursive: true });
}

function syncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncDir(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function validateCache(
  artifactPath: string,
  manifestPath: string,
  identity: Omit<SourceProxyManifest, "artifactSha256" | "artifactBytes" | "pixFmt">,
): Promise<boolean> {
  if (!existsSync(artifactPath) || !existsSync(manifestPath)) return false;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as SourceProxyManifest;
    for (const field of [
      "schema",
      "key",
      "sourcePath",
      "sourceSha256",
      "encoderIdentity",
      "hasAlpha",
      "codecName",
      "width",
      "height",
    ] as const) {
      if (manifest[field] !== identity[field]) throw new Error(`manifest ${field} mismatch`);
    }
    if (JSON.stringify(manifest.encoderArgv) !== JSON.stringify(identity.encoderArgv)) {
      throw new Error("manifest encoderArgv mismatch");
    }
    const stat = statSync(artifactPath);
    if (!stat.isFile() || stat.size <= 0 || stat.size !== manifest.artifactBytes) {
      throw new Error("artifact size mismatch");
    }
    if ((await sha256File(artifactPath)) !== manifest.artifactSha256) {
      throw new Error("artifact hash mismatch");
    }
    const probe = await probeArtifact(artifactPath, identity.sourcePath);
    assertArtifact(probe, identity);
    if (probe.pixFmt !== manifest.pixFmt) throw new Error("artifact pix_fmt drift");
    return true;
  } catch {
    removeArtifacts(artifactPath, manifestPath);
    return false;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireLock(lockPath: string, sourcePath: string): Promise<() => void> {
  const started = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath);
      try {
        writeFileSync(
          join(lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, at: Date.now() }),
        );
      } catch (error) {
        rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      return () => rmSync(lockPath, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8")) as {
          pid?: number;
          at?: number;
        };
        if (typeof owner.pid === "number" && !processAlive(owner.pid)) {
          rmSync(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch {
        // A creator may be between mkdir and owner write. If it never finished,
        // reap the ownerless directory after a short grace interval.
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 1_000) {
            rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new SourceProxyError(
          "PROXY_LOCK_TIMEOUT",
          sourcePath,
          "Timed out waiting for another source-proxy writer",
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, LOCK_POLL_MS));
    }
  }
}

const inFlight = new Map<string, Promise<SourceProxyResult>>();

export async function buildSourceProxy(
  repo: string,
  srcPath: string,
  opts: SourceProxyOpts = {},
): Promise<SourceProxyResult> {
  const sourcePath = resolve(srcPath);
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new SourceProxyError("SOURCE_NOT_FOUND", sourcePath, `Source not found: ${sourcePath}`);
  }

  const maxEdge = opts.maxEdge ?? 960;
  const intra = opts.intra ?? false;
  const requestedGop = intra ? 1 : (opts.gop ?? 15);
  const [sourceSha256, sourceProbe] = await Promise.all([
    sha256File(sourcePath),
    probeSource(sourcePath),
  ]);
  const hasAlpha = sourceProbe.hasAlpha;
  const effectiveIntra = intra && !hasAlpha;
  const gop = hasAlpha ? (opts.gop ?? 15) : requestedGop;
  const identity = await encoderIdentity(sourcePath);
  const { width, height } = dimensions(sourceProbe, maxEdge);
  const key = cacheKey({
    sourcePath,
    sourceSha256,
    encoderIdentity: identity,
    maxEdge,
    gop,
    hasAlpha,
    intra: effectiveIntra,
  });

  const existing = inFlight.get(key);
  if (existing) return existing;
  const operation = buildLocked({
    repo,
    sourcePath,
    sourceSha256,
    encoderIdentity: identity,
    key,
    width,
    height,
    gop,
    hasAlpha,
    effectiveIntra,
    force: opts.force === true,
  });
  inFlight.set(key, operation);
  void operation.then(
    () => {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    },
    () => {
      if (inFlight.get(key) === operation) inFlight.delete(key);
    },
  );
  return operation;
}

async function buildLocked(input: {
  repo: string;
  sourcePath: string;
  sourceSha256: string;
  encoderIdentity: string;
  key: string;
  width: number;
  height: number;
  gop: number;
  hasAlpha: boolean;
  effectiveIntra: boolean;
  force: boolean;
}): Promise<SourceProxyResult> {
  const dir = sourceProxyCacheDir(input.repo);
  mkdirSync(dir, { recursive: true });
  const ext = input.hasAlpha ? "webm" : "mp4";
  const contentType = input.hasAlpha ? "video/webm" : "video/mp4";
  const artifactPath = join(dir, `${input.key}.${ext}`);
  const manifestPath = join(dir, `${input.key}.json`);
  const lockPath = join(dir, `${input.key}.lock`);
  const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const stagedPath = join(dir, `${input.key}.tmp-${token}.${ext}`);
  const stagedManifest = join(dir, `${input.key}.tmp-${token}.json`);
  // Normalize only the transaction-local destination. Every other argument is
  // byte-for-byte what runs and is persisted in the lineage manifest.
  const encoderArgv = input.hasAlpha
    ? [
        resolveBin("ffmpeg"),
        "-y",
        "-i",
        input.sourcePath,
        "-vf",
        `scale=${input.width}:${input.height}`,
        "-c:v",
        "libvpx-vp9",
        "-pix_fmt",
        "yuva420p",
        "-auto-alt-ref",
        "0",
        "-g",
        String(input.gop),
        "-keyint_min",
        String(input.gop),
        "-deadline",
        "realtime",
        "-cpu-used",
        "5",
        "-an",
        "<OUTPUT>",
      ]
    : [
        resolveBin("ffmpeg"),
        "-y",
        "-i",
        input.sourcePath,
        "-vf",
        `scale=${input.width}:${input.height}`,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-g",
        String(input.gop),
        "-keyint_min",
        String(input.gop),
        "-bf",
        "0",
        "-x264-params",
        opaqueX264(input),
        "-an",
        "-movflags",
        "+faststart",
        "<OUTPUT>",
      ];
  const executionArgv = encoderArgv.map((arg) => (arg === "<OUTPUT>" ? stagedPath : arg));
  const expected: Omit<SourceProxyManifest, "artifactSha256" | "artifactBytes" | "pixFmt"> = {
    schema: SOURCE_PROXY_SCHEMA,
    key: input.key,
    sourcePath: input.sourcePath,
    sourceSha256: input.sourceSha256,
    encoderIdentity: input.encoderIdentity,
    encoderArgv,
    hasAlpha: input.hasAlpha,
    codecName: input.hasAlpha ? "vp9" : "h264",
    width: input.width,
    height: input.height,
  };

  const release = await acquireLock(lockPath, input.sourcePath);
  try {
    if (!input.force && (await validateCache(artifactPath, manifestPath, expected))) {
      return {
        proxyPath: artifactPath,
        key: input.key,
        width: input.width,
        height: input.height,
        cached: true,
        hasAlpha: input.hasAlpha,
        contentType,
      };
    }
    removeArtifacts(artifactPath, manifestPath, stagedPath, stagedManifest);
    try {
      const result = await spawnCapture(executionArgv);
      if (result.code !== 0) {
        throw new SourceProxyError(
          "ENCODER_FAILED",
          input.sourcePath,
          `ffmpeg exited ${result.code}: ${result.stderr.trim().slice(-1200)}`,
        );
      }
      if (
        !existsSync(stagedPath) ||
        !statSync(stagedPath).isFile() ||
        statSync(stagedPath).size <= 0
      ) {
        throw new SourceProxyError(
          "ENCODER_NO_OUTPUT",
          input.sourcePath,
          "Proxy encoder exited successfully without producing an artifact",
        );
      }
      if ((await sha256File(input.sourcePath)) !== input.sourceSha256) {
        throw new SourceProxyError(
          "SOURCE_CHANGED",
          input.sourcePath,
          "Source bytes changed while the proxy was being encoded",
        );
      }
      const artifactProbe = await probeArtifact(stagedPath, input.sourcePath);
      assertArtifact(artifactProbe, input);
      const artifactSha256 = await sha256File(stagedPath);
      const artifactBytes = statSync(stagedPath).size;
      const manifest: SourceProxyManifest = {
        ...expected,
        pixFmt: artifactProbe.pixFmt,
        artifactSha256,
        artifactBytes,
      };
      writeFileSync(stagedManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      syncFile(stagedPath);
      syncFile(stagedManifest);
      renameSync(stagedPath, artifactPath);
      renameSync(stagedManifest, manifestPath);
      syncDir(dir);
    } catch (error) {
      removeArtifacts(stagedPath, stagedManifest, artifactPath, manifestPath);
      if (error instanceof SourceProxyError) throw error;
      throw new SourceProxyError(
        "ENCODER_FAILED",
        input.sourcePath,
        String((error as Error)?.message ?? error),
        { cause: error },
      );
    }
    return {
      proxyPath: artifactPath,
      key: input.key,
      width: input.width,
      height: input.height,
      cached: false,
      hasAlpha: input.hasAlpha,
      contentType,
    };
  } finally {
    removeArtifacts(stagedPath, stagedManifest);
    release();
  }
}

function opaqueX264(input: { gop: number; effectiveIntra: boolean }): string {
  return input.effectiveIntra
    ? "keyint=1:min-keyint=1:scenecut=0:bframes=0:intra-refresh=0"
    : `keyint=${input.gop}:min-keyint=${input.gop}:scenecut=0:bframes=0`;
}
