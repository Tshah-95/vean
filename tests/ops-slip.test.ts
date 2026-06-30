// Focused unit tests for the SLIP op (Move 1b).
//
// The registry-driven harness (tests/op-invariants.test.ts) proves the five
// contract laws on every `samples` fixture once slip is wired into the registry.
// This file pins the slip-SPECIFIC mechanics:
//   • apply slides BOTH in and out by delta while keeping the clip's track
//     position AND playtime invariant (the defining property of a slip);
//   • the bounds guards (new in < 0 at the media start; new out > length-1 at the
//     media end) return typed EditErrors, never throws;
//   • the scalar inverse (slip -delta) round-trips to the original state;
//   • a COLOR (positionless) clip is rejected, mirroring trim.ts's stance that a
//     color generator's window is canonical 0-based and carries no source meaning.
//
// Imports go straight to the op file + the IR builder (NOT the `../src/ops`
// registry barrel) so this suite is independent of the registry wiring the lead
// lands separately — it exercises slip directly, the way ops-trim-move.test.ts
// exercises trim/move.
import { describe, expect, it } from "vitest";
import { blank, clip, colorClip, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { VERTICAL } from "../src/ir/profile";
import type { Clip, Item, Timeline } from "../src/ir/types";
import { slip } from "../src/ops/slip";
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

// ═══════════════════════════════════════════════════════════════════════════
// slip — slide the source window, keep position + playtime
// ═══════════════════════════════════════════════════════════════════════════

describe("slip — slides in + out by delta; position + playtime fixed", () => {
  const tl = (): Timeline => {
    resetIds();
    // Clip windowed [20, 99] (playtime 80) on a 200-frame source, held at timeline
    // frame 30 by a leading blank.
    return timeline(VERTICAL, {
      video: [videoTrack(blank(30), clip("/abs/a.mp4", { id: "c", in: 20, out: 99, length: 200 }))],
    });
  };

  it("delta>0 advances BOTH in and out by delta (later source frames play)", () => {
    const r = ok(slip(tl(), { uuid: "c", delta: 15 }));
    const c = asClip(vItems(r.state)[1]);
    expect(c.in).toBe(35); // 20 + 15
    expect(c.out).toBe(114); // 99 + 15
  });

  it("delta<0 retreats BOTH in and out by |delta| (earlier source frames play)", () => {
    const r = ok(slip(tl(), { uuid: "c", delta: -10 }));
    const c = asClip(vItems(r.state)[1]);
    expect(c.in).toBe(10); // 20 - 10
    expect(c.out).toBe(89); // 99 - 10
  });

  it("PRESERVES playtime exactly (the defining slip invariant)", () => {
    const before = asClip(vItems(tl())[1]);
    const r = ok(slip(tl(), { uuid: "c", delta: 15 }));
    expect(playtime(asClip(vItems(r.state)[1]))).toBe(playtime(before)); // 80
  });

  it("PRESERVES the clip's timeline position (the leading blank is untouched)", () => {
    const r = ok(slip(tl(), { uuid: "c", delta: 15 }));
    const items = vItems(r.state);
    // The leading blank that holds the clip at frame 30 is unchanged — no ripple,
    // no neighbour-blank growth (slip moves no frames on the track).
    expect(items.map((i) => i.kind)).toEqual(["blank", "clip"]);
    expect(items[0]).toEqual({ kind: "blank", length: 30 });
  });

  it("reports clipsTrimmed with equal in/out deltas, zero playtime delta, no ripple", () => {
    const r = ok(slip(tl(), { uuid: "c", delta: 15 }));
    expect(r.consequences.clipsTrimmed[0]).toMatchObject({
      uuid: "c",
      inDelta: 15,
      outDelta: 15,
      playtimeDelta: 0,
    });
    expect(r.consequences.durationDelta).toBe(0);
    expect(r.consequences.ripple).toEqual([]);
    expect(r.consequences.blanksCreated).toEqual([]);
    expect(r.consequences.blanksRemoved).toEqual([]);
  });

  it("does NOT mutate the input state (purity)", () => {
    const state = tl();
    const before = structuredClone(state);
    slip(state, { uuid: "c", delta: 15 });
    expect(state).toEqual(before);
  });

  it("clip-not-found is a typed error", () => {
    const e = err(slip(tl(), { uuid: "nope", delta: 5 }));
    expect(e).toMatchObject({ kind: "clip-not-found", uuid: "nope" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// slip — bounds rejection (the …Valid guards, as VALUES)
// ═══════════════════════════════════════════════════════════════════════════

describe("slip — media bounds rejection", () => {
  it("slipping the window before source frame 0 (new in < 0) is a typed frame-out-of-range error", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/a.mp4", { id: "c", in: 5, out: 54, length: 200 }))],
    });
    // delta -10: new in = 5 - 10 = -5 < 0 → reject.
    const e = err(slip(start, { uuid: "c", delta: -10 }));
    expect(e.kind).toBe("frame-out-of-range");
    expect((e as Extract<EditError, { kind: "frame-out-of-range" }>).frame).toBe(-5);
  });

  it("slipping the window past the source's last frame (new out > length-1) is a typed error", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/a.mp4", { id: "c", in: 0, out: 49, length: 60 }))],
    });
    // delta +15: new out = 49 + 15 = 64 > length-1 (59) → reject.
    const e = err(slip(start, { uuid: "c", delta: 15 }));
    expect(e.kind).toBe("frame-out-of-range");
    expect((e as Extract<EditError, { kind: "frame-out-of-range" }>).bound).toBe(59);
  });

  it("a file clip with NO known source length skips the end ceiling (bound is unknown)", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/a.mp4", { id: "c", in: 0, out: 49 }))], // no length
    });
    // A large +δ would exceed any real source, but with no probed length there is
    // no enforceable ceiling — matches trimOut's `clip.length != null` guard.
    const r = ok(slip(start, { uuid: "c", delta: 500 }));
    const c = asClip(vItems(r.state)[0]);
    expect({ in: c.in, out: c.out }).toEqual({ in: 500, out: 549 });
  });

  it("slipping exactly to the source edges is allowed (boundary is inclusive)", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/a.mp4", { id: "c", in: 10, out: 59, length: 100 }))],
    });
    // delta +40: new out = 99 = length-1 (the last valid frame) → allowed.
    const r = ok(slip(start, { uuid: "c", delta: 40 }));
    expect(asClip(vItems(r.state)[0]).out).toBe(99);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// slip — scalar inverse round-trip
