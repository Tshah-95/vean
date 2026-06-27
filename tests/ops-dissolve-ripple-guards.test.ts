// Regression tests for the Move 1a edit-algebra integrity fixes — the classes of
// defect an adversarial hunt surfaced in the regimes the happy-path samples avoid.
// Each pins a fix so it can't silently regress:
//
//   1. Cross-track ripple-CLOSE no longer SHREDS real content on other tracks — it
//      leaves a content-bearing track in place and reports a `ripple-blocked`
//      warning (visible, never silent). Over blank seams it still pulls left and
//      inverts exactly.
//   2. Straddling overwrite / mid-clip insert now invert EXACTLY (captured-span
//      restore + `_uninsert` re-merge) instead of leaving fresh-uuid fragments.
//   3. Dissolve frame-math: positional helpers count the overlap ONCE (the
//      rendered length), so positional ops land where the caller means.
//   4. Edits that would corrupt a dissolve (split/insert/overwrite inside its
//      blended region or a participating clip, vacating a dissolve neighbour, a
//      split that starves a dissolve's clip) return a TYPED EditError — never a
//      thrown error (law #5) and never an unserializable dangling-marker state.
//   5. A clip cannot move across the video/audio kind boundary.
//
// Everything runs through the `apply` dispatcher (the real op surface) and asserts
// the result either round-trips (toMlt → fromMlt fixpoint, Shotcut-clean) or is a
// typed EditError. No melt/ffmpeg — pure IR + serializer.
import { describe, expect, it } from "vitest";
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
import { apply, isEditError, trackLength } from "../src/ops";
import type { OpResult } from "../src/ops";
import type { EditError } from "../src/ops/types";

function ok(r: OpResult | EditError): OpResult {
  if (isEditError(r)) throw new Error(`unexpected EditError: ${JSON.stringify(r)}`);
  return r;
}
function err(r: OpResult | EditError): EditError {
  if (!isEditError(r)) throw new Error("expected an EditError, got an OpResult");
  return r;
}
/** A clip+dissolve fixture: [A(60), dissolve(20), B(60)] on V1. Rendered spans:
 *  A-solo [0,40), blend [40,60), B-solo [60,100). */
function dissolved() {
  resetIds();
  const tl = timeline(VERTICAL, {
    video: [videoTrack(colorClip(60, "gold", { id: "A" }), colorClip(60, "blue", { id: "B" }))],
  });
  return ok(
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
}

describe("ripple-all-tracks never shreds (or hides) other-track content", () => {
  it("ripple-close over REAL content leaves the track in place + warns (and inverts exactly)", () => {
    resetIds();
    const before = timeline(VERTICAL, {
      video: [
        videoTrack(
          colorClip(20, "black", { id: "bk" }),
          clip("/abs/v.mp4", { id: "v", dur: 50 }),
          colorClip(20, "gold", { id: "gd" }),
        ),
        videoTrack(clip("/abs/keep.mp4", { id: "keep", dur: 200 })),
      ],
    });
    const r = ok(apply({ op: "remove", args: { uuid: "v", rippleAllTracks: true } }, before));
    // The other track's `keep` is UNTOUCHED (not split/shredded).
    const v2 = r.state.tracks.video[1]?.items ?? [];
    expect(v2).toHaveLength(1);
    expect(v2[0]).toMatchObject({ id: "keep", in: 0, out: 199 });
    // The cross-track effect is VISIBLE as a warning (never silent).
    expect(r.consequences.warnings.some((w) => w.code === "ripple-blocked")).toBe(true);
    // No phantom ripple shift reported for that track.
    expect(r.consequences.ripple.find((e) => e.track === "track-1")).toBeUndefined();
    // Undo is exact (the blocked track was never moved).
    const back = ok(apply(r.inverse, r.state));
    expect(back.state).toEqual(before);
  });

  it("ripple-close over a BLANK seam pulls left and inverts exactly", () => {
    resetIds();
    const before = timeline(VERTICAL, {
      video: [
        videoTrack(
          colorClip(20, "black", { id: "bk" }),
          clip("/abs/v.mp4", { id: "v", dur: 50 }),
          colorClip(20, "gold", { id: "gd" }),
        ),
        videoTrack(clip("/abs/ov.mp4", { id: "ov", dur: 15 })), // ends at 15, before the seam (20)
      ],
    });
    const r = ok(apply({ op: "remove", args: { uuid: "v", rippleAllTracks: true } }, before));
    // The other track's trailing emptiness was pulled left → a real ripple effect.
    expect(r.consequences.ripple.find((e) => e.track === "track-1")?.shift).toBe(-50);
    expect(r.consequences.warnings.some((w) => w.code === "ripple-blocked")).toBe(false);
    const back = ok(apply(r.inverse, r.state));
    expect(back.state).toEqual(before);
  });
});

describe("straddle/mid-clip placement inverts exactly (no fresh-uuid fragments left)", () => {
  it("overwrite straddling a clip boundary restores both clips whole on undo", () => {
    resetIds();
    const before = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/a.mp4", { id: "A", dur: 40, fadeOut: 8 }),
          clip("/abs/b.mp4", { id: "B", dur: 40, fadeIn: 8 }),
        ),
      ],
    });
    const r = ok(
      apply(
        {
          op: "overwrite",
          args: {
            track: { kind: "video", index: 0 },
            clip: clip("/abs/s.mp4", { id: "S", dur: 30 }),
            position: 25,
          },
        },
        before,
      ),
    );
    // Consequences report the WHOLE clips touched (by their real uuids), not fragments.
    expect(r.consequences.clipsRemoved.map((c) => c.uuid).sort()).toEqual(["A", "B"]);
    const back = ok(apply(r.inverse, r.state));
    expect(back.state).toEqual(before);
  });

  it("mid-clip insert inverts via _uninsert (re-merges the split halves)", () => {
    resetIds();
    const before = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/big.mp4", { id: "big", dur: 100, fadeIn: 8, fadeOut: 8 }))],
    });
    const r = ok(
      apply(
        {
          op: "insert",
          args: {
            track: { kind: "video", index: 0 },
            clip: clip("/abs/i.mp4", { id: "ins", dur: 20 }),
            position: 40,
            rippleAllTracks: false,
          },
        },
        before,
      ),
    );
    expect(r.inverse.op).toBe("_uninsert");
    const back = ok(apply(r.inverse, r.state));
    expect(back.state).toEqual(before);
  });
});

