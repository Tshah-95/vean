// Stable JSON tests for the Move-5 Phase-B preview.serve action.
//
// Two layers:
//   1. Registry shape (in-process, DB-free): effect metadata, scopes, CLI
//      projection, and presence in the discovery manifest. The action registry
//      imports its state/DB deps LAZILY (inside execute), so importing it for
//      describeAction/getAction never pulls in `bun:sqlite`.
//   2. The HTTP read endpoints, exercised by spawning `bun
//      scripts/preview-serve-probe.ts` (the server + `bun:sqlite` only resolve
//      under Bun, not the Node/Vitest process) and asserting on its JSON line.
//
// The proxy-render endpoint (which drives melt) is exercised only in the real
// Phase-C gate, never in vitest (frame rendering is never in vitest).
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeAction, getAction, listActions } from "../src/actions";

const repo = join(import.meta.dirname, "..");

describe("preview.serve registry shape", () => {
  it("registers preview.serve as a process-only execute, CLI command `preview`", () => {
    const action = getAction("preview.serve");
    if (!action) throw new Error("preview.serve action missing");
    const d = describeAction(action);
    expect(d.effect.kind).toBe("execute");
    expect(d.effect.mutates).toEqual(["process"]);
    // It must NOT mutate the timeline document or the project filesystem.
    expect(d.effect.mutates).not.toContain("timeline");
    expect(d.effect.mutates).not.toContain("projectState");
    expect(d.effect.openWorld).toBe(false);
    expect(d.effect.destructive).toBe(false);
    expect(d.effect.job).toMatchObject({ mode: "inline", cancellable: true, retrySafe: false });
    expect(d.surfaces.cli).toEqual({ command: "preview" });
    expect(action.scopes).toEqual(
      expect.arrayContaining(["state:read", "timeline:read", "render:execute", "process:execute"]),
    );
    expect(d.mcpAnnotations.readOnlyHint).toBe(false);
  });

  it("keeps preview.serve projectable to its CLI command", () => {
    const action = listActions().find((a) => a.id === "preview.serve");
    expect(action).toBeTruthy();
    expect(action?.surfaces.cli).toEqual({ command: "preview" });
  });

  it("defaults dev to true — the live HMR viewer; only --prod / explicit dev:false serves dist", () => {
    const action = getAction("preview.serve");
    if (!action) throw new Error("preview.serve action missing");
    // The default-applied input: an empty call resolves dev → true (live viewer).
    // (getAction erases the input generic to `unknown`, so narrow the parsed shape.)
    const parse = (raw: unknown) => action.input.parse(raw) as { dev: boolean };
    expect(parse({}).dev).toBe(true);
    // The opt-out is explicit (CLI `--prod` → dev:false → the viewer/dist snapshot).
    expect(parse({ dev: false }).dev).toBe(false);
  });
});

describe("preview server read endpoints (via bun probe)", () => {
  it("serves health/timeline/timelines/diagnostics over 127.0.0.1 with well-shaped JSON", () => {
    const probe = join(repo, "scripts", "preview-serve-probe.ts");
    const result = spawnSync("bun", [probe], {
      cwd: repo,
      env: { ...process.env },
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`probe failed (${result.status}):\n${result.stderr}\n${result.stdout}`);
    }
    // The probe prints one JSON line (last non-empty line of stdout).
    const line = result.stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
    const out = JSON.parse(line);

    expect(out.ok).toBe(true);
    expect(out.isLocal).toBe(true);

    expect(out.health.status).toBe(200);
    expect(out.health.ok).toBe(true);

    expect(out.timeline.status).toBe(200);
    expect(out.timeline.ok).toBe(true);
    expect(out.timeline.fps).toEqual([30, 1]);
    expect(out.timeline.totalFrames).toBeGreaterThan(0);
    expect(out.timeline.videoTracks).toBeGreaterThanOrEqual(1);

    expect(out.timelines.status).toBe(200);
    expect(out.timelines.ok).toBe(true);
    expect(out.timelines.count).toBeGreaterThanOrEqual(1);

    expect(out.diagnostics.status).toBe(200);
    expect(out.diagnostics.ok).toBe(true);

    expect(out.badEndpointStatus).toBe(404);

    // Cross-origin isolation (DESIGN-LIVE-PREVIEW §8.5): the HTML document must
    // ship COOP `same-origin` + COEP `require-corp` (the precondition the browser
    // checks for `crossOriginIsolated`), and every response — including the API
    // subresources the isolated document loads under COEP — must be CORP-safe.
    expect(out.isolationHtml.coop).toBe("same-origin");
    expect(out.isolationHtml.coep).toBe("require-corp");
    expect(out.isolationHtml.corp).toBe("same-origin");
    expect(out.isolationApi.coop).toBe("same-origin");
    expect(out.isolationApi.coep).toBe("require-corp");
    expect(out.isolationApi.corp).toBe("same-origin");
    expect(out.mutationAuthority.bootstrapCookieHttpOnly).toBe(true);
    expect(out.mutationAuthority.unauthorizedStatus).toBe(403);
    expect(out.mutationAuthority.authorizedStatus).not.toBe(403);
  });
});
