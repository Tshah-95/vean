// Driver contract tests — the melt/ffmpeg subprocess seam.
//
// The driver shells out via `Bun.spawn`. Vitest runs its workers under NODE (not
// Bun), so the `Bun` global is absent here — the driver reads `globalThis.Bun`
// dynamically, so a test installs a fake `Bun.spawn` on `globalThis` and asserts
// against the REAL driver code path (argv construction, pipe draining, exit
// mapping). No melt/ffmpeg binary is invoked; what we lock is the COMMAND each
// function emits — a format contract against those CLIs — plus the exit→throw
// mapping and the pure cell→frame math.
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MeltError, contactSheet, render, still } from "../src/index";

// ─── Fake Bun.spawn ──────────────────────────────────────────────────────────
// A spawn stub that records argv and returns canned stdout/stderr + an exit code.
// `outputs` lets a single test program several sequential spawns (contactSheet
// runs ffprobe THEN ffmpeg) by index.

type SpawnOutput = { code?: number; stdout?: string; stderr?: string };

function installSpawn(outputs: SpawnOutput[] | SpawnOutput): Mock {
  const seq = Array.isArray(outputs) ? outputs : [outputs];
  let call = 0;
  const spawn = vi.fn((_cmd: string[]) => {
    const o = seq[Math.min(call, seq.length - 1)] ?? {};
    call += 1;
    return {
      stdout: new Response(o.stdout ?? "").body,
      stderr: new Response(o.stderr ?? "").body,
      exited: Promise.resolve(o.code ?? 0),
    };
  });
  // @ts-expect-error — minimal Bun shim for the Node-hosted test runner.
  globalThis.Bun = { spawn };
  return spawn;
}

/** The argv of the Nth spawn call (the array passed to Bun.spawn). */
function argvOf(spawn: Mock, n = 0): string[] {
  return spawn.mock.calls[n]?.[0] as string[];
}

beforeEach(() => {
  // @ts-expect-error — ensure a clean slate per test.
  globalThis.Bun = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error — don't leak the shim across files.
  globalThis.Bun = undefined;
});

// ─── render ──────────────────────────────────────────────────────────────────

describe("render", () => {
  it("emits the canonical melt avformat command (golden)", async () => {
    const spawn = installSpawn({ stderr: "Current Position: 90\n" });
    const res = await render("/abs/in.mlt", "/abs/out.mp4");

    // GOLDEN: this exact argv is the contract against `melt`.
    expect(argvOf(spawn)).toEqual([
      "melt",
      "/abs/in.mlt",
      "-consumer",
      "avformat:/abs/out.mp4",
      "vcodec=libx264",
      "pix_fmt=yuv420p",
      "real_time=-1",
    ]);
    expect(res).toEqual({
      outPath: "/abs/out.mp4",
      code: 0,
      stderr: "Current Position: 90\n",
    });
  });

  it("honors vcodec / pixFmt overrides and appends extraArgs verbatim", async () => {
    const spawn = installSpawn({});
    await render("/in.mlt", "/out.webm", {
      vcodec: "libvpx-vp9",
      pixFmt: "yuva420p",
      extraArgs: ["crf=18", "an=1"],
    });
    expect(argvOf(spawn)).toEqual([
      "melt",
      "/in.mlt",
      "-consumer",
      "avformat:/out.webm",
      "vcodec=libvpx-vp9",
      "pix_fmt=yuva420p",
      "real_time=-1",
      "crf=18",
      "an=1",
    ]);
  });

  it("maps a nonzero exit to a thrown MeltError carrying stderr + command", async () => {
    installSpawn({ code: 1, stderr: "[producer_avformat] cannot open /in.mlt\n" });
    await expect(render("/in.mlt", "/out.mp4")).rejects.toBeInstanceOf(MeltError);
    await expect(render("/in.mlt", "/out.mp4")).rejects.toThrow(/melt exited 1/);
    await expect(render("/in.mlt", "/out.mp4")).rejects.toThrow(/cannot open \/in\.mlt/);
  });

  it("MeltError exposes structured fields for diagnostics", async () => {
    installSpawn({ code: 137, stderr: "killed" });
    const err = await render("/in.mlt", "/out.mp4").catch((e) => e);
    expect(err).toBeInstanceOf(MeltError);
    expect(err.bin).toBe("melt");
    expect(err.code).toBe(137);
    expect(err.stderr).toBe("killed");
    expect(err.args[0]).toBe("/in.mlt");
  });
});

// ─── still ───────────────────────────────────────────────────────────────────

