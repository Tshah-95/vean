// Focused unit tests for the TRIM + MOVE op family (Move 1a).
//
// The registry-driven harness (tests/op-invariants.test.ts) already proves the
// FIVE contract laws on every `samples` fixture (purity, inverse deep-equal undo,
// serialize Shotcut-clean, round-trip). This file pins the op-SPECIFIC mechanics
// the generic harness can't see:
//   • trimIn / trimOut — which neighbour blank grows/shrinks, the holding-blank
//     insertion when there is none, the fade-exceeds-window WARNING (not an
//     error), the escape-hatch keyframe-window re-base on a head trim, and the
//     typed EditErrors the …Valid guards return;
//   • move — non-ripple LIFT+OVERWRITE leaves the right blanks and preserves the
//     clip uuid, ripple REMOVE+INSERT closes the source gap and opens the dest,
//     a lossy overwrite is reported in `clipsRemoved`, and a written-out result
//     is Shotcut-clean (xmllint).
//
// Imports go straight to the op files + the IR builder (NOT the `../src/ops`
// registry barrel) so this suite is independent of sibling stubs still landing in
// parallel — it exercises trim/move directly, the same way ops-transitions does.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectDiagnostics } from "../src/diagnostics";
import {
  FADE_IN_SERVICE,
  FADE_OUT_SERVICE,
  blank,
  clip,
  colorClip,
  filter,
  resetIds,
  timeline,
  videoTrack,
} from "../src/ir/builder";
import { fromMlt } from "../src/ir/parse";
import { VERTICAL } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import type { Blank, Clip, Item, Timeline } from "../src/ir/types";
import { apply } from "../src/ops/index";
import { move } from "../src/ops/move";
import { split } from "../src/ops/split";
import { shiftAnimWindow, trimIn, trimOut } from "../src/ops/trim";
import { type EditError, type OpResult, isEditError } from "../src/ops/types";

// ─── helpers ──────────────────────────────────────────────────────────────────
function ok(r: OpResult | EditError): OpResult {
  if (isEditError(r)) throw new Error(`unexpected EditError: ${JSON.stringify(r)}`);
  return r;
}
function err(r: OpResult | EditError): EditError {
  if (!isEditError(r)) throw new Error("expected an EditError, got a successful OpResult");
  return r;
}
function vItems(tl: Timeline, i = 0): Item[] {
  return tl.tracks.video[i]?.items ?? [];
}
function asClip(it: Item | undefined): Clip {
  if (!it || it.kind !== "clip") throw new Error("expected a clip item");
  return it;
}
function asBlank(it: Item | undefined): Blank {
  if (!it || it.kind !== "blank") throw new Error("expected a blank item");
  return it;
}
function playtime(c: Clip): number {
  return c.out - c.in + 1;
}
function findClipIn(tl: Timeline, uuid: string): Clip {
  for (const t of [...tl.tracks.video, ...tl.tracks.audio]) {
    for (const it of t.items) if (it.kind === "clip" && it.id === uuid) return it;
  }
  throw new Error(`clip "${uuid}" not found`);
}
/** Write a state's XML to a temp file and assert xmllint (namespace-aware) is
 *  clean — the exact Shotcut-openability gate `scripts/lint-xml.ts` enforces. */
function assertXmllintClean(tl: Timeline, label: string): void {
  const dir = mkdtempSync(join(tmpdir(), "vean-trimmove-"));
  const path = join(dir, `${label}.mlt`);
  writeFileSync(path, toMlt(tl));
  const out = execFileSync("sh", ["-c", `xmllint --noout --nsclean '${path}' 2>&1 || true`], {
    encoding: "utf8",
  }).trim();
  expect(out, `xmllint diagnostics for ${label}`).toBe("");
}

// ═══════════════════════════════════════════════════════════════════════════
// trimIn / trimOut
// ═══════════════════════════════════════════════════════════════════════════

