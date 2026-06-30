// Focused unit tests for the ROLL op — moving the cut point between two adjacent
// same-track clips without moving either outer edge or changing total duration.
//
// The registry-driven harness (tests/op-invariants.test.ts) proves the five
// contract laws on every `samples` fixture once roll is wired into the registry.
// This file pins the op-SPECIFIC mechanics the generic harness can't see:
//   • the seam moves by exactly `delta`, both outer edges + total duration unchanged;
//   • the scalar inverse (roll -delta) deep-equals the original state;
//   • the typed bounds EditErrors (left.out past media end / right.in below 0);
//   • the dissolve-adjacency guard (a roll into a dissolve junction is rejected).
//
// Imports go straight to the op file + the IR builder (NOT the `../src/ops`
// registry barrel) so this suite is independent of the lead wiring roll into the
// registry — it exercises roll directly, the way ops-trim-move imports trim.
import { describe, expect, it } from "vitest";
import { clip, colorClip, filter, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { VERTICAL } from "../src/ir/profile";
import type { Clip, Item, Timeline } from "../src/ir/types";
// `apply` is used ONLY to build the dissolve fixture (case 4) via the registry's
// dissolve op — the same way ops-dissolve-ripple-guards builds it. `roll` itself is
// imported DIRECTLY from its file so this suite is independent of registry wiring.
import { apply } from "../src/ops/index";
import { roll } from "../src/ops/roll";
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
function playtime(c: Clip): number {
  return c.out - c.in + 1;
}
function trackPlaytime(items: Item[]): number {
  let n = 0;
  for (const it of items) {
    if (it.kind === "clip") n += playtime(it);
    else if (it.kind === "blank") n += it.length;
    else n += it.frames; // dissolve
  }
  return n;
}

// A plain two-clip junction on V1: L(file) immediately followed by R(file).
function junction(): Timeline {
  resetIds();
  return timeline(VERTICAL, {
    video: [
      videoTrack(
        clip("/abs/a.mp4", { id: "L", in: 0, out: 89, length: 200 }),
        clip("/abs/b.mp4", { id: "R", in: 30, out: 119, length: 200 }),
      ),
    ],
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// (1) the cut moves by delta; both outer edges + total duration unchanged
// ═══════════════════════════════════════════════════════════════════════════
describe("roll — the seam moves, the pair's outer edges + duration do not", () => {
  it("delta>0: left grows by delta (out += delta), right shrinks by delta (in += delta)", () => {
    const before = junction();
    const beforeLen = trackPlaytime(vItems(before));
    const r = ok(
      roll(before, {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        delta: 15,
      }),
    );
    const items = vItems(r.state);
    const L = asClip(items[0]);
    const R = asClip(items[1]);

    // Left clip's tail extended; its START (in) is fixed.
    expect(L.in).toBe(0); // outer (head) edge unchanged
    expect(L.out).toBe(104); // 89 + 15
    expect(playtime(L)).toBe(105); // 90 → 105 (grew by delta)

    // Right clip's head advanced; its END (out) is fixed.
    expect(R.in).toBe(45); // 30 + 15
    expect(R.out).toBe(119); // outer (tail) edge unchanged
    expect(playtime(R)).toBe(75); // 90 → 75 (shrank by delta)

    // Total track duration is UNCHANGED — the seam moved, nothing downstream did.
    expect(trackPlaytime(items)).toBe(beforeLen);
    expect(beforeLen).toBe(180);

    // Consequences: both clips trimmed, no net duration change.
    expect(r.consequences.durationDelta).toBe(0);
    expect(r.consequences.clipsTrimmed).toEqual([
      { uuid: "L", inDelta: 0, outDelta: 15, playtimeDelta: 15 },
      { uuid: "R", inDelta: 15, outDelta: 0, playtimeDelta: -15 },
    ]);
  });

  it("delta<0: left shrinks, right grows; outer edges + duration still fixed", () => {
    resetIds();
    const before = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/a.mp4", { id: "L", in: 10, out: 99, length: 200 }),
          clip("/abs/b.mp4", { id: "R", in: 40, out: 129, length: 200 }),
        ),
      ],
    });
    const beforeLen = trackPlaytime(vItems(before));
    const r = ok(
      roll(before, {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        delta: -12,
      }),
    );
    const items = vItems(r.state);
    const L = asClip(items[0]);
    const R = asClip(items[1]);
    expect(L.in).toBe(10); // head fixed
    expect(L.out).toBe(87); // 99 - 12
    expect(R.in).toBe(28); // 40 - 12
    expect(R.out).toBe(129); // tail fixed
    expect(trackPlaytime(items)).toBe(beforeLen);
  });

  it("a roll on the RIGHT clip re-bases its escape-hatch animated filter window by -delta", () => {
    resetIds();
    const before = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/a.mp4", { id: "L", in: 0, out: 59, length: 300 }),
          clip("/abs/b.mp4", {
            id: "R",
            in: 0,
            out: 99,
            length: 300,
            filters: [filter("brightness", { level: "0=0.2;99=1" })],
          }),
        ),
      ],
    });
    const r = ok(
      roll(before, {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        delta: 20,
      }),
    );
    const R = asClip(vItems(r.state)[1]);
    // R.in 0→20; the keyframes re-base by -20: frame 0 drops (off the new head),
    // frame 99 → 79 (still inside the now-80-frame window).
    expect(R.filters[0]?.properties.level).toBe("79=1");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (2) the inverse round-trips to a deep-equal original
