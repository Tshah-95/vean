#!/usr/bin/env bun
// verify:live-hmr — the DRIVE-ABLE acceptance gate for P2 of live-comp-preview: the
// Studio-style LIVE-EDIT loop. Editing a composition's TSX must update the live
// preview WHILE the Player stays mounted and the master playhead is PRESERVED (a
// Fast-Refresh partial update, not a full page reload that resets the clock).
//
//   bun run verify:live-hmr        (prereqs: agent-browser on PATH + viewer installed)
//
// HOW: boots `corpus/demo/title-overlay.mlt` on the DEV viewer (Vite HMR — the drive
// default, NOT the dist snapshot), seeks the clock to a non-zero frame, then EDITS
// `remotion/src/compositions/Title.tsx` (swaps the kicker text for a unique probe
// token) and asserts:
//   (1) the probe text appears in the live overlay within the HMR window (the edit
//       reflected live — no manual rebuild/reload by the user);
//   (2) the master playhead is UNCHANGED (Fast Refresh preserved app state — the clock
//       did not reset to 0, which a full page reload would do);
//   (3) the OverlayPlayer stayed mounted (__veanOverlay still present).
// ALWAYS restores Title.tsx (try/finally), even on crash, so the working tree is clean.
//
// Headless (--headed false). No dist build — the whole point is the live dev viewer.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DRIVE = join(ROOT, "scripts", "drive.ts");
const TITLE_TSX = join(ROOT, "remotion", "src", "compositions", "Title.tsx");
const FIXTURE_ROUTE = "corpus/demo/title-overlay.mlt";
const SESSION = "veanlivehmr";
const ORIGINAL_KICKER = "the agent-native title card";
const PROBE = "hmr probe 7f3a2b"; // a unique token that cannot appear by chance
const SEEK_TO = 20;

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
  const env = JSON.parse(line) as { success?: boolean; data?: { result?: unknown }; error?: unknown };
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
  const originalSource = readFileSync(TITLE_TSX, "utf8");
  if (!originalSource.includes(ORIGINAL_KICKER)) {
    console.error(`FAIL  Title.tsx no longer contains the expected kicker "${ORIGINAL_KICKER}" — update the probe.`);
    process.exit(1);
  }

  let url = "";
  try {
    // DEV viewer (Vite HMR) — the drive default; NO --prod, NO dist build.
    console.log(`→ drive up (dev/HMR) on ${FIXTURE_ROUTE} …`);
    url = drive(["up", "--project", ROOT, "--timeline", FIXTURE_ROUTE, "--name", SESSION])
      .split("\n")
      .filter(Boolean)
      .pop() as string;
    if (!url?.startsWith("http")) throw new Error(`drive up did not return a URL (got: ${url})`);

    ab(["open", url]);
    if (!abWaitFn("window.__veanOverlay !== undefined", 30000)) {
      fail("viewer never mounted the overlay (dev Vite cold start may have failed) — cannot test HMR");
      return;
    }
    // Baseline: the Title comp is live with its ORIGINAL kicker, clock seeked to SEEK_TO.
    const baselineText = abEval(`document.body.innerText.toLowerCase().includes("${ORIGINAL_KICKER}")`);
    if (baselineText !== true) fail(`baseline: original kicker "${ORIGINAL_KICKER}" not in the live overlay before edit`);
    abEval(
      `for (let i = 0; i < ${SEEK_TO}; i++) { window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowRight" })); } window.__veanOverlay().masterFrame`,
    );
    abWaitFn(`window.__veanOverlay().masterFrame === ${SEEK_TO}`, 5000);
    const before = abEval("window.__veanOverlay()") as { masterFrame: number };

    // ── EDIT the comp's TSX (the live-authoring action) ─────────────────────────
    console.log("→ editing Title.tsx (kicker → probe token) …");
    writeFileSync(TITLE_TSX, originalSource.replaceAll(ORIGINAL_KICKER, PROBE));

    // (1) the edit reflects live within the HMR window.
    const reflected = abWaitFn(`document.body.innerText.toLowerCase().includes("${PROBE}")`, 15000);
    if (reflected) {
      pass("(1) comp edit reflected live in the overlay (HMR applied — no manual rebuild)");
    } else {
      fail("(1) comp edit did NOT reflect live — the registry/Player did not pick up the new comp code");
    }

    // (2) the master playhead is preserved (Fast Refresh, not a full reload).
    let after: { masterFrame: number } = { masterFrame: -1 };
    try {
      after = abEval("window.__veanOverlay()") as { masterFrame: number };
    } catch {
      // __veanOverlay gone ⇒ the app fully reloaded and re-init'd — the failure case.
    }
    if (after.masterFrame === before.masterFrame && before.masterFrame === SEEK_TO) {
      pass(`(2) master playhead preserved across HMR (frame ${after.masterFrame} held — Fast Refresh, not a reload)`);
    } else {
      fail(`(2) playhead NOT preserved: was ${before.masterFrame}, now ${after.masterFrame} (a full reload reset the clock — comps need Fast-Refresh-clean exports)`);
    }

    // (3) the OverlayPlayer stayed mounted.
    const stillMounted = abEval("window.__veanOverlay !== undefined") === true;
    if (stillMounted) pass("(3) OverlayPlayer stayed mounted across the edit");
    else fail("(3) OverlayPlayer unmounted across the edit");
  } finally {
    // ALWAYS restore the source (even on crash) so the working tree stays clean.
    writeFileSync(TITLE_TSX, originalSource);
    ab(["close"], true);
    try {
      drive(["down", "--name", SESSION]);
    } catch {
      /* best-effort */
    }
  }

  console.log("");
  if (failures.length === 0) {
    console.log("OVERALL: PASS — editing a composition's TSX updates the live preview with the playhead preserved (the Studio live-edit loop).");
    process.exit(0);
  }
  console.log(`OVERALL: FAIL — ${failures.length} defect(s).`);
  process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    // On an unexpected throw, make a best effort to restore the source too.
    try {
      const orig = process.env.__VEAN_HMR_ORIG;
      if (orig) writeFileSync(TITLE_TSX, orig);
    } catch {}
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