describe("trimIn — head resize + left-neighbour blank", () => {
  const tl = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [videoTrack(blank(20), clip("/abs/a.mp4", { id: "c", dur: 90 }))],
    });
  };

  it("delta>0 advances the in-point and GROWS the left blank by delta (start stays put)", () => {
    const r = ok(trimIn(tl(), { uuid: "c", delta: 15, rippleAllTracks: false }));
    const items = vItems(r.state);
    expect(asBlank(items[0]).length).toBe(35); // 20 + 15
    const c = asClip(items[1]);
    expect(c.in).toBe(15); // 0 → 15
    expect(c.out).toBe(89); // unchanged
    expect(playtime(c)).toBe(75); // 90 → 75
  });

  it("delta<0 (extend head earlier) SHRINKS the left blank by |delta|", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(blank(30), clip("/abs/a.mp4", { id: "c", in: 20, out: 99 }))],
    });
    const r = ok(trimIn(start, { uuid: "c", delta: -10, rippleAllTracks: false }));
    const items = vItems(r.state);
    expect(asBlank(items[0]).length).toBe(20); // 30 → 20
    expect(asClip(items[1]).in).toBe(10); // 20 → 10 (earlier start)
  });

  it("a head clip with NO left blank gets a holding blank of `delta` inserted", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/a.mp4", { id: "c", dur: 60 }))],
    });
    const r = ok(trimIn(start, { uuid: "c", delta: 12, rippleAllTracks: false }));
    const items = vItems(r.state);
    expect(items.map((i) => i.kind)).toEqual(["blank", "clip"]);
    expect(asBlank(items[0]).length).toBe(12); // holds the clip's screen position
    expect(asClip(items[1]).in).toBe(12);
  });

  it("the consequence reports the in-delta + playtime delta + the blank swap", () => {
    const r = ok(trimIn(tl(), { uuid: "c", delta: 15, rippleAllTracks: false }));
    const t = r.consequences.clipsTrimmed[0];
    expect(t).toMatchObject({ uuid: "c", inDelta: 15, outDelta: 0, playtimeDelta: -15 });
    // The resized blank reads as removed(20)+created(35).
    expect(r.consequences.blanksRemoved.some((b) => b.length === 20)).toBe(true);
    expect(r.consequences.blanksCreated.some((b) => b.length === 35)).toBe(true);
  });

  it("the scalar inverse is the SAME verb with -delta (no captured data)", () => {
    const r = ok(trimIn(tl(), { uuid: "c", delta: 15, rippleAllTracks: false }));
    expect(r.inverse).toEqual({
      op: "trimIn",
      args: { uuid: "c", delta: -15, rippleAllTracks: false },
    });
    const back = ok(trimIn(r.state, r.inverse.args));
    expect(back.state).toEqual(tl());
  });

  it("trimIn that would push the in-point past `out` is a typed frame-out-of-range error", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/a.mp4", { id: "c", in: 0, out: 9 }))],
    });
    const e = err(trimIn(start, { uuid: "c", delta: 20, rippleAllTracks: false }));
    expect(e.kind).toBe("frame-out-of-range");
  });

  it("trimIn with in<0 (extend before source frame 0) is a typed error", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(blank(30), clip("/abs/a.mp4", { id: "c", in: 5, out: 99 }))],
    });
    const e = err(trimIn(start, { uuid: "c", delta: -10, rippleAllTracks: false })); // 5-10 = -5
    expect(e.kind).toBe("frame-out-of-range");
  });

  it("extending into adjacent CONTENT (no left blank, delta<0) is a precondition error", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/before.mp4", { id: "before", dur: 20 }),
          clip("/abs/a.mp4", { id: "c", in: 20, out: 99 }),
        ),
      ],
    });
    const e = err(trimIn(start, { uuid: "c", delta: -5, rippleAllTracks: false }));
    expect(e.kind).toBe("precondition");
  });

  it("clip-not-found is a typed error", () => {
    const e = err(trimIn(tl(), { uuid: "nope", delta: 5, rippleAllTracks: false }));
    expect(e).toMatchObject({ kind: "clip-not-found", uuid: "nope" });
  });
});

