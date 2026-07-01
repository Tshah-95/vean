#!/usr/bin/env bun
// verify:live-overlay — the DRIVE-ABLE acceptance gate for the LIVE Remotion
// `<Player>` overlay path (DESIGN-LIVE-PREVIEW §4 / §6 Tier 1 / §9 step 4).
//
//   bun run verify:live-overlay
//
// WHAT IT PROVES (the gap the committed fixtures left open)
//   demo.mlt proves the FOOTAGE-composite overlay path (a baked video file the WebGL
//   compositor decodes). NO committed timeline exercised the OTHER path — a real
//   GRAPHIC clip (`isGraphicClip` true) routed to the live `@remotion/player`. This
//   gate boots `corpus/demo/graphic-overlay.mlt` (footage cross-fade base + a
//   `cache/remotion/` graphic clip via qtblend) in a HEADLESS browser via the `drive`
//   harness (`scripts/drive.ts` + `agent-browser`, the same loopback URL the Mac app's
//   WKWebView renders) and asserts, end-to-end:
//     (a) App `resolveOverlayAt` returns present:true → the `OverlayPlayer` MOUNTS
//         (the `window.__veanOverlay` bridge exists only because it did);
//     (b) the `@remotion/player` is SLAVED to the master clock — seek the clock and
//         the Player's frame follows (`playerFrame === masterFrame`);
//     (c) the footage compositor SKIPS the graphic track — `resolveLayers` (read live
//         via `window.__veanLayers`) returns the base layer at trackIndex 0 and
//         EXCLUDES the graphic track index 1 (overlayTrackIndices' graphic-skip
//         branch, exercised against a real running app, not just the unit test);
//     (d) the composite shows the LIVE Remotion overlay over the footage — the
//         `LowerThird` composition rendered into the DOM (its subtitle text present),
//         captured in a screenshot.
//
//   The unit test `tests/resolve-layers.test.ts` ("EXCLUDES … GRAPHIC clip") pins the
//   PURE logic; this gate proves the actual `<Player>` render + clock-slaving + skip
//   end-to-end, which no pure test can. Headless (never opens a window — the repo's
//   `agent-browser.json` enforces it and we also pass `--headed false`).
//
// PREREQS: `agent-browser` on PATH (brew install agent-browser) + a `bun install`'d
//   viewer (`bun run viewer:install`). NO `melt`/`ffmpeg`/Remotion render needed: the
//   live `<Player>` renders `LowerThird` from the viewer's Vite alias, not from a file.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DRIVE = join(ROOT, "scripts", "drive.ts");
const FIXTURE_ROUTE = "corpus/demo/graphic-overlay.mlt";
const SESSION = "veanliveoverlay"; // a dedicated session so we never collide with a manual `drive`
const SHOT = join(process.env.TMPDIR ?? "/tmp", "verify-live-overlay.png");
// The overlay duration the fixture authors (90-frame lower-third); the gate seeks
// HERE to prove the Player follows the clock to a non-zero frame inside the overlay.
const SEEK_TO = 30;

const failures: string[] = [];
const pass = (msg: string) => console.log(`ok    ${msg}`);
const fail = (msg: string) => {
  failures.push(msg);
  console.log(`FAIL  ${msg}`);
};

/** Run a drive subcommand, return trimmed stdout. */
function drive(args: string[]): string {
  return execFileSync("bun", [DRIVE, ...args], { cwd: ROOT, encoding: "utf8" }).trim();
}

/** Run an agent-browser command against our session (headless, always). Returns
 *  stdout. `allowFail` swallows a non-zero exit (e.g. a `wait` timeout) and returns
 *  the captured stdout instead of throwing. */
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

/** Eval JS in the page and return the result value. Uses base64 transport (the
 *  agent-browser-recommended escaping-proof path) + `--json`, then unwraps the
 *  `{success,data:{result},error}` envelope. */
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

/** Wait until a JS expression is truthy. Returns true if it became truthy within the
 *  timeout, false on timeout (never throws — the caller turns it into a gate fail). */
function abWaitFn(expr: string, timeoutMs = 15000): boolean {
  const out = ab(["wait", "--fn", expr, "--timeout", String(timeoutMs)], true);
  // A timeout exits non-zero (swallowed by allowFail → empty/!ok stdout); a success
  // prints `true`. Re-evaluate to be certain rather than trust the wait's stdout.
  try {
    return abEval(`!!(${expr})`) === true;
  } catch {
    return /\btrue\b/.test(out);
  }
}

type Layer = { kind: string; trackIndex: number; color?: string; uuid?: string };

