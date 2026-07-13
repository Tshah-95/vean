import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SourceProxyError,
  buildSourceProxy,
  sourceProxyCacheDir,
} from "../src/preview/source-proxy";

type FakeOptions = {
  sourceProbeCode?: number;
  sourcePixFmt?: string;
  encoderCode?: number;
  encoderWrites?: boolean;
  encoderDelayMs?: number;
  artifactProbeCode?: number;
  artifactCodec?: string;
  artifactPixFmt?: string;
  artifactAlphaMode?: string;
};

function installMediaTools(options: FakeOptions = {}) {
  let encodeCalls = 0;
  const spawn = vi.fn((argv: string[]) => {
    const command = basename(argv[0] ?? "");
    if (command.includes("ffprobe")) {
      const artifactProbe = argv.some((arg) => arg.includes("codec_name"));
      if (!artifactProbe) {
        return fakeProcess({
          code: options.sourceProbeCode ?? 0,
          stderr: options.sourceProbeCode ? "probe unavailable" : "",
          stdout: JSON.stringify({
            streams: [{ pix_fmt: options.sourcePixFmt ?? "yuv420p", width: 640, height: 360 }],
          }),
        });
      }
      return fakeProcess({
        code: options.artifactProbeCode ?? 0,
        stderr: options.artifactProbeCode ? "invalid data" : "",
        stdout: JSON.stringify({
          streams: [
            {
              codec_name: options.artifactCodec ?? "h264",
              pix_fmt: options.artifactPixFmt ?? "yuv420p",
              width: 640,
              height: 360,
              ...(options.artifactAlphaMode
                ? { tags: { alpha_mode: options.artifactAlphaMode } }
                : {}),
            },
          ],
        }),
      });
    }
    if (command.includes("ffmpeg") && argv[1] === "-version") {
      return fakeProcess({ stdout: "ffmpeg version test-build\n" });
    }
    if (command.includes("ffmpeg") && argv[1] === "-y") {
      encodeCalls++;
      const output = argv.at(-1) as string;
      const exited = (async () => {
        if (options.encoderDelayMs) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, options.encoderDelayMs));
        }
        if ((options.encoderCode ?? 0) === 0 && options.encoderWrites !== false) {
          writeFileSync(output, `valid-proxy-${encodeCalls}`);
        }
        return options.encoderCode ?? 0;
      })();
      return {
        stdout: new Response("").body,
        stderr: new Response(options.encoderCode ? "killed" : "").body,
        exited,
      };
    }
    throw new Error(`unexpected spawn: ${argv.join(" ")}`);
  });
  // @ts-expect-error — minimal Bun subprocess shim for Node-hosted Vitest.
  globalThis.Bun = { spawn };
  return { spawn, encodeCalls: () => encodeCalls };
}

function fakeProcess(output: { code?: number; stdout?: string; stderr?: string }) {
  return {
    stdout: new Response(output.stdout ?? "").body,
    stderr: new Response(output.stderr ?? "").body,
    exited: Promise.resolve(output.code ?? 0),
  };
}

let root: string;
let source: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vean-source-proxy-"));
  source = join(root, "source.mov");
  writeFileSync(source, "source-bytes");
  // @ts-expect-error — ensure a clean fake per test.
  globalThis.Bun = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error — do not leak the fake into another file.
  globalThis.Bun = undefined;
  rmSync(root, { recursive: true, force: true });
});