describe("trimOut — tail resize + right-neighbour blank", () => {
  const tl = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/a.mp4", { id: "c", dur: 90 }),
          blank(25),
          clip("/abs/after.mp4", { id: "after", dur: 40 }),
        ),
      ],
    });
  };

  it("delta>0 pulls the out-point in and GROWS the right blank (downstream stays put)", () => {
    const r = ok(trimOut(tl(), { uuid: "c", delta: 15, rippleAllTracks: false }));
    const items = vItems(r.state);
    expect(asClip(items[0]).out).toBe(74); // 89 → 74
    expect(asBlank(items[1]).length).toBe(40); // 25 → 40 (absorbs the 15)
    expect(asClip(items[2]).id).toBe("after"); // unmoved
  });

  it("delta<0 (extend tail later) SHRINKS the right blank, bounded by source length", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/a.mp4", { id: "c", in: 0, out: 49, length: 200 }),
          blank(30),
          clip("/abs/after.mp4", { id: "after", dur: 40 }),
        ),
      ],
    });
    const r = ok(trimOut(start, { uuid: "c", delta: -10, rippleAllTracks: false }));
    const items = vItems(r.state);
    expect(asClip(items[0]).out).toBe(59); // 49 → 59 (longer)
    expect(asBlank(items[1]).length).toBe(20); // 30 → 20
  });

  it("extending the tail PAST the source length is a typed frame-out-of-range error", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/a.mp4", { id: "c", in: 0, out: 49, length: 50 }), blank(30))],
    });
    // out 49 → 59 would exceed source length 50 (max out = 49).
    const e = err(trimOut(start, { uuid: "c", delta: -10, rippleAllTracks: false }));
    expect(e.kind).toBe("frame-out-of-range");
  });

  it("a tail clip with no right blank inserts a holding blank that the serializer drops", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/a.mp4", { id: "c", dur: 70 }))],
    });
    const r = ok(trimOut(start, { uuid: "c", delta: 20, rippleAllTracks: false }));
    expect(asClip(vItems(r.state)[0]).out).toBe(49); // 69 → 49
    // The inserted trailing blank is dropped on serialize; the inverse re-grows the
    // clip without needing it — round-trip is still exact.
    const back = ok(trimOut(r.state, r.inverse.args));
    expect(back.state).toEqual(start);
  });

  it("out-delta is reported as -delta (the out-point moved by -delta)", () => {
    const r = ok(trimOut(tl(), { uuid: "c", delta: 15, rippleAllTracks: false }));
    expect(r.consequences.clipsTrimmed[0]).toMatchObject({
      uuid: "c",
      inDelta: 0,
      outDelta: -15,
      playtimeDelta: -15,
    });
  });
});

describe("trim — fade interaction (sentinels, not keyframe strings)", () => {
  it("trimming a clip SHORTER than its fades warns (non-fatal) and keeps the sentinel verbatim", () => {
    resetIds();
    // A 40f clip carrying a 30f fadeIn + 30f fadeOut (60 > 40) trimmed to 25f.
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(clip("/abs/a.mp4", { id: "c", dur: 40, fadeIn: 30, fadeOut: 30 }), blank(50)),
      ],
    });
    const r = ok(trimOut(start, { uuid: "c", delta: 15, rippleAllTracks: false })); // 40 → 25
    expect(r.consequences.warnings.some((w) => w.code === "fade-exceeds-window")).toBe(true);
    // The fade sentinels are UNTOUCHED (the serializer clamps; ops never rewrite
    // a fade keyframe string — decision #1).
    const c = asClip(vItems(r.state)[0]);
    const fadeIn = c.filters.find((f) => f.service === FADE_IN_SERVICE);
    const fadeOut = c.filters.find((f) => f.service === FADE_OUT_SERVICE);
    expect(fadeIn?.properties.frames).toBe(30);
    expect(fadeOut?.properties.frames).toBe(30);
  });

  it("the warning is advisory only — the trim still succeeds and round-trips", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/a.mp4", { id: "c", dur: 40, fadeIn: 30 }), blank(50))],
    });
    const r = ok(trimOut(start, { uuid: "c", delta: 25, rippleAllTracks: false }));
    const back = ok(trimOut(r.state, r.inverse.args));
    expect(back.state).toEqual(start);
  });
});