async function main(): Promise<void> {
  if (!existsSync(join(ROOT, "viewer", "node_modules"))) {
    console.error("FAIL  viewer is not installed — run `bun run viewer:install` first.");
    process.exit(1);
  }

  // 0) Build the viewer so dist carries the current source (the bridges this gate
  //    reads). vite build is a few seconds; the gate serves viewer/dist (production),
  //    the exact bytes the Mac app's WKWebView loads.
  console.log("→ building viewer (vite build) …");
  execFileSync("bun", ["run", "viewer:build"], { cwd: ROOT, encoding: "utf8", stdio: "inherit" });

  let url = "";
  try {
    // 1) Bring up a driveable preview on the fixture (free port, health-gated).
    console.log(`→ drive up on ${FIXTURE_ROUTE} …`);
    url = drive(["up", "--project", ROOT, "--timeline", FIXTURE_ROUTE, "--name", SESSION])
      .split("\n")
      .filter(Boolean)
      .pop() as string;
    if (!url?.startsWith("http")) throw new Error(`drive up did not return a URL (got: ${url})`);

    // 2) Open the real UI headless and wait for the app + the footage stage to mount.
    ab(["open", url]);
    if (!abWaitFn("window.__veanLayers !== undefined")) {
      fail("viewer never loaded (window.__veanLayers absent after 15s) — app boot failed");
      return;
    }

    // ── (a) resolveOverlayAt present:true → the OverlayPlayer mounted ──────────────
    // The `__veanOverlay` bridge is installed by OverlayPlayer, which App renders
    // ONLY when resolveOverlayAt found a graphic clip. Its presence IS the assertion.
    if (!abWaitFn("window.__veanOverlay !== undefined", 8000)) {
      fail(
        "(a) OverlayPlayer did NOT mount — resolveOverlayAt returned present:false for a graphic-clip fixture",
      );
      // Without the Player, (b) and (d) are moot; still check (c) below.
    } else {
      const ov = abEval("window.__veanOverlay()") as {
        present: boolean;
        durationInFrames: number;
        playerFrame: number | null;
        masterFrame: number;
      };
      if (ov.present === true && ov.durationInFrames === 90) {
        pass(
          `(a) resolveOverlayAt present:true → OverlayPlayer mounted (durationInFrames=${ov.durationInFrames})`,
        );
      } else {
        fail(
          `(a) overlay snapshot unexpected: ${JSON.stringify(ov)} (expected present:true, duration 90)`,
        );
      }

      // ── (b) the Player is SLAVED to the master clock ──────────────────────────
      // Seek the master clock by dispatching the app's own ArrowRight handler, then
      // assert the Player's frame followed (playerFrame === masterFrame, non-zero).
      abEval(
        `for (let i = 0; i < ${SEEK_TO}; i++) { window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight" })); } window.__veanOverlay().masterFrame`,
      );
      const tracked = abWaitFn(
        "window.__veanOverlay().playerFrame === window.__veanOverlay().masterFrame && window.__veanOverlay().masterFrame > 0",
      );
      const after = abEval("window.__veanOverlay()") as {
        playerFrame: number | null;
        masterFrame: number;
      };
      if (tracked && after.masterFrame > 0 && after.playerFrame === after.masterFrame) {
        pass(
          `(b) @remotion/player slaved to the master clock (seek → playerFrame=${after.playerFrame} === masterFrame=${after.masterFrame})`,
        );
      } else {
        fail(
          `(b) Player did NOT follow the master clock after seek: ${JSON.stringify(after)} (expected playerFrame === masterFrame > 0)`,
        );
      }

      // ── (d) the LIVE Remotion overlay rendered over the footage ───────────────
      // The LowerThird composition draws its subtitle ("video editor, agent native")
      // into the DOM — present iff the `<Player>` actually rendered the composition.
      const overlayRendered = abEval(
        `document.body.innerText.includes("video editor, agent native")`,
      );
      if (overlayRendered === true) {
        pass(
          "(d) live LowerThird composition rendered by the Player (subtitle present in the DOM)",
        );
      } else {
        fail("(d) LowerThird composition did NOT render — the Player did not draw the overlay");
      }
    }

    // ── (c) the footage compositor SKIPS the graphic track ──────────────────────
    // Read the live resolved z-stack (the SAME resolveLayers the compositor draws).
    // At any frame inside the overlay span it must contain the base (trackIndex 0)
    // and EXCLUDE the graphic track (trackIndex 1) — the @remotion/player owns it.
    let skipOk = true;
    for (const frame of [20, 45]) {
      const layers = abEval(`window.__veanLayers(${frame})`) as Layer[];
      const hasBase = layers.some((l) => l.trackIndex === 0);
      const hasGraphic = layers.some((l) => l.trackIndex === 1);
      if (!hasBase || hasGraphic) {
        skipOk = false;
        fail(
          `(c) frame ${frame}: resolveLayers did not skip the graphic track — layers=${JSON.stringify(layers)} (expected a trackIndex-0 base and NO trackIndex-1 graphic)`,
        );
      }
    }
    if (skipOk) {
      pass(
        "(c) footage compositor excludes the graphic track (resolveLayers skips trackIndex 1, keeps base)",
      );
    }

    // Visual proof (eyes, per the `drive` skill): footage base + live overlay on top.
    ab(["screenshot", SHOT]);
    console.log(`  screenshot: ${SHOT}`);
  } finally {
    // ALWAYS tear down — never leak a browser session or a preview sidecar.
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
      "OVERALL: PASS — the live @remotion/player overlay mounts, slaves to the clock, and " +
        "composites over footage while the footage compositor skips the graphic track.",
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