function cacheEntries(): string[] {
  const dir = sourceProxyCacheDir(root);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe("source proxy integrity", () => {
  it("fails closed when alpha is unknown and writes no proxy or cache metadata", async () => {
    installMediaTools({ sourceProbeCode: 1 });
    const error = await buildSourceProxy(root, source).catch((caught) => caught);
    expect(error).toBeInstanceOf(SourceProxyError);
    expect(error).toMatchObject({ code: "ALPHA_PROBE_UNKNOWN", sourcePath: source });
    expect(cacheEntries()).toEqual([]);
  });

  it("binds the key to source bytes even when size and mtime are unchanged", async () => {
    const tools = installMediaTools();
    writeFileSync(source, "aaaa");
    const fixed = new Date("2025-01-01T00:00:00.000Z");
    utimesSync(source, fixed, fixed);
    const first = await buildSourceProxy(root, source);
    writeFileSync(source, "bbbb");
    utimesSync(source, fixed, fixed);
    const second = await buildSourceProxy(root, source);
    expect(statSync(source).size).toBe(4);
    expect(first.key).not.toBe(second.key);
    expect(tools.encodeCalls()).toBe(2);
  });

  it("singleflights concurrent requests to one encoder and one publication", async () => {
    const tools = installMediaTools({ encoderDelayMs: 30 });
    const results = await Promise.all([
      buildSourceProxy(root, source),
      buildSourceProxy(root, source),
      buildSourceProxy(root, source),
    ]);
    expect(tools.encodeCalls()).toBe(1);
    expect(new Set(results.map((result) => result.proxyPath)).size).toBe(1);
    expect(
      cacheEntries().filter((entry) => entry.endsWith(".lock") || entry.includes(".tmp-")),
    ).toEqual([]);
  });

  it("validates and reuses an intact cache entry without re-encoding", async () => {
    const tools = installMediaTools();
    const first = await buildSourceProxy(root, source);
    const second = await buildSourceProxy(root, source);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.key).toBe(first.key);
    expect(tools.encodeCalls()).toBe(1);
    const manifestPath = join(sourceProxyCacheDir(root), `${first.key}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schema: string;
      sourceSha256: string;
      encoderIdentity: string;
      encoderArgv: string[];
      artifactSha256: string;
    };
    expect(manifest.schema).toBe("vean-source-proxy-v2");
    expect(manifest.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.encoderIdentity).toContain("ffmpeg version test-build");
    expect(manifest.encoderArgv.at(-1)).toBe("<OUTPUT>");
    expect(manifest.encoderArgv.join(" ")).not.toContain(".tmp-");
    expect(manifest.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects exit-zero/no-output and leaves no published cache", async () => {
    installMediaTools({ encoderWrites: false });
    await expect(buildSourceProxy(root, source)).rejects.toMatchObject({
      code: "ENCODER_NO_OUTPUT",
    });
    expect(cacheEntries()).toEqual([]);
  });

  it.each([
    ["truncated output", { artifactProbeCode: 1 }, "PROXY_VALIDATION_FAILED"],
    ["wrong codec", { artifactCodec: "hevc" }, "PROXY_VALIDATION_FAILED"],
    ["wrong pixel format", { artifactPixFmt: "yuv444p" }, "PROXY_VALIDATION_FAILED"],
  ] as const)("rejects %s and publishes nothing", async (_label, options, code) => {
    installMediaTools(options);
    await expect(buildSourceProxy(root, source)).rejects.toMatchObject({ code });
    expect(cacheEntries()).toEqual([]);
  });

  it("rejects a VP9 alpha artifact that does not actually carry alpha", async () => {
    installMediaTools({
      sourcePixFmt: "yuva444p12le",
      artifactCodec: "vp9",
      artifactPixFmt: "yuv420p",
    });
    await expect(buildSourceProxy(root, source)).rejects.toMatchObject({
      code: "PROXY_VALIDATION_FAILED",
    });
    expect(cacheEntries()).toEqual([]);
  });

  it("detects a corrupt cache artifact, deletes it, and regenerates", async () => {
    const tools = installMediaTools();
    const first = await buildSourceProxy(root, source);
    writeFileSync(first.proxyPath, "corrupt-cache");
    const second = await buildSourceProxy(root, source);
    expect(second.cached).toBe(false);
    expect(tools.encodeCalls()).toBe(2);
    expect(readFileSync(second.proxyPath, "utf8")).toBe("valid-proxy-2");
  });

  it("cleans staging files and locks when the encoder is killed", async () => {
    installMediaTools({ encoderCode: 137, encoderWrites: false });
    await expect(buildSourceProxy(root, source)).rejects.toMatchObject({ code: "ENCODER_FAILED" });
    expect(cacheEntries()).toEqual([]);
  });
});