describe("trim — escape-hatch keyframe re-base on a head trim", () => {
  it("trimIn shifts a non-fade animated filter's keyframe frames by -delta", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          blank(10),
          clip("/abs/scene.mp4", {
            id: "c",
            dur: 100,
            filters: [filter("brightness", { level: "0=0.2;50=0.6;99=1" })],
          }),
        ),
      ],
    });
    // trimIn +20: the local origin advances 20, so every keyframe frame drops by 20.
    const r = ok(trimIn(start, { uuid: "c", delta: 20, rippleAllTracks: false }));
    const c = asClip(vItems(r.state)[1]);
    const level = c.filters.find((f) => f.service === "brightness")?.properties.level;
    // 0→drop (−20, outside), 50→30, 99→79. New window len = 80, so 79 is the last valid frame.
    expect(level).toBe("30=0.6;79=1");
  });

  it("trimOut leaves a non-fade animated filter's keyframe frames UNCHANGED (origin fixed)", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/scene.mp4", {
            id: "c",
            dur: 100,
            filters: [filter("brightness", { level: "0=0.2;99=1" })],
          }),
          blank(40),
        ),
      ],
    });
    const r = ok(trimOut(start, { uuid: "c", delta: 30, rippleAllTracks: false }));
    const c = asClip(vItems(r.state)[0]);
    expect(c.filters.find((f) => f.service === "brightness")?.properties.level).toBe("0=0.2;99=1");
  });

  it("shiftAnimWindow drops keyframes outside the new window and passes non-animated values through", () => {
    expect(shiftAnimWindow("0=0;10=1;30=0", -10, 25)).toBe("0=1;20=0"); // 0→drop, 10→0, 30→drop
    expect(shiftAnimWindow("solid", 5, 100)).toBe("solid"); // no `=` → untouched
  });
});

describe("split — escape-hatch keyframe re-base across the cut", () => {
  // A file clip from source 0, 100 frames, carrying a brightness ramp authored in
  // the clip's local window (0..99). Split at local frame 40.
  function start(): Timeline {
    resetIds();
    return timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/scene.mp4", {
            id: "x",
            dur: 100,
            filters: [filter("brightness", { level: "0=0;50=0.5;99=1" })],
          }),
        ),
      ],
    });
  }

  it("re-bases the TAIL half's keyframes by -localFrame and leaves the HEAD verbatim", () => {
    const r = ok(split(start(), { uuid: "x", frame: 40 }));
    const items = vItems(r.state);
    const head = asClip(items[0]);
    const tail = asClip(items[1]);
    const lvl = (c: Clip) => c.filters.find((f) => f.service === "brightness")?.properties.level;
    // HEAD [0,39]: origin unchanged → keyframes verbatim (melt clamps past frame 39;
    // keeping them preserves the in-window gradient + the round-trip fixpoint).
    expect(head.in).toBe(0);
    expect(head.out).toBe(39);
    expect(lvl(head)).toBe("0=0;50=0.5;99=1");
    // TAIL [40,99]: origin moves +40, so every keyframe re-bases by -40; 0→drop,
    // 50→10, 99→59 — anchored to the tail's own 0-based played window.
    expect(tail.in).toBe(40);
    expect(tail.out).toBe(99);
    expect(lvl(tail)).toBe("10=0.5;59=1");
  });

  it("the two halves do NOT share a mutated filter object (deep-cloned per half)", () => {
    const r = ok(split(start(), { uuid: "x", frame: 40 }));
    const items = vItems(r.state);
    const head = asClip(items[0]);
    const tail = asClip(items[1]);
    const hf = head.filters.find((f) => f.service === "brightness");
    const tf = tail.filters.find((f) => f.service === "brightness");
    expect(hf).not.toBe(tf); // distinct objects — re-basing the tail didn't touch the head
    expect(hf?.properties.level).not.toBe(tf?.properties.level);
  });

  it("the inverse restores the original clip's keyframe string exactly (undo)", () => {
    const s = start();
    const r = ok(split(s, { uuid: "x", frame: 40 }));
    const back = apply(r.inverse, r.state);
    if (isEditError(back)) throw new Error("undo errored");
    expect(back.state).toEqual(s);
  });
});

