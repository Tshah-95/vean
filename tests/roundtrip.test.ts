import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatRoundtrip, lineDiff, roundtripXml } from "../scripts/roundtrip";
import { parseSsimAll, ssimPng } from "../scripts/verify-corpus";
import {
  VERTICAL,
  audioTrack,
  clip,
  colorClip,
  fromMlt,
  resetIds,
  timeline,
  toMlt,
  videoTrack,
} from "../src/index";

// The round-trip harness + corpus gate are the Move-0 verification surface. Their
// PURE pieces — the line diff that localizes a divergence, and the SSIM-output
// parser that turns ffmpeg chatter into a number — are golden format contracts (a
// render gate that mis-reads its own metric is worse than no gate). The wiring
// (roundtripXml) is tested end-to-end against the now-live parse + serialize: a
// vean-EMITTED file must round-trip BYTE-IDENTICALLY (the strong contract), and a
// hand-authored file must reach a stable NORMALIZED fixpoint (the semantic one).

// ─── lineDiff (golden: the divergence-localizing format) ────────────────────
describe("lineDiff", () => {
  it("is empty for identical input", () => {
    expect(lineDiff("a\nb\nc", "a\nb\nc")).toBe("");
  });

  it("localizes the first divergence with context (golden)", () => {
    const a = "l1\nl2\nl3\nl4\nl5";
    const b = "l1\nl2\nXX\nl4\nl5";
    expect(lineDiff(a, b, 1)).toBe(
      ["@@ lines 2–4 (first divergence at line 3) @@", "  l2", "- l3", "+ XX", "  l4"].join("\n"),
    );
  });

  it("marks added trailing lines", () => {
    const out = lineDiff("a\nb", "a\nb\nc", 1);
    expect(out).toContain("first divergence at line 3");
    expect(out).toContain("+ c");
  });

  it("marks removed trailing lines", () => {
    const out = lineDiff("a\nb\nc", "a\nb", 1);
    expect(out).toContain("- c");
  });
});

// ─── parseSsimAll (golden: the ffmpeg SSIM-output contract) ─────────────────
describe("parseSsimAll", () => {
  it("extracts the All: channel-average score (golden line)", () => {
    const line =
      "[Parsed_ssim_0 @ 0xabc] SSIM R:1.000000 (inf) G:1.000000 (inf) B:1.000000 (inf) All:1.000000 (inf)";
    expect(parseSsimAll(line)).toBe(1);
  });

  it("reads a partial-match score", () => {
    const line =
      "[Parsed_ssim_0 @ 0x0] SSIM R:0.000002 (0.000007) G:1.000000 (inf) B:0.000002 (0.000007) All:0.333334 (1.760919)";
    expect(parseSsimAll(line)).toBeCloseTo(0.333334, 6);
  });

  it("finds the score amid surrounding ffmpeg chatter", () => {
    const blob = [
      "ffmpeg version 7.x",
      "  Stream #0:0 (png) -> ssim",
      "[Parsed_ssim_0 @ 0x1] SSIM R:0.99 (20) G:0.99 (20) B:0.99 (20) All:0.987654 (19.1)",
      "video:0kB",
    ].join("\n");
    expect(parseSsimAll(blob)).toBeCloseTo(0.987654, 6);
  });

  it("throws (does NOT silently pass) when no All: token is present", () => {
    expect(() => parseSsimAll("ffmpeg: some error, no ssim line")).toThrow(/no 'All:' score/);
  });
});