describe("still", () => {
  it("windows the producer to one inclusive frame and PNG-encodes (golden)", async () => {
    const spawn = installSpawn({});
    const res = await still("/in.mlt", 42, "/out.png");

    // GOLDEN: in==out==frame ⇒ playtime 1; vcodec=png forces a true PNG (melt's
    // avformat consumer defaults to mjpeg and would write a JPEG into .png).
    // update=1 is forwarded to the image2 muxer so a single fixed-name PNG write is
    // warning-free and overwrite-correct (no stale-frame compare).
    expect(argvOf(spawn)).toEqual([
      "melt",
      "/in.mlt",
      "in=42",
      "out=42",
      "-consumer",
      "avformat:/out.png",
      "vcodec=png",
      "frames=1",
      "update=1",
    ]);
    expect(res.outPath).toBe("/out.png");
    expect(res.code).toBe(0);
  });

  it("frame 0 is valid (the first frame)", async () => {
    const spawn = installSpawn({});
    await still("/in.mlt", 0, "/f0.png");
    expect(argvOf(spawn)).toContain("in=0");
    expect(argvOf(spawn)).toContain("out=0");
  });

  it("rejects a negative or non-integer frame before spawning", async () => {
    const spawn = installSpawn({});
    await expect(still("/in.mlt", -1, "/o.png")).rejects.toThrow(/non-negative integer/);
    await expect(still("/in.mlt", 1.5, "/o.png")).rejects.toThrow(/non-negative integer/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("maps a nonzero melt exit to MeltError", async () => {
    installSpawn({ code: 2, stderr: "no such frame" });
    await expect(still("/in.mlt", 9999, "/o.png")).rejects.toBeInstanceOf(MeltError);
  });
});

// ─── contactSheet ────────────────────────────────────────────────────────────

describe("contactSheet", () => {
  it("probes the frame count then tiles (golden argv for both spawns)", async () => {
    // 100 real frames, default 5×5 = 25 cells ⇒ interval = floor(100/25) = 4.
    const spawn = installSpawn([{ stdout: "100\n" }, {}]);
    const sheet = await contactSheet("/in.mp4", "/sheet.png");

    // GOLDEN spawn #0 — ffprobe counts decoded frames of v:0.
    expect(argvOf(spawn, 0)).toEqual([
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "default=nokey=1:noprint_wrappers=1",
      "/in.mp4",
    ]);

    // GOLDEN spawn #1 — ffmpeg select+scale+tile. cellW = round(1280/5/2)*2 = 256.
    expect(argvOf(spawn, 1)).toEqual([
      "ffmpeg",
      "-y",
      "-i",
      "/in.mp4",
      "-frames:v",
      "1",
      "-vf",
      "select='not(mod(n\\,4))',scale=256:-2,tile=5x5:margin=12:padding=12:color=0x101010",
      "-fps_mode",
      "vfr",
      "/sheet.png",
    ]);

    expect(sheet.outPath).toBe("/sheet.png");
    expect(sheet.cols).toBe(5);
    expect(sheet.rows).toBe(5);
  });

  it("computes the cell→frame map matching the ffmpeg select stride (golden)", async () => {
    // 100 frames, 25 cells, interval 4 ⇒ frames 0,4,8,…,96 (all 25 fit).
    installSpawn([{ stdout: "100" }, {}]);
    const sheet = await contactSheet("/in.mp4", "/s.png");
    expect(sheet.cellFrames).toEqual([
      0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48, 52, 56, 60, 64, 68, 72, 76, 80, 84, 88, 92,
      96,
    ]);
  });

  it("truncates the map when the stride runs off the end of a short clip", async () => {
    // 10 frames, 3×3 = 9 cells, interval = floor(10/9) = 1 ⇒ frames 0..8 (9 cells,
    // last needed frame is 8 < 10, so all 9 fit).
    installSpawn([{ stdout: "10" }, {}]);
    const sheet = await contactSheet("/in.mp4", "/s.png", 3, 3);
    expect(sheet.cellFrames).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("never samples past the clip even when interval clamps to 1", async () => {
    // 5 frames but 5×5 = 25 cells: interval clamps to 1; only 5 cells get a real
    // frame (0..4) — the rest of the grid is empty, not out-of-range frames.
    installSpawn([{ stdout: "5" }, {}]);
    const sheet = await contactSheet("/in.mp4", "/s.png");
    expect(sheet.cellFrames).toEqual([0, 1, 2, 3, 4]);
    expect(sheet.cellFrames.length).toBeLessThan(25);
  });

  it("uses a fixed neutral pad colour (no brand coupling)", async () => {
    const spawn = installSpawn([{ stdout: "30" }, {}]);
    await contactSheet("/in.mp4", "/s.png", 2, 2);
    const vf = argvOf(spawn, 1)[argvOf(spawn, 1).indexOf("-vf") + 1];
    expect(vf).toContain("color=0x101010");
  });

  it("throws if ffprobe yields no usable frame count", async () => {
    installSpawn([{ stdout: "N/A\n" }]);
    await expect(contactSheet("/in.mp4", "/s.png")).rejects.toThrow(/could not read frame count/);
  });

  it("propagates an ffmpeg failure as a MeltError (after a successful probe)", async () => {
    installSpawn([{ stdout: "50" }, { code: 1, stderr: "Invalid argument" }]);
    const err = await contactSheet("/in.mp4", "/s.png").catch((e) => e);
    expect(err).toBeInstanceOf(MeltError);
    expect(err.bin).toBe("ffmpeg");
  });

  it("rejects non-positive grid dimensions before spawning", async () => {
    const spawn = installSpawn([{ stdout: "100" }, {}]);
    await expect(contactSheet("/in.mp4", "/s.png", 0, 4)).rejects.toThrow(/positive integers/);
    await expect(contactSheet("/in.mp4", "/s.png", 4, -1)).rejects.toThrow(/positive integers/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

// ─── pipe draining ───────────────────────────────────────────────────────────

describe("subprocess plumbing", () => {
  it("fully captures a large stderr stream (no buffer deadlock)", async () => {
    const big = "frame progress line\n".repeat(5000);
    installSpawn({ stderr: big });
    const res = await render("/in.mlt", "/out.mp4");
    expect(res.stderr).toBe(big);
    expect(res.stderr.length).toBe(big.length);
  });
});
