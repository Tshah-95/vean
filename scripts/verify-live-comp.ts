#!/usr/bin/env bun
// verify:live-comp — the DRIVE-ABLE acceptance gate for P0 of the live-comp-preview
// path: the viewer's composition registry is now DYNAMIC (a Vite glob of
// `remotion/src/compositions/`), so a graphic clip that names a NON-default comp
// resolves + renders live WITHOUT any edit to `viewer/src/remotion/registry.ts`.
//
//   bun run verify:live-comp        (prereqs: agent-browser on PATH + viewer installed)
//
// WHAT IT PROVES (beyond verify:live-overlay, which only exercises the DEFAULT comp):
//   Boots `corpus/demo/title-overlay.mlt` — identical to graphic-overlay.mlt but its
//   graphic clip names composition "Title" (a comp added purely by dropping
//   `remotion/src/compositions/Title.tsx` into the dir) — in a HEADLESS browser via the
//   `drive` harness, and asserts:
//     (a) the OverlayPlayer mounted (deriveOverlay found the graphic clip);
//     (b) the DYNAMIC registry discovered BOTH comps from the glob —
//         `window.__veanCompositions()` includes "LowerThird" AND "Title" — with no
//         registration edit (the P0 unlock);
//     (c) the live Player resolved + rendered "Title" — `__veanOverlay().compositionId
//         === "Title"` (not the old hardcoded/default LowerThird), and Title's text is
//         in the DOM;
//     (d) the Player is SLAVED to the master clock (seek → playerFrame === masterFrame).
//
// Headless (never opens a window — agent-browser.json enforces it; we also pass
// `--headed false`). NO melt/ffmpeg/Remotion render needed: the live `<Player>` renders
// Title from the viewer's Vite alias, not from a file.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DRIVE = join(ROOT, "scripts", "drive.ts");
const FIXTURE_ROUTE = "corpus/demo/title-overlay.mlt";
const SESSION = "veanlivecomp";
const SHOT = join(process.env.TMPDIR ?? "/tmp", "verify-live-comp.png");
const SEEK_TO = 30;

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

  console.log("→ building viewer (vite build) …");
  execFileSync("bun", ["run", "viewer:build"], { cwd: ROOT, encoding: "utf8", stdio: "inherit" });

  let url = "";
  try {
    console.log(`→ drive up on ${FIXTURE_ROUTE} …`);
    url = drive(["up", "--project", ROOT, "--timeline", FIXTURE_ROUTE, "--name", SESSION])
      .split("\n")
      .filter(Boolean)
      .pop() as string;
    if (!url?.startsWith("http")) throw new Error(`drive up did not return a URL (got: ${url})`);

    ab(["open", url]);
    if (!abWaitFn("window.__veanLayers !== undefined")) {
      fail("viewer never loaded (window.__veanLayers absent after 15s) — app boot failed");
      return;
    }

    // ── (b) the dynamic registry discovered BOTH comps from the glob ────────────
    if (!abWaitFn("window.__veanCompositions !== undefined", 8000)) {
      fail("(b) __veanCompositions bridge absent — the dynamic registry did not install");
    } else {
      const ids = abEval("window.__veanCompositions()") as string[];
      if (Array.isArray(ids) && ids.includes("LowerThird") && ids.includes("Title")) {
        pass(
          `(b) dynamic registry discovered comps from the glob: [${ids.join(", ")}] — no registry edit`,
        );
      } else {
        fail(
          `(b) glob did not discover both comps (got ${JSON.stringify(ids)}, expected LowerThird + Title)`,
        );
      }
    }

    // ── (a) the OverlayPlayer mounted for the graphic clip ──────────────────────
    if (!abWaitFn("window.__veanOverlay !== undefined", 8000)) {
      fail(
        "(a) OverlayPlayer did NOT mount — deriveOverlay returned present:false for the graphic-clip fixture",
      );
    } else {
      const ov = abEval("window.__veanOverlay()") as {
        present: boolean;
        durationInFrames: number;
        compositionId: string;
      };
      if (ov.present === true && ov.durationInFrames === 90) {
        pass(`(a) OverlayPlayer mounted (durationInFrames=${ov.durationInFrames})`);
      } else {
        fail(`(a) overlay snapshot unexpected: ${JSON.stringify(ov)}`);
      }

      // ── (c) the live Player resolved + rendered the NON-default "Title" comp ───
      if (ov.compositionId === "Title") {
        pass(
          '(c) live Player resolved the dynamic comp — __veanOverlay().compositionId === "Title"',
        );
      } else {
        fail(
          `(c) Player resolved the WRONG comp: compositionId=${JSON.stringify(ov.compositionId)} (expected "Title")`,
        );
      }
      const titleText = abEval(
        `document.body.innerText.toLowerCase().includes("agent-native title card")`,
      );
      if (titleText === true) {
        pass("(c) Title composition rendered by the Player (its kicker text present in the DOM)");
      } else {
        fail(
          "(c) Title composition did NOT render its text — the Player did not draw the Title comp",
        );
      }

      // ── (d) the Player is SLAVED to the master clock ──────────────────────────
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
          `(d) @remotion/player slaved to the master clock (seek → playerFrame=${after.playerFrame} === masterFrame=${after.masterFrame})`,
        );
      } else {
        fail(`(d) Player did NOT follow the master clock after seek: ${JSON.stringify(after)}`);
      }
    }

    ab(["screenshot", SHOT]);
    console.log(`  screenshot: ${SHOT}`);
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
      "OVERALL: PASS — a non-default composition (Title), added by only dropping its file, was " +
        "discovered by the glob, resolved by the dynamic registry, and rendered live over footage.",
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