describe("split — a COLOR half re-bases its window to 0-based (positionless generator)", () => {
  // REGRESSION: a color clip is content-identical at every frame and positionless,
  // so a split half's window must be 0-based (`[0, playtime-1]`) — the canonical,
  // serialized form. The tail used to inherit `in = in + localFrame` (e.g. 30)
  // while its re-based `length` was its played count (e.g. 30), so `out (59) ≥
  // length (30)` tripped the diagnostics engine's in-out-beyond-source rule on a
  // valid edit. This pins the 0-based re-base + the diagnostic silence + the
  // byte-stable round-trip.
  function start(): Timeline {
    resetIds();
    return timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "black", { id: "a" }), colorClip(60, "gold", { id: "b" }))],
    });
  }

  it("both halves are 0-based with length == their played count", () => {
    const r = ok(split(start(), { uuid: "a", frame: 30 }));
    const head = asClip(vItems(r.state)[0]);
    const tail = asClip(vItems(r.state)[1]);
    expect({ in: head.in, out: head.out, length: head.length }).toEqual({
      in: 0,
      out: 29,
      length: 30,
    });
    expect({ in: tail.in, out: tail.out, length: tail.length }).toEqual({
      in: 0,
      out: 29,
      length: 30,
    });
  });

  it("the split state is diagnostic-clean (no in-out-beyond-source)", () => {
    const r = ok(split(start(), { uuid: "a", frame: 30 }));
    const codes = collectDiagnostics(r.state).map((d) => d.code);
    expect(codes).not.toContain("in-out-beyond-source");
    expect(codes).toEqual([]);
  });

  it("round-trips byte-identically (the fixpoint is preserved)", () => {
    const r = ok(split(start(), { uuid: "a", frame: 30 }));
    const xml = toMlt(r.state);
    expect(toMlt(fromMlt(xml))).toBe(xml);
  });

  it("the inverse restores the original color clip exactly (undo)", () => {
    const s = start();
    const r = ok(split(s, { uuid: "a", frame: 30 }));
    const back = apply(r.inverse, r.state);
    if (isEditError(back)) throw new Error("undo errored");
    expect(back.state).toEqual(s);
  });
});

