// The READ/RENDER TOOL-CORE gate (Move 2). Proves the four NON-mutating domain
// tools in `src/bridge/tools/read` are honest, transport-free wrappers over the
// SHARED core — the navigation queries (src/query) and the melt driver (src/driver)
// — and obey the read-side contract:
//
//   • resolve-value-at-frame / find-references CALL the shared query (no rule
//     reimplemented), return the typed payload on success, and map a query
//     `notFound` to a typed `ReadError` value (never a throw);
//   • render / still return `touchedUris` (the produced artifact path) — the
//     load-bearing field: render/still are the agent's EYES, so the tool reports
//     the file to inspect next, exactly as a mutating tool reports the doc it
//     changed;
//   • a melt failure (a nonzero exit → thrown MeltError in the driver) becomes a
//     typed `ReadError` (kind `render`/`still`), not an uncaught throw.
//
// Like the driver tests, render/still run under vitest's NODE host (no `Bun`
// global, no melt binary), so a fake `Bun.spawn` exercises the REAL tool code path
// — the argv the driver emits and the `touchedUris` the tool returns. The
// REAL-binary leg (a true PNG/MP4 on disk) is the Bun-hosted `read-tools:artifact`
// gate (`scripts/read-tools-artifact.ts`), alongside `move2:e2e`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isReadError,
  referencesTool,
  renderTool,
  resolveTool,
  stillTool,
} from "../src/bridge/tools/read";
import { fromMlt } from "../src/ir/parse";
import type { Timeline } from "../src/ir/types";

const CORPUS = join(import.meta.dirname, "..", "corpus");
const multitrack = (): Timeline =>
  fromMlt(readFileSync(join(CORPUS, "vean-multitrack.mlt"), "utf8"));

// ─── Fake Bun.spawn (the driver shells out via globalThis.Bun.spawn) ──────────
type SpawnOutput = { code?: number; stdout?: string; stderr?: string };
function installSpawn(o: SpawnOutput = {}): Mock {
  const spawn = vi.fn((_cmd: string[]) => ({
    stdout: new Response(o.stdout ?? "").body,
    stderr: new Response(o.stderr ?? "").body,
    exited: Promise.resolve(o.code ?? 0),
  }));
  // @ts-expect-error — minimal Bun shim for the Node-hosted test runner.
  globalThis.Bun = { spawn };
  return spawn;
}
function argvOf(spawn: Mock, n = 0): string[] {
  return spawn.mock.calls[n]?.[0] as string[];
}
beforeEach(() => {
  // @ts-expect-error — clean slate per test.
  globalThis.Bun = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  // @ts-expect-error — don't leak the shim across files.
  globalThis.Bun = undefined;
});

