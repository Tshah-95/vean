#!/usr/bin/env bun
// verify:live-error — the DRIVE-ABLE acceptance gate for P1b of live-comp-preview:
// RUNTIME fault isolation. A composition that throws DURING RENDER must NOT white-screen
// the editor, must NOT leave Remotion's ⚠️ glyph composited over the footage, and MUST
// publish the failure on `window.__veanOverlayError` so a gate/agent can see which comp
// failed and why. (The mechanism is the Player's own `errorFallback` prop → an
// OverlayErrorFallback that hides the overlay + sets the bridge — the Player's internal
// error boundary swallows the throw before any OUTER React boundary can see it.)
//
//   bun run verify:live-error      (prereqs: agent-browser on PATH + viewer installed)
//
// Boots `corpus/demo/boom-overlay.mlt` (one graphic clip naming composition "BoomProbe"
// with props {"boom":true} → it throws) on the DEV viewer and asserts:
//   (a) the editor SURVIVED — `window.__veanLayers` is defined and resolves a base layer
//       at frame 20 (footage/UI alive, not a white screen);
//   (b) `window.__veanOverlayError` is populated with compositionId "BoomProbe" (the
//       errorFallback fired — vean caught it, attributably);
//   (c) the overlay is HIDDEN — the overlay-player DOM does NOT show Remotion's ⚠️ glyph.
// Headless (--headed false).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DRIVE = join(ROOT, "scripts", "drive.ts");
const FIXTURE_ROUTE = "corpus/demo/boom-overlay.mlt";
const SESSION = "veanliveerror";

const failures: string[] = [];
const pass = (msg: string) => console.log(`ok    ${msg}`);
const fail = (msg: string) => {
  failures.push(msg);
  console.log(`FAIL  ${msg}`);
};

function drive(args: string[]): string {
  return execFileSync("bun", [DRIVE, ...args], { cwd: ROOT, encoding: "utf8" }).trim();
}
function ab(args: string[], allowFail = false): string {
  try {
    return execFileSync("agent-browser", ["--headed", "false", "--session", SESSION, ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
  } catch (error) {
    if (allowFail) return String((error as { stdout?: string })?.stdout ?? "");
    throw error;
  }
}
function abEval(js: string): unknown {
  const b64 = Buffer.from(js, "utf8").toString("base64");
  const out = ab(["eval", "-b", b64, "--json"]);
  const line = out.trim().split("\n").filter(Boolean).pop() ?? "{}";
  const env = JSON.parse(line) as {
    success?: boolean;
    data?: { result?: unknown };
    error?: unknown;
  };
  if (!env.success) throw new Error(`eval failed: ${JSON.stringify(env.error)}`);
  return env.data?.result;
}
function abWaitFn(expr: string, timeoutMs = 15000): boolean {
  const out = ab(["wait", "--fn", expr, "--timeout", String(timeoutMs)], true);
  try {
    return abEval(`!!(${expr})`) === true;
  } catch {
    return /\btrue\b/.test(out);
  }
}

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, "viewer", "node_modules"))) {
    console.error("FAIL  viewer is not installed — run `bun run viewer:install` first.");
    process.exit(1);
  }

  let url = "";
  try {
    console.log(`→ drive up (dev) on ${FIXTURE_ROUTE} …`);
    url = drive(["up", "--project", ROOT, "--timeline", FIXTURE_ROUTE, "--name", SESSION])
      .split("\n")
      .filter(Boolean)
      .pop() as string;
    if (!url?.startsWith("http")) throw new Error(`drive up did not return a URL (got: ${url})`);

    ab(["open", url]);

    // ── (a) the editor SURVIVED the throwing comp (no white-screen) ─────────────
    if (!abWaitFn("window.__veanLayers !== undefined", 30000)) {
      fail(
        "(a) the editor WHITE-SCREENED — window.__veanLayers absent; a throwing comp crashed the app",
      );
      return;
    }
    const base = abEval("window.__veanLayers(20)") as Array<{ trackIndex: number }>;
    if (Array.isArray(base) && base.some((l) => l.trackIndex === 0)) {
      pass(
        "(a) editor survived the throwing comp — footage compositor alive (base layer resolves at frame 20)",
      );
    } else {
      fail(`(a) footage compositor not alive after the throw: layers=${JSON.stringify(base)}`);
    }

    // ── (b) window.__veanOverlayError populated with the failing comp ───────────
    const caught = abWaitFn(
      `window.__veanOverlayError && window.__veanOverlayError.compositionId === "BoomProbe"`,
      10000,
    );
    if (caught) {
      const err = abEval("window.__veanOverlayError") as { compositionId: string; message: string };
      pass(
        `(b) vean caught the render throw — __veanOverlayError = { comp: "${err.compositionId}", msg: "${err.message}" }`,
      );
    } else {
      fail(
        "(b) __veanOverlayError NOT populated — the errorFallback did not fire (fault isolation inert)",
      );
    }

    // ── (c) the overlay is HIDDEN — no Remotion ⚠️ glyph over the footage ────────
    const glyph = abEval(
      `(document.querySelector('[data-testid=overlay-player]')?.innerText ?? "").includes("⚠")`,
    );
    if (glyph === false) {
      pass(
        "(c) overlay hidden — no ⚠️ glyph composited over the footage (errorFallback rendered nothing)",
      );
    } else {
      fail(
        "(c) Remotion's ⚠️ glyph is showing over the footage — the errorFallback did not hide the overlay",
      );
    }
  } finally {
    ab(["close"], true);
    try {
      drive(["down", "--name", SESSION]);
    } catch {
      /* best-effort */
    }
  }

  console.log("");
  if (failures.length === 0) {
    console.log(
      "OVERALL: PASS — a composition that throws at render is isolated: the editor survives, the overlay hides, and the failure is attributable on the bridge.",
    );
    process.exit(0);
  }
  console.log(`OVERALL: FAIL — ${failures.length} defect(s).`);
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