describe("trim — a COLOR clip re-bases its window to 0-based, and the inverse survives PERSIST", () => {
  // REGRESSION (the Move-2 bridge surfaced this): a trim on a positionless color
  // generator produced an in-memory window (e.g. trimIn +10 → in=10,out=49) that
  // the serializer ALWAYS re-bases to 0-based (in=0,out=39, the only form it
  // emits for a color clip). After a serialize→reparse persist — the actual path
  // the MCP apply-op → write .mlt → undo tool takes — the scalar inverse
  // (trimIn −10) computed `newIn = 0 − 10 = −10 < 0` and FAILED with
  // frame-out-of-range. The in-memory-only undo tests (and the op-invariant
  // harness, which applies the inverse to the in-memory post-edit state) never
  // exercised the persisted path, so the suite missed it. Same root-cause family
  // as the split-color fix above; fixed at the edit-algebra layer (trim re-bases
  // the color window 0-based by playtime). These pin: the 0-based window, the
  // in-memory undo, AND the serialize→reparse→undo restore to the ORIGINAL doc.
  function start(): Timeline {
    resetIds();
    // A left blank (for trimIn) and a right blank (for trimOut) so each trim has a
    // neighbour to absorb the playtime change non-ripple.
    return timeline(VERTICAL, {
      video: [videoTrack(blank(20), colorClip(50, "blue", { id: "c3" }), blank(25))],
    });
  }

  for (const [verb, fn] of [
    ["trimIn", trimIn],
    ["trimOut", trimOut],
  ] as const) {
    it(`${verb} re-bases the color window 0-based by playtime`, () => {
      const r = ok(fn(start(), { uuid: "c3", delta: 10, rippleAllTracks: false }));
      const c = findClipIn(r.state, "c3");
      expect({ in: c.in, out: c.out, length: c.length }).toEqual({ in: 0, out: 39, length: 40 });
    });

    it(`${verb} leaves the state diagnostic-clean (no in-out-beyond-source)`, () => {
      const r = ok(fn(start(), { uuid: "c3", delta: 10, rippleAllTracks: false }));
      expect(collectDiagnostics(r.state).map((d) => d.code)).not.toContain("in-out-beyond-source");
    });

    it(`${verb} inverse restores the original IN-MEMORY (deep-equal undo)`, () => {
      const s = start();
      const r = ok(fn(s, { uuid: "c3", delta: 10, rippleAllTracks: false }));
      const back = apply(r.inverse, r.state);
      if (isEditError(back)) throw new Error(`${verb} in-memory undo errored`);
      expect(back.state).toEqual(s);
    });

    it(`${verb} inverse survives serialize→reparse and restores the original BYTE-EXACTLY (the persist path)`, () => {
      const s = start();
      const origXml = toMlt(s);
      const r = ok(fn(s, { uuid: "c3", delta: 10, rippleAllTracks: false }));

      // Persist: serialize the edit, then re-parse — exactly what the MCP server
      // does between apply-op and the undo tool (write .mlt → read .mlt).
      const reparsed = fromMlt(toMlt(r.state));

      // The inverse returned by the forward op must apply cleanly to the PERSISTED
      // state, not just the in-memory one — and restore the original document.
      const back = apply(r.inverse, reparsed);
      if (isEditError(back))
        throw new Error(`${verb} PERSISTED undo errored: ${JSON.stringify(back)}`);
      expect(toMlt(back.state)).toBe(origXml);
    });
  }

  it("the trimmed color state round-trips byte-identically (serializer fixpoint)", () => {
    const r = ok(trimIn(start(), { uuid: "c3", delta: 10, rippleAllTracks: false }));
    const xml = toMlt(r.state);
    expect(toMlt(fromMlt(xml))).toBe(xml);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// move
// ═══════════════════════════════════════════════════════════════════════════

describe("move — non-ripple (lift + overwrite)", () => {
  const tl = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [
        videoTrack(
          colorClip(30, "black"),
          clip("/abs/mid.mp4", { id: "mv", dur: 40, fadeIn: 8 }),
          colorClip(30, "gold"),
        ),
        videoTrack(clip("/abs/v2.mp4", { id: "v2head", dur: 20 })),
      ],
    });
  };

  it("LIFTS the clip from the source (a same-length blank opens where it was)", () => {
    const r = ok(
      move(tl(), {
        uuid: "mv",
        toTrack: { kind: "video", index: 1 },
        toPosition: 60,
        ripple: false,
        rippleAllTracks: false,
      }),
    );
    const v1 = vItems(r.state, 0);
    // black(30) + blank(40) [the lift] + gold(30) — consolidateBlanks keeps the
    // interior gap (it is load-bearing, between two clips).
    expect(v1.map((i) => i.kind)).toEqual(["clip", "blank", "clip"]);
    expect(asBlank(v1[1]).length).toBe(40);
    // The moved clip is gone from V1.
    expect(v1.some((i) => i.kind === "clip" && i.id === "mv")).toBe(false);
  });

  it("OVERWRITES the clip onto the destination, padding a blank past the track end", () => {
    const r = ok(
      move(tl(), {
        uuid: "mv",
        toTrack: { kind: "video", index: 1 },
        toPosition: 60,
        ripple: false,
        rippleAllTracks: false,
      }),
    );
    const v2 = vItems(r.state, 1);
    // v2head(20) + blank(40) [pad 20→60] + mv(40).
    expect(v2.map((i) => i.kind)).toEqual(["clip", "blank", "clip"]);
    expect(asBlank(v2[1]).length).toBe(40);
    expect(asClip(v2[2]).id).toBe("mv");
  });

  it("PRESERVES the clip uuid + all content across the move (identity)", () => {
    const before = findClipIn(tl(), "mv");
    const r = ok(
      move(tl(), {
        uuid: "mv",
        toTrack: { kind: "video", index: 1 },
        toPosition: 60,
        ripple: false,
        rippleAllTracks: false,
      }),
    );
    const after = findClipIn(r.state, "mv");
    expect(after).toEqual(before); // same id, window, filters (fadeIn), gain
  });

  it("reports clipsMoved from→to and the inverse is `move` back to the origin", () => {
    const r = ok(
      move(tl(), {
        uuid: "mv",
        toTrack: { kind: "video", index: 1 },
        toPosition: 60,
        ripple: false,
        rippleAllTracks: false,
      }),
    );
    const m = r.consequences.clipsMoved[0];
    expect(m?.uuid).toBe("mv");
    expect(m?.from.position).toBe(30); // it sat after black(30)
    expect(m?.to.position).toBe(60);
    expect(r.inverse.op).toBe("move");
    expect(r.inverse.args).toMatchObject({ uuid: "mv", toPosition: 30, ripple: false });
    // Round-trip (move back) is exact (dest was empty → lossless).
    const back = ok(move(r.state, r.inverse.args));
    expect(back.state).toEqual(tl());
  });

  it("a non-ripple move over REAL content is rejected (not silently lossy + non-invertible)", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(clip("/abs/a.mp4", { id: "mv", dur: 30 }), blank(100)),
        videoTrack(clip("/abs/victim.mp4", { id: "victim", dur: 50 })),
      ],
    });
    // Drop "mv"(30) at frame 0 on V2, where it would stamp over the first 30f of
    // "victim". A non-ripple (overwrite) move destroys that content with no capture,
    // so its `move`-back inverse can't reconstruct it — the op rejects it with a
    // typed precondition rather than producing a non-invertible state (use ripple,
    // or remove the content first). This is the fix for the straddle/overwrite-
    // content inverse bug.
    const e = err(
      move(start, {
        uuid: "mv",
        toTrack: { kind: "video", index: 1 },
        toPosition: 0,
        ripple: false,
        rippleAllTracks: false,
      }),
    );
    expect(e.kind).toBe("precondition");
    expect(JSON.stringify(e)).toMatch(/overwrite content/i);
  });

  it("a same-track / same-position move is a valid no-op (identity inverse)", () => {
    const r = ok(
      move(tl(), {
        uuid: "mv",
        toTrack: { kind: "video", index: 0 },
        toPosition: 30, // exactly where it already sits
        ripple: false,
        rippleAllTracks: false,
      }),
    );
    expect(r.state).toEqual(tl());
  });

  it("an unresolvable destination track is a typed track-not-found error", () => {
    const e = err(
      move(tl(), {
        uuid: "mv",
        toTrack: { kind: "video", index: 9 },
        toPosition: 0,
        ripple: false,
        rippleAllTracks: false,
      }),
    );
    expect(e.kind).toBe("track-not-found");
  });

  it("the result serializes Shotcut-clean (xmllint, namespace-aware)", () => {
    const r = ok(
      move(tl(), {
        uuid: "mv",
        toTrack: { kind: "video", index: 1 },
        toPosition: 60,
        ripple: false,
        rippleAllTracks: false,
      }),
    );
    assertXmllintClean(r.state, "move-non-ripple");
  });
});

