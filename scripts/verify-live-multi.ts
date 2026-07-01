#!/usr/bin/env bun
// verify:live-multi — the DRIVE-ABLE acceptance gate for P1 of live-comp-preview:
// PLAYHEAD-AWARE overlay resolution. A timeline with several graphic clips naming
// DIFFERENT comps must preview the RIGHT one as the playhead moves, and each comp must
// play from its OWN frame 0 (offset by the clip's timeline start), only during its span.
//
//   bun run verify:live-multi      (prereqs: agent-browser on PATH + viewer installed)
//
// Boots `corpus/demo/multi-overlay.mlt` (Title over frames 0–44, LowerThird over 45–89)
// on the DEV viewer and asserts, via the `__veanOverlay()` bridge:
//   (a) at frame 20 the ACTIVE comp is "Title", present, playerFrame == 20 (startFrame 0);
//   (b) at frame 60 the ACTIVE comp SWITCHED to "LowerThird", present, and the comp frame
//       is OFFSET — playerFrame == 15 (== masterFrame 60 − clip startFrame 45);
//   (c) the DOM text switches accordingly (Title's kicker at 20 → LowerThird's subtitle
//       at 60), proving the live Player actually rendered each comp, not just the bridge.
// Headless (--headed false).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DRIVE = join(ROOT, "scripts", "drive.ts");
const FIXTURE_ROUTE = "corpus/demo/multi-overlay.mlt";
const SESSION = "veanlivemulti";

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

/** Seek the master clock to an absolute frame by stepping (ArrowRight/Left) from the
 *  current frame, then wait until the bridge reports that frame. */
function seekTo(target: number): void {
  const cur = (abEval("window.__veanOverlay().masterFrame") as number) ?? 0;
  const delta = target - cur;
  const code = delta >= 0 ? "ArrowRight" : "ArrowLeft";
  abEval(
    `for (let i = 0; i < ${Math.abs(delta)}; i++) { window.dispatchEvent(new KeyboardEvent("keydown", { code: "${code}" })); } window.__veanOverlay().masterFrame`,
  );
  abWaitFn(`window.__veanOverlay().masterFrame === ${target}`, 5000);
}

type Ov = {
  present: boolean;
  compositionId: string;
  startFrame: number;
  playerFrame: number | null;
  masterFrame: number;
};

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
    if (!abWaitFn("window.__veanOverlay !== undefined", 30000)) {
      fail("viewer never mounted the overlay layer — cannot test playhead-aware overlays");
      return;
    }

    // ── (a) frame 20 → Title, offset 0 ──────────────────────────────────────────
    seekTo(20);
    const at20 = abEval("window.__veanOverlay()") as Ov;
    if (at20.present && at20.compositionId === "Title" && at20.playerFrame === 20) {
      pass(
        `(a) frame 20 → active comp "Title", present, playerFrame=20 (startFrame ${at20.startFrame})`,
      );
    } else {
      fail(
        `(a) frame 20 unexpected: ${JSON.stringify(at20)} (expected Title, present, playerFrame 20)`,
      );
    }
    const titleText = abEval(
      `document.body.innerText.toLowerCase().includes("agent-native title card")`,
    );
    if (titleText === true) pass("(c) frame 20 → Title comp rendered (its kicker text in the DOM)");
    else fail("(c) frame 20 → Title text not in the DOM (Player did not render Title)");

    // ── (b) frame 60 → LowerThird, offset 45 (comp frame 15) ────────────────────
    seekTo(60);
    const at60 = abEval("window.__veanOverlay()") as Ov;
    if (
      at60.present &&
      at60.compositionId === "LowerThird" &&
      at60.startFrame === 45 &&
      at60.playerFrame === 15
    ) {
      pass(
        `(b) frame 60 → active comp SWITCHED to "LowerThird", comp frame OFFSET to ${at60.playerFrame} (60 − startFrame 45)`,
      );
    } else {
      fail(
        `(b) frame 60 unexpected: ${JSON.stringify(at60)} (expected LowerThird, startFrame 45, playerFrame 15)`,
      );
    }
    const ltText = abEval(
      `document.body.innerText.toLowerCase().includes("video editor, agent native")`,
    );
    if (ltText === true)
      pass("(c) frame 60 → LowerThird comp rendered (its subtitle text in the DOM)");
    else
      fail("(c) frame 60 → LowerThird text not in the DOM (Player did not switch to LowerThird)");
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
      "OVERALL: PASS — the live overlay follows the playhead: the right comp shows for each span, offset to its own frame 0.",
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