describe("dissolve frame-math: positional helpers count the overlap once", () => {
  it("trackLength of [A(60), dissolve(20), B(60)] is the rendered length (100)", () => {
    const items = dissolved().tracks.video[0]?.items ?? [];
    expect(trackLength(items)).toBe(100);
  });

  it("an append after a dissolve lands at the true (rendered) track end", () => {
    const state = dissolved();
    const r = ok(
      apply(
        {
          op: "append",
          args: {
            track: { kind: "video", index: 0 },
            clip: clip("/abs/tail.mp4", { id: "tail", dur: 10 }),
          },
        },
        state,
      ),
    );
    // Track was 100f rendered; the appended clip is reported starting at 100.
    expect(r.consequences.clipsAdded[0]?.position).toBe(100);
    // And it round-trips Shotcut-clean.
    const xml = toMlt(r.state);
    expect(toMlt(fromMlt(xml))).toBe(toMlt(fromMlt(toMlt(fromMlt(xml)))));
  });
});

describe("dissolve integrity: corrupting edits return typed EditErrors (law #5)", () => {
  it("remove a dissolve neighbour → typed precondition (no dangling marker)", () => {
    const e = err(
      apply({ op: "remove", args: { uuid: "B", rippleAllTracks: false } }, dissolved()),
    );
    expect(e.kind).toBe("precondition");
    expect(JSON.stringify(e)).toMatch(/dissolve/i);
  });

  it("lift a dissolve neighbour → typed precondition", () => {
    const e = err(apply({ op: "lift", args: { uuid: "A" } }, dissolved()));
    expect(e.kind).toBe("precondition");
  });

  it("insert inside the blended region → typed precondition (not a throw)", () => {
    let threw = false;
    let result: OpResult | EditError | undefined;
    try {
      result = apply(
        {
          op: "insert",
          args: {
            track: { kind: "video", index: 0 },
            clip: clip("/abs/x.mp4", { id: "x", dur: 5 }),
            position: 50,
            rippleAllTracks: false,
          },
        },
        dissolved(),
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(isEditError(result as OpResult | EditError)).toBe(true);
  });

  it("overwrite across a dissolve-bound clip → typed precondition", () => {
    const e = err(
      apply(
        {
          op: "overwrite",
          args: {
            track: { kind: "video", index: 0 },
            clip: clip("/abs/x.mp4", { id: "x", dur: 10 }),
            position: 45,
          },
        },
        dissolved(),
      ),
    );
    expect(e.kind).toBe("precondition");
  });

  it("split that would starve a dissolve's clip → typed precondition", () => {
    // B-solo is [60,100); split at 65 leaves B-head 5f < the 20f dissolve.
    const e = err(apply({ op: "split", args: { uuid: "B", frame: 65 } }, dissolved()));
    expect(e.kind).toBe("precondition");
    expect(JSON.stringify(e)).toMatch(/dissolve/i);
  });

  it("a valid edit OUTSIDE the blend (append at the tail) still works + round-trips", () => {
    const state = dissolved();
    const r = ok(
      apply(
        {
          op: "insert",
          args: {
            track: { kind: "video", index: 0 },
            clip: clip("/abs/y.mp4", { id: "y", dur: 10 }),
            position: 100,
            rippleAllTracks: false,
          },
        },
        state,
      ),
    );
    const back = ok(apply(r.inverse, r.state));
    expect(back.state).toEqual(state);
  });
});

describe("move respects the video/audio kind boundary", () => {
  it("moving a video clip onto an audio track → typed precondition", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(30, "blue", { id: "vid" }))],
      audio: [audioTrack(clip("/abs/aud.wav", { id: "aud", dur: 60 }))],
    });
    const e = err(
      apply(
        {
          op: "move",
          args: {
            uuid: "vid",
            toTrack: { kind: "audio", index: 0 },
            toPosition: 60,
            ripple: false,
            rippleAllTracks: false,
          },
        },
        tl,
      ),
    );
    expect(e.kind).toBe("precondition");
    expect(JSON.stringify(e)).toMatch(/audio track/i);
  });
});