// ═══════════════════════════════════════════════════════════════════════════

describe("slip — the scalar inverse (slip -delta) restores the original", () => {
  const tl = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [videoTrack(blank(30), clip("/abs/a.mp4", { id: "c", in: 20, out: 99, length: 200 }))],
    });
  };

  it("the inverse is the SAME verb with -delta (no captured data)", () => {
    const r = ok(slip(tl(), { uuid: "c", delta: 15 }));
    expect(r.inverse).toEqual({ op: "slip", args: { uuid: "c", delta: -15 } });
  });

  it("apply(inverse, apply(slip).state) deep-equals the original state", () => {
    const original = tl();
    const fwd = ok(slip(original, { uuid: "c", delta: 15 }));
    const back = ok(slip(fwd.state, fwd.inverse.args));
    expect(back.state).toEqual(original);
  });

  it("the inverse round-trips for a negative delta too", () => {
    const original = tl();
    const fwd = ok(slip(original, { uuid: "c", delta: -10 }));
    const back = ok(slip(fwd.state, fwd.inverse.args));
    expect(back.state).toEqual(original);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// slip — color clip behavior matches trim.ts (positionless generator)
// ═══════════════════════════════════════════════════════════════════════════

describe("slip — a COLOR clip is rejected (positionless, mirrors trim.ts)", () => {
  // trim.ts treats a color generator's window as canonical 0-based and carrying no
  // source meaning (every frame is content-identical, the serializer always emits
  // it 0-based). A slip only slides the source window, which is meaningless for a
  // color clip — so it is refused with a typed precondition rather than producing
  // an in-memory window that diverges from the serialized 0-based form.
  it("returns a typed precondition EditError, not a throw, and does not mutate", () => {
    resetIds();
    const start = timeline(VERTICAL, {
      video: [videoTrack(blank(20), colorClip(50, "blue", { id: "col" }))],
    });
    const before = structuredClone(start);
    const e = err(slip(start, { uuid: "col", delta: 10 }));
    expect(e.kind).toBe("precondition");
    expect(JSON.stringify(e)).toMatch(/color/i);
    expect(start).toEqual(before); // purity even on the rejection path
  });
});