// ═══════════════════════════════════════════════════════════════════════════
describe("roll — scalar inverse (roll -delta) deep-equals the original", () => {
  it("file-clip junction round-trips byte-for-byte", () => {
    const before = junction();
    const r = ok(
      roll(before, {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        delta: 15,
      }),
    );
    expect(r.inverse).toEqual({
      op: "roll",
      args: { track: { kind: "video", index: 0 }, leftUuid: "L", rightUuid: "R", delta: -15 },
    });
    const back = ok(roll(r.state, r.inverse.args));
    expect(back.state).toEqual(before);
  });

  it("color-clip junction round-trips (both halves re-based 0-based by playtime)", () => {
    resetIds();
    const before = timeline(VERTICAL, {
      video: [videoTrack(colorClip(50, "gold", { id: "L" }), colorClip(50, "blue", { id: "R" }))],
    });
    const r = ok(
      roll(before, {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        delta: 10,
      }),
    );
    const items = vItems(r.state);
    // Color halves are positionless: windows stay 0-based, lengths track playtime.
    expect(asClip(items[0])).toMatchObject({ in: 0, out: 59, length: 60 }); // 50 → 60
    expect(asClip(items[1])).toMatchObject({ in: 0, out: 39, length: 40 }); // 50 → 40
    const back = ok(roll(r.state, r.inverse.args));
    expect(back.state).toEqual(before);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (3) bounds rejection (left past media end / right below 0)
// ═══════════════════════════════════════════════════════════════════════════
describe("roll — bounds are typed EditErrors (never a throw)", () => {
  it("rejects pushing left.out past its source length", () => {
    resetIds();
    const before = timeline(VERTICAL, {
      video: [
        // L's source ends at length 100 (out can reach 99); rolling +20 wants out=109.
        videoTrack(
          clip("/abs/a.mp4", { id: "L", in: 0, out: 89, length: 100 }),
          clip("/abs/b.mp4", { id: "R", in: 30, out: 119, length: 200 }),
        ),
      ],
    });
    const e = err(
      roll(before, {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        delta: 20,
      }),
    );
    expect(e.kind).toBe("frame-out-of-range");
    expect(JSON.stringify(e)).toMatch(/source length/);
  });

  it("rejects pushing right.in below 0", () => {
    resetIds();
    const before = timeline(VERTICAL, {
      video: [
        // R starts at source frame 10; rolling -15 wants in=-5 (< 0).
        videoTrack(
          clip("/abs/a.mp4", { id: "L", in: 20, out: 89, length: 200 }),
          clip("/abs/b.mp4", { id: "R", in: 10, out: 119, length: 200 }),
        ),
      ],
    });
    const e = err(
      roll(before, {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        delta: -15,
      }),
    );
    expect(e.kind).toBe("frame-out-of-range");
    expect(JSON.stringify(e)).toMatch(/source start/);
  });

  it("rejects non-adjacent / different-track clips with a typed precondition", () => {
    resetIds();
    const before = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/a.mp4", { id: "L", in: 0, out: 89, length: 200 }),
          clip("/abs/mid.mp4", { id: "M", in: 0, out: 29, length: 200 }),
          clip("/abs/b.mp4", { id: "R", in: 30, out: 119, length: 200 }),
        ),
      ],
    });
    const e = err(
      roll(before, { track: { kind: "video", index: 0 }, leftUuid: "L", rightUuid: "R", delta: 5 }),
    );
    expect(e.kind).toBe("precondition");
    expect(JSON.stringify(e)).toMatch(/immediately follow/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// (4) dissolve-adjacency rejection
// ═══════════════════════════════════════════════════════════════════════════
describe("roll — a dissolve at the junction is rejected (no corrupting the lumaMix)", () => {
  it("returns a typed precondition when the two clips are joined by a dissolve", () => {
    // Build the dissolved junction via the registry dissolve op (the same fixture
    // shape ops-dissolve-ripple-guards uses), then attempt to roll across it.
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "gold", { id: "A" }), colorClip(60, "blue", { id: "B" }))],
    });
    const dissolved = ok(
      apply(
        {
          op: "dissolve",
          args: {
            track: { kind: "video", index: 0 },
            leftUuid: "A",
            rightUuid: "B",
            frames: 20,
            luma: "luma",
          },
        },
        tl,
      ),
    ).state;
    const e = err(
      roll(dissolved, {
        track: { kind: "video", index: 0 },
        leftUuid: "A",
        rightUuid: "B",
        delta: 5,
      }),
    );
    expect(e.kind).toBe("precondition");
    expect(JSON.stringify(e)).toMatch(/dissolve/i);
  });
});