// ─── ssimPng (integration: needs ffmpeg) ────────────────────────────────────
function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(hasFfmpeg())("ssimPng (ffmpeg)", () => {
  const dir = mkdtempSync(join(tmpdir(), "vean-ssim-"));
  const red = join(dir, "red.png");
  const red2 = join(dir, "red2.png");
  const blue = join(dir, "blue.png");
  const gen = (out: string, color: string) =>
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=64x64:d=1`,
      "-frames:v",
      "1",
      // -update 1: write a single image to a fixed filename without the image2
      // muxer's "does not contain an image sequence pattern" warning (matches the
      // hardening on the production still path in src/driver/melt.ts).
      "-update",
      "1",
      out,
    ]);
  gen(red, "red");
  gen(red2, "red");
  gen(blue, "blue");

  it("scores identical frames at 1.0", () => {
    expect(ssimPng(red, red2)).toBeCloseTo(1, 5);
  });

  it("scores wholly-different frames well below threshold", () => {
    expect(ssimPng(red, blue)).toBeLessThan(0.9);
  });
});

// ─── roundtripXml (end-to-end against the live parse + serialize) ───────────
/** A vean-EMITTED document: the strong byte-identity contract applies to these.
 *  Kept to a fade + a plain media clip (NO same-track dissolve): the dissolve's
 *  nested-tractor tail-cut currently loses its source `length` on parse→serialize
 *  — a genuine round-trip defect, but in the parse/serialize modules, not this
 *  harness. The harness CORRECTLY reports that as fixpoint-but-not-byte-identical;
 *  pinning my golden to a clean fixture tests my branch without proxying that bug. */
function veanEmitted(): string {
  resetIds();
  return toMlt(
    timeline(VERTICAL, {
      video: [videoTrack(colorClip(45, "black", { fadeIn: 12 }), clip("/a.mp4", { dur: 60 }))],
    }),
  );
}

/** A minimal HAND-authored .mlt (terse spelling Shotcut/vean normalize): the
 *  background producer, uuids, and shotcut hints are ADDED on emit, so this is NOT
 *  byte-identical — but it must reach a stable fixpoint. */
const HAND_MLT = `<?xml version="1.0" encoding="utf-8"?>
<mlt LC_NUMERIC="C" version="7.0.0" root="" title="vean timeline">
  <profile description="vertical-1080x1920-30" width="1080" height="1920"
    frame_rate_num="30" frame_rate_den="1" progressive="1"
    sample_aspect_num="1" sample_aspect_den="1"
    display_aspect_num="9" display_aspect_den="16" colorspace="709"/>
  <producer id="producer0" in="0" out="44">
    <property name="mlt_service">color</property>
    <property name="resource">#FF000000</property>
    <property name="length">45</property>
  </producer>
  <playlist id="playlist0">
    <entry producer="producer0" in="0" out="44"/>
  </playlist>
  <tractor id="tractor0" shotcut="1">
    <track producer="playlist0"/>
  </tractor>
</mlt>`;

describe("roundtripXml (end-to-end)", () => {
  it("round-trips a vean-EMITTED file byte-identically (the strong contract)", () => {
    const r = roundtripXml(veanEmitted());
    expect(r.pass).toBe(true);
    expect(r.byteIdentical).toBe(true);
    expect(r.diff).toBe("");
    expect(formatRoundtrip("emitted", r)).toBe("PASS  emitted  —  byte-identical (loss-free)");
  });

  it("re-emitting a vean-emitted file is itself byte-identical (idempotent serialize)", () => {
    const x = veanEmitted();
    expect(roundtripXml(x).emitted).toBe(x);
  });

  it("reaches a stable NORMALIZED fixpoint for a hand-authored file", () => {
    const r = roundtripXml(HAND_MLT);
    expect(r.pass).toBe(true); // emitted === reEmitted (a fixpoint)
    expect(r.emitted).toBe(r.reEmitted);
    // Not byte-identical: emit adds the background track / uuids / shotcut hints.
    expect(r.byteIdentical).toBe(false);
    expect(formatRoundtrip("hand", r)).toMatch(/^PASS.*fixpoint stable/);
  });
});

// Clip identity (`Clip.id`) is now routed through `shotcut:uuid` (Move 1b, per
// DESIGN-MOVE1.md §1), so authored ids survive a serialize→parse reload — they are
// no longer renamed to the ephemeral `producer${N}` XML ref targets. This is what
// lets a session reload from disk mid-edit and keep targeting clips by their
// stable uuids (and what makes the corpus CLI tests address `clip-1`, not
// `producer3`).
describe("clip identity survives the round-trip (shotcut:uuid routing)", () => {
  function authored() {
    resetIds();
    return timeline(VERTICAL, {
      video: [
        videoTrack(
          colorClip(45, "black", { id: "intro", fadeIn: 12 }),
          colorClip(60, "gold", { id: "payoff", fadeOut: 15 }),
        ),
        videoTrack(clip("/abs/overlay.mp4", { id: "lower-third", in: 20, out: 79 })),
      ],
      audio: [audioTrack(clip("/abs/vo.wav", { id: "narration", dur: 90, gain: 0.8 }))],
    });
  }

  it("every authored clip id round-trips through fromMlt(toMlt(tl))", () => {
    const before = authored();
    const after = fromMlt(toMlt(before));
    const ids = (tl: ReturnType<typeof authored>) =>
      [...tl.tracks.video, ...tl.tracks.audio]
        .flatMap((t) => t.items)
        .filter((it) => it.kind === "clip")
        .map((it) => (it as { id: string }).id)
        .sort();
    expect(ids(after)).toEqual(["intro", "lower-third", "narration", "payoff"]);
    // And the ids are STABLE across the reload — not regenerated to producer${N}.
    expect(ids(after)).toEqual(ids(before));
  });

  it("an id with XML-special characters is escaped + recovered intact", () => {
    resetIds();
    const tricky = timeline(VERTICAL, {
      video: [videoTrack(colorClip(30, "red", { id: '{uuid-&-<weird>-"quote"}' }))],
    });
    const after = fromMlt(toMlt(tricky));
    const clipItem = after.tracks.video[0]?.items[0] as { id: string };
    expect(clipItem.id).toBe('{uuid-&-<weird>-"quote"}');
  });
});

// formatRoundtrip is pure over a RoundtripReport — testable without the stubs by
// constructing a report directly (locks the human-facing PASS/FAIL + mode line).
describe("formatRoundtrip (report rendering)", () => {
  it("renders a byte-identical PASS with no diff", () => {
    const out = formatRoundtrip("ex.mlt", {
      pass: true,
      byteIdentical: true,
      emitted: "<mlt/>",
      reEmitted: "<mlt/>",
      input: "<mlt/>",
      diff: "",
    });
    expect(out).toBe("PASS  ex.mlt  —  byte-identical (loss-free)");
  });

  it("renders a normalized (non-byte-identical) PASS with the diff", () => {
    const out = formatRoundtrip("ex.mlt", {
      pass: true,
      byteIdentical: false,
      emitted: "b",
      reEmitted: "b",
      input: "a",
      diff: "@@ lines 1–1 @@\n- a\n+ b",
    });
    expect(out).toMatch(/^PASS/);
    expect(out).toContain("fixpoint stable");
    expect(out).toContain("- a");
  });

  it("renders a FAIL with the emitted↔re-emitted diff", () => {
    const out = formatRoundtrip("ex.mlt", {
      pass: false,
      byteIdentical: false,
      emitted: "x",
      reEmitted: "y",
      input: "x",
      diff: "@@ lines 1–1 @@\n- x\n+ y",
    });
    expect(out).toMatch(/^FAIL/);
    expect(out).toContain("parser lost or mangled");
  });
});