// ═══════════════════════════════════════════════════════════════════════════
// resolve-value-at-frame — the query wrapper
// ═══════════════════════════════════════════════════════════════════════════
describe("resolveTool — wraps the shared resolveValueAtFrame", () => {
  it("returns {ok:true, result} carrying the resolution path the shared query computed", () => {
    const state = multitrack();
    // clip-0's fadeIn at its first frame — the hot path; produces a level value.
    const outcome = resolveTool(state, 0, {
      scope: "fade",
      clip: "clip-0",
      direction: "in",
    } as never);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // The wrapper returns the SHARED query's typed answer verbatim (path + value).
    expect(Array.isArray(outcome.result.path)).toBe(true);
    expect(outcome.result.path.some((h) => h.produced)).toBe(true);
    expect(outcome.result.scalar).not.toBeNull();
  });

  it("returns {ok:true} for a field-transition property the corpus carries", () => {
    const state = multitrack();
    // The corpus's one field transition (qtblend) carries `compositing`, live at f30.
    const outcome = resolveTool(state, 30, {
      scope: "transition",
      index: 0,
      property: "compositing",
    } as never);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.path.some((h) => h.produced && h.scope === "transition")).toBe(true);
  });

  it("maps a missing target to a typed ReadError (not a throw)", () => {
    const state = multitrack();
    const outcome = resolveTool(state, 0, {
      scope: "fade",
      clip: "ghost-uuid",
      direction: "in",
    } as never);
    expect(isReadError(outcome)).toBe(true);
    if (!isReadError(outcome)) return;
    expect(outcome.kind).toBe("not-found");
    expect(outcome.detail).toMatch(/ghost-uuid/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// find-references — the query wrapper
// ═══════════════════════════════════════════════════════════════════════════
describe("referencesTool — wraps the shared findReferences", () => {
  it("returns {ok:true, result} for a property query (readers/writers)", () => {
    const state = multitrack();
    const outcome = referencesTool(state, { kind: "property", property: "level" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.kind).toBe("property");
  });

  it("maps a missing clip (clip-kind query) to a typed ReadError", () => {
    const state = multitrack();
    const outcome = referencesTool(state, { kind: "clip", clip: "ghost-uuid" });
    expect(isReadError(outcome)).toBe(true);
    if (!isReadError(outcome)) return;
    expect(outcome.kind).toBe("not-found");
    expect(outcome.detail).toMatch(/ghost-uuid/);
  });

  it("a found clip query returns the adjacency set (ok, not an error)", () => {
    const state = multitrack();
    // Pull a real clip uuid off the corpus.
    const firstClip = state.tracks.video[0]?.items.find((i) => i.kind === "clip");
    expect(firstClip).toBeDefined();
    if (!firstClip || firstClip.kind !== "clip") return;
    const outcome = referencesTool(state, { kind: "clip", clip: firstClip.id });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.result.kind !== "clip") return;
    expect(outcome.result.site?.uuid).toBe(firstClip.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// render — the driver wrapper, with touchedUris
// ═══════════════════════════════════════════════════════════════════════════
describe("renderTool — drives melt + returns touchedUris", () => {
  it("returns the produced MP4 in BOTH outPath and touchedUris", async () => {
    const spawn = installSpawn({ stderr: "Current Position: 90\n" });
    const outcome = await renderTool("/abs/in.mlt", "/abs/out.mp4");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.kind).toBe("render");
    expect(outcome.outPath).toBe("/abs/out.mp4");
    // The load-bearing field: the produced artifact is the URI the agent inspects.
    expect(outcome.touchedUris).toEqual(["/abs/out.mp4"]);
    expect(outcome.stderr).toContain("Current Position");
    // It actually drove melt (the shared driver), not a reimplementation.
    expect(argvOf(spawn)[0]).toBe("melt");
    expect(argvOf(spawn)).toContain("avformat:/abs/out.mp4");
  });

  it("maps a nonzero melt exit to a typed ReadError (no throw)", async () => {
    installSpawn({ code: 1, stderr: "[producer_avformat] cannot open /abs/in.mlt\n" });
    const outcome = await renderTool("/abs/in.mlt", "/abs/out.mp4");
    expect(isReadError(outcome)).toBe(true);
    if (!isReadError(outcome)) return;
    expect(outcome.kind).toBe("render");
    expect(outcome.detail).toMatch(/cannot open/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// still — the driver wrapper, with touchedUris
// ═══════════════════════════════════════════════════════════════════════════
describe("stillTool — grabs one frame + returns touchedUris (the agent's eye)", () => {
  it("returns the produced PNG in BOTH outPath and touchedUris", async () => {
    const spawn = installSpawn({});
    const outcome = await stillTool("/abs/in.mlt", 42, "/abs/f42.png");
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.kind).toBe("still");
    expect(outcome.outPath).toBe("/abs/f42.png");
    expect(outcome.touchedUris).toEqual(["/abs/f42.png"]);
    // The driver windowed the producer to one inclusive frame + PNG-encoded.
    expect(argvOf(spawn)).toContain("in=42");
    expect(argvOf(spawn)).toContain("out=42");
    expect(argvOf(spawn)).toContain("vcodec=png");
  });

  it("maps a bad frame (negative) to a typed ReadError before spawning", async () => {
    const spawn = installSpawn({});
    const outcome = await stillTool("/abs/in.mlt", -1, "/abs/o.png");
    expect(isReadError(outcome)).toBe(true);
    if (!isReadError(outcome)) return;
    expect(outcome.kind).toBe("still");
    expect(outcome.detail).toMatch(/non-negative integer/);
    // The driver guards the frame BEFORE spawning — no melt call on a bad frame.
    expect(spawn).not.toHaveBeenCalled();
  });

  it("maps a nonzero melt exit to a typed ReadError", async () => {
    installSpawn({ code: 2, stderr: "no such frame" });
    const outcome = await stillTool("/abs/in.mlt", 9999, "/abs/o.png");
    expect(isReadError(outcome)).toBe(true);
    if (!isReadError(outcome)) return;
    expect(outcome.kind).toBe("still");
  });
});
