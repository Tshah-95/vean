import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceProxyApiError, fetchSourceProxyBlob } from "../viewer/src/decode/sourceProxyApi";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // @ts-expect-error — remove the minimal Bun shim.
  globalThis.Bun = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; source: string; timeline: string } {
  const root = mkdtempSync(join(tmpdir(), "vean-source-proxy-api-"));
  roots.push(root);
  const source = join(root, "overlay.mov");
  const timeline = join(root, "main.mlt");
  writeFileSync(source, "alpha-source");
  writeFileSync(
    timeline,
    `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.38.0" root="${root}" title="proxy-api">
  <profile description="test" width="640" height="360" progressive="1" sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9" frame_rate_num="30" frame_rate_den="1" colorspace="709"/>
  <producer id="producer0" in="0" out="29"><property name="length">30</property><property name="resource">${source}</property><property name="shotcut:uuid">source-1</property></producer>
  <playlist id="playlist0"><property name="shotcut:video">1</property><property name="shotcut:audio">0</property><entry producer="producer0" in="0" out="29"/></playlist>
  <tractor id="tractor0" shotcut="1" title="proxy-api"><track producer="playlist0"/></tractor>
</mlt>\n`,
  );
  return { root, source, timeline };
}

describe("source-proxy API and viewer failure contract", () => {
  it("returns an attributed typed 422 and creates no cache when alpha probing fails", async () => {
    const { root, source, timeline } = fixture();
    const ffprobe = join(root, "ffprobe-fails");
    writeFileSync(ffprobe, "#!/bin/sh\necho 'ffprobe unavailable' >&2\nexit 1\n");
    chmodSync(ffprobe, 0o755);
    const child = spawnSync(
      "bun",
      [join(process.cwd(), "tests/helpers/source-proxy-api-case.ts"), root, source, timeline],
      {
        encoding: "utf8",
        env: { ...process.env, VEAN_FFPROBE: ffprobe },
      },
    );
    expect(child.status, child.stderr).toBe(0);
    const response = JSON.parse(child.stdout.trim()) as { status: number; body: unknown };
    expect(response.status, JSON.stringify(response.body)).toBe(422);
    expect(response.body).toMatchObject({
      ok: false,
      kind: "source-proxy",
      code: "ALPHA_PROBE_UNKNOWN",
      sourcePath: source,
    });
    const cache = join(root, ".vean", "cache", "source-proxy");
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
  });

  it("preserves code, source attribution, detail, and status in the product fetch path", async () => {
    const sourcePath = "/project/media/overlay.mov";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: false,
              kind: "source-proxy",
              code: "ALPHA_PROBE_UNKNOWN",
              sourcePath,
              detail: "Cannot determine whether the source has alpha",
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
      ),
    );
    const error = await fetchSourceProxyBlob("/api/source-proxy?path=ignored").catch(
      (caught) => caught,
    );
    expect(error).toBeInstanceOf(SourceProxyApiError);
    expect(error).toMatchObject({
      code: "ALPHA_PROBE_UNKNOWN",
      sourcePath,
      status: 422,
    });
  });
});
