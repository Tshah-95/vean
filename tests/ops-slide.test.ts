// Focused unit tests for the SLIDE op (Move 1a).
//
// The registry-driven harness (tests/op-invariants.test.ts) proves the five
// contract laws on every `samples` fixture once the lead wires slide into the
// registry. This file pins the op-SPECIFIC mechanics the generic harness can't
// see — and imports the op FUNCTION directly (not via the registry barrel) so the
// suite is independent of the registry wiring still landing in parallel:
//   • the clip slides by delta with its OWN in/out + playtime UNCHANGED and the
//     track's total duration unchanged;
//   • BOTH neighbour kinds (clip and blank) absorb the shift correctly, on each
//     side, including a blank created/removed at the limit;
//   • the inverse (slide with -delta) round-trips deep-equal to the original;
//   • the bounds + dissolve + edge guards return typed EditErrors (never throw).
import { describe, expect, it } from "vitest";
import { blank, clip, dissolve, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { VERTICAL } from "../src/ir/profile";
import type { Blank, Clip, Item, Timeline } from "../src/ir/types";
import { slide } from "../src/ops/slide";
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
function trackFrames(items: Item[]): number {
  let n = 0;
  for (const it of items) {
    n += it.kind === "clip" ? playtime(it) : it.kind === "blank" ? it.length : it.frames;
  }
  return n;
}
function findClipIn(tl: Timeline, uuid: string): Clip {
  for (const t of [...tl.tracks.video, ...tl.tracks.audio]) {
    for (const it of t.items) if (it.kind === "clip" && it.id === uuid) return it;
  }
  throw new Error(`clip "${uuid}" not found`);
}

// ═══════════════════════════════════════════════════════════════════════════
// (1) the slid clip's content is unchanged; total duration is unchanged
// ═══════════════════════════════════════════════════════════════════════════

describe("slide — the slid clip's window is fixed and the track length is preserved", () => {
  const tl = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/left.mp4", { id: "L", in: 0, out: 49, length: 200 }),
          clip("/abs/mid.mp4", { id: "mid", in: 10, out: 49, length: 100 }),
          clip("/abs/right.mp4", { id: "R", in: 20, out: 99, length: 200 }),
        ),
      ],
    });
  };

  it("the slid clip's in/out/playtime are UNCHANGED (only its position moved)", () => {
    const before = findClipIn(tl(), "mid");
    const r = ok(slide(tl(), { uuid: "mid", delta: 10 }));
    const after = findClipIn(r.state, "mid");
    expect({ in: after.in, out: after.out }).toEqual({ in: before.in, out: before.out });
    expect(playtime(after)).toBe(playtime(before));
    // The whole clip object is identical (id, window, filters, gain) — content
    // didn't change, only where it plays.
    expect(after).toEqual(before);
  });

  it("the track's total frame length is unchanged (neighbours absorbed the shift)", () => {
    const start = tl();
    const before = trackFrames(vItems(start));
    const r = ok(slide(start, { uuid: "mid", delta: 10 }));
    expect(trackFrames(vItems(r.state))).toBe(before);
  });

  it("the clip's timeline position moved by exactly delta (consequence)", () => {
    const r = ok(slide(tl(), { uuid: "mid", delta: 10 }));
    const m = r.consequences.clipsMoved[0];
    expect(m?.uuid).toBe("mid");
    expect(m?.from.position).toBe(50); // after L(50)
    expect(m?.to.position).toBe(60); // +10
    expect(r.consequences.durationDelta).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (2) both clip-neighbour and blank-neighbour cases
// ═══════════════════════════════════════════════════════════════════════════

describe("slide — clip neighbours resize their windows like a trim", () => {
  const tl = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/left.mp4", { id: "L", in: 0, out: 49, length: 200 }),
          clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
          clip("/abs/right.mp4", { id: "R", in: 20, out: 99, length: 200 }),
        ),
      ],
    });
  };

  it("delta>0: the LEFT clip extends its tail (out += delta), the RIGHT clip retracts its head (in += delta)", () => {
    const r = ok(slide(tl(), { uuid: "mid", delta: 10 }));
    const items = vItems(r.state);
    expect(asClip(items[0]).out).toBe(59); // L 49 → 59 (tail extends)
    expect(asClip(items[2]).in).toBe(30); // R 20 → 30 (head retracts)
    // mid is untouched in the middle.
    expect(asClip(items[1]).id).toBe("mid");
  });

  it("delta<0: the LEFT clip retracts its tail, the RIGHT clip extends its head", () => {
    const r = ok(slide(tl(), { uuid: "mid", delta: -10 }));
    const items = vItems(r.state);
    expect(asClip(items[0]).out).toBe(39); // L 49 → 39 (tail retracts)
    expect(asClip(items[2]).in).toBe(10); // R 20 → 10 (head extends)
  });

  it("reports both neighbour trims (left out-delta, right in-delta) with playtime deltas summing to 0", () => {
    const r = ok(slide(tl(), { uuid: "mid", delta: 10 }));
    const byId = Object.fromEntries(r.consequences.clipsTrimmed.map((t) => [t.uuid, t]));
    expect(byId.L).toMatchObject({ inDelta: 0, outDelta: 10, playtimeDelta: 10 });
    expect(byId.R).toMatchObject({ inDelta: 10, outDelta: 0, playtimeDelta: -10 });
    const sum = r.consequences.clipsTrimmed.reduce((a, t) => a + t.playtimeDelta, 0);
    expect(sum).toBe(0); // the two neighbours' playtime changes cancel
  });
});