describe("move — ripple (remove + insert)", () => {
  const tl = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/a.mp4", { id: "mv", dur: 40 }),
          clip("/abs/b.mp4", { id: "b", dur: 50 }),
          clip("/abs/c.mp4", { id: "cc", dur: 30 }),
        ),
      ],
    });
  };

  it("CLOSES the source gap (content after pulls left) then re-opens at the destination", () => {
    const r = ok(
      move(tl(), {
        uuid: "mv",
        toTrack: { kind: "video", index: 0 },
        toPosition: 80, // the new tail after removing mv (120 → 80)
        ripple: true,
        rippleAllTracks: false,
      }),
    );
    const v = vItems(r.state);
    // After ripple-remove: b(50) + cc(30); insert mv at the tail (80) → b, cc, mv.
    expect(v.map((i) => asClip(i).id)).toEqual(["b", "cc", "mv"]);
    // No interior gap — the ripple closed it.
    expect(v.every((i) => i.kind === "clip")).toBe(true);
  });

  it("the inverse ripple-move is exact (back to the origin)", () => {
    const r = ok(
      move(tl(), {
        uuid: "mv",
        toTrack: { kind: "video", index: 0 },
        toPosition: 80,
        ripple: true,
        rippleAllTracks: false,
      }),
    );
    expect(r.inverse.args).toMatchObject({ uuid: "mv", toPosition: 0, ripple: true });
    const back = ok(move(r.state, r.inverse.args));
    expect(back.state).toEqual(tl());
  });

  it("rippleAllTracks over trailing emptiness shifts the other track losslessly", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          blank(20),
          clip("/abs/a.mp4", { id: "mv", dur: 40 }),
          clip("/abs/b.mp4", { id: "b", dur: 30 }),
        ),
        videoTrack(clip("/abs/ov.mp4", { id: "ov", dur: 10 })),
      ],
    });
    const r = ok(
      move(start, {
        uuid: "mv",
        toTrack: { kind: "video", index: 0 },
        toPosition: 50, // V1's new tail after removing mv
        ripple: true,
        rippleAllTracks: true,
      }),
    );
    // The other track (10f, before both seams) is only touched on trailing
    // emptiness → unchanged; the ripple notes still record the shift.
    expect(vItems(r.state, 1).map((i) => asClip(i).id)).toEqual(["ov"]);
    expect(r.consequences.ripple.length).toBeGreaterThan(0);
    const back = ok(move(r.state, r.inverse.args));
    expect(back.state).toEqual(start);
  });

  it("the ripple-move result serializes Shotcut-clean (xmllint)", () => {
    const r = ok(
      move(tl(), {
        uuid: "mv",
        toTrack: { kind: "video", index: 0 },
        toPosition: 80,
        ripple: true,
        rippleAllTracks: false,
      }),
    );
    assertXmllintClean(r.state, "move-ripple");
  });
});