describe("slide — blank neighbours resize their length", () => {
  const tl = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [
        videoTrack(
          blank(30),
          clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
          blank(25),
          clip("/abs/anchor.mp4", { id: "anchor", dur: 20 }),
        ),
      ],
    });
  };

  it("delta>0: the LEFT blank GROWS by delta, the RIGHT blank SHRINKS by delta", () => {
    const r = ok(slide(tl(), { uuid: "mid", delta: 8 }));
    const items = vItems(r.state);
    expect(asBlank(items[0]).length).toBe(38); // 30 + 8
    expect(asClip(items[1]).id).toBe("mid");
    expect(asBlank(items[2]).length).toBe(17); // 25 - 8
    expect(asClip(items[3]).id).toBe("anchor"); // unmoved
  });

  it("delta<0: the LEFT blank SHRINKS, the RIGHT blank GROWS", () => {
    const r = ok(slide(tl(), { uuid: "mid", delta: -8 }));
    const items = vItems(r.state);
    expect(asBlank(items[0]).length).toBe(22); // 30 - 8
    expect(asBlank(items[2]).length).toBe(33); // 25 + 8
  });

  it("a RIGHT blank shrunk exactly to 0 is REMOVED", () => {
    const r = ok(slide(tl(), { uuid: "mid", delta: 25 })); // right blank 25 → 0
    const items = vItems(r.state);
    // left blank(55) + mid + anchor — the emptied right blank is gone.
    expect(items.map((i) => i.kind)).toEqual(["blank", "clip", "clip"]);
    expect(asBlank(items[0]).length).toBe(55); // 30 + 25
    expect(asClip(items[2]).id).toBe("anchor");
    expect(r.consequences.blanksRemoved.some((b) => b.length === 25)).toBe(true);
  });

  it("a mixed blank-left / clip-right slide adjusts each by kind", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          blank(20),
          clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
          clip("/abs/R.mp4", { id: "R", in: 0, out: 99, length: 200 }),
        ),
      ],
    });
    const r = ok(slide(start, { uuid: "mid", delta: 12 }));
    const items = vItems(r.state);
    expect(asBlank(items[0]).length).toBe(32); // 20 + 12 (blank extends)
    expect(asClip(items[2]).in).toBe(12); // R head retracts 0 → 12
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (3) inverse round-trips deep-equal to the original
// ═══════════════════════════════════════════════════════════════════════════

describe("slide — the inverse is slide with -delta and restores the original", () => {
  it("the inverse invocation is slide(-delta)", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/L.mp4", { id: "L", in: 0, out: 49, length: 200 }),
          clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
          clip("/abs/R.mp4", { id: "R", in: 20, out: 99, length: 200 }),
        ),
      ],
    });
    const r = ok(slide(start, { uuid: "mid", delta: 10 }));
    expect(r.inverse).toEqual({ op: "slide", args: { uuid: "mid", delta: -10 } });
  });

  for (const [label, mk, args] of [
    [
      "clip neighbours",
      (): Timeline =>
        timeline(VERTICAL, {
          video: [
            videoTrack(
              clip("/abs/L.mp4", { id: "L", in: 0, out: 49, length: 200 }),
              clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
              clip("/abs/R.mp4", { id: "R", in: 20, out: 99, length: 200 }),
            ),
          ],
        }),
      { uuid: "mid", delta: 10 },
    ],
    [
      "blank neighbours",
      (): Timeline =>
        timeline(VERTICAL, {
          video: [
            videoTrack(
              blank(30),
              clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
              blank(25),
              clip("/abs/anchor.mp4", { id: "anchor", dur: 20 }),
            ),
          ],
        }),
      { uuid: "mid", delta: -8 },
    ],
    [
      "mixed blank-left / clip-right neighbours",
      (): Timeline =>
        timeline(VERTICAL, {
          video: [
            videoTrack(
              blank(20),
              clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
              clip("/abs/R.mp4", { id: "R", in: 20, out: 99, length: 200 }),
            ),
          ],
        }),
      { uuid: "mid", delta: 12 },
    ],
  ] as const) {
    it(`round-trips deep-equal for ${label}`, () => {
      resetIds();
      const start = mk();
      const r = ok(slide(start, { ...args }));
      const back = ok(slide(r.state, r.inverse.args));
      expect(back.state).toEqual(start);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// (4) bounds + dissolve + edge rejection (typed EditErrors)
// ═══════════════════════════════════════════════════════════════════════════

describe("slide — guards return typed EditErrors (never throw)", () => {
  it("clip-not-found is a typed error", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(blank(10), clip("/abs/a.mp4", { id: "c", dur: 30 }), blank(10))],
    });
    const e = err(slide(start, { uuid: "nope", delta: 5 }));
    expect(e).toMatchObject({ kind: "clip-not-found", uuid: "nope" });
  });

  it("no LEFT neighbour (clip at the track start) is a precondition error", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/a.mp4", { id: "c", dur: 30 }), blank(20))],
    });
    const e = err(slide(start, { uuid: "c", delta: 5 }));
    expect(e.kind).toBe("precondition");
    expect(JSON.stringify(e)).toMatch(/no left neighbour/i);
  });

  it("no RIGHT neighbour (clip at the track end) is a precondition error", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(blank(20), clip("/abs/a.mp4", { id: "c", dur: 30 }))],
    });
    const e = err(slide(start, { uuid: "c", delta: 5 }));
    expect(e.kind).toBe("precondition");
    expect(JSON.stringify(e)).toMatch(/no right neighbour/i);
  });

  it("a clip-neighbour extending PAST its source length is a frame-out-of-range error", () => {
    resetIds();
    // L has out 49, length 50 → max out is 49, so it cannot extend (delta>0 needs
    // L to extend its tail).
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/L.mp4", { id: "L", in: 0, out: 49, length: 50 }),
          clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
          clip("/abs/R.mp4", { id: "R", in: 20, out: 99, length: 200 }),
        ),
      ],
    });
    const e = err(slide(start, { uuid: "mid", delta: 5 }));
    expect(e.kind).toBe("frame-out-of-range");
  });

  it("a retracting clip-neighbour that would empty it is a frame-out-of-range error", () => {
    resetIds();
    // delta>0 needs R to retract its head (in += delta). R is only 1 frame
    // ([99,99]); in += 5 → 104 > out 99, which would empty it.
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/L.mp4", { id: "L", in: 0, out: 49, length: 200 }),
          clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
          clip("/abs/R.mp4", { id: "R", in: 99, out: 99, length: 200 }),
        ),
      ],
    });
    const e = err(slide(start, { uuid: "mid", delta: 5 }));
    expect(e.kind).toBe("frame-out-of-range");
  });

  it("a retracting BLANK neighbour with no room is a precondition error", () => {
    resetIds();
    // delta>0 shrinks the right blank; the right blank is only 3 frames, so a
    // delta of 5 would push it negative.
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          blank(40),
          clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
          blank(3),
          clip("/abs/anchor.mp4", { id: "anchor", dur: 20 }),
        ),
      ],
    });
    const e = err(slide(start, { uuid: "mid", delta: 5 }));
    expect(e.kind).toBe("precondition");
  });

  it("a clip ADJACENT to a dissolve is rejected (would dangle the marker)", () => {
    resetIds();
    // mid borders a dissolve on its right (mid + dissolve + R), so sliding it would
    // shorten a clip the dissolve depends on / strand the marker.
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/L.mp4", { id: "L", dur: 40 }),
          clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
          dissolve(10),
          clip("/abs/R.mp4", { id: "R", dur: 40 }),
        ),
      ],
    });
    const e = err(slide(start, { uuid: "mid", delta: 5 }));
    expect(e.kind).toBe("precondition");
    expect(JSON.stringify(e)).toMatch(/dissolve/i);
  });

  it("a NEIGHBOUR clip that participates in a dissolve on its far edge is rejected", () => {
    resetIds();
    // The right neighbour R participates in a dissolve on ITS right (R + dissolve +
    // tail); retracting R's head is fine, but the op conservatively rejects any
    // dissolve in the immediate window so it never shortens a dissolve-bound clip.
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          blank(20),
          clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
          clip("/abs/R.mp4", { id: "R", dur: 40 }),
          dissolve(10),
          clip("/abs/tail.mp4", { id: "tail", dur: 40 }),
        ),
      ],
    });
    const e = err(slide(start, { uuid: "mid", delta: 5 }));
    expect(e.kind).toBe("precondition");
    expect(JSON.stringify(e)).toMatch(/dissolve/i);
  });

  it("a delta=0 slide is a valid identity (no-op) whose inverse is itself", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/L.mp4", { id: "L", dur: 40 }),
          clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
          clip("/abs/R.mp4", { id: "R", dur: 40 }),
        ),
      ],
    });
    const r = ok(slide(start, { uuid: "mid", delta: 0 }));
    expect(r.state).toEqual(start);
    expect(r.inverse).toEqual({ op: "slide", args: { uuid: "mid", delta: 0 } });
  });

  it("does not mutate the input state (purity)", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/L.mp4", { id: "L", in: 0, out: 49, length: 200 }),
          clip("/abs/mid.mp4", { id: "mid", dur: 40 }),
          clip("/abs/R.mp4", { id: "R", in: 20, out: 99, length: 200 }),
        ),
      ],
    });
    const snapshot = structuredClone(start);
    slide(start, { uuid: "mid", delta: 10 });
    expect(start).toEqual(snapshot);
  });
});
