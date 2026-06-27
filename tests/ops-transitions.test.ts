// Focused unit tests for the TRANSITIONS op family — dissolve + fadeIn/fadeOut.
// The registry-driven harness (tests/op-invariants.test.ts) already proves the
// FIVE contract laws on every sample (purity, inverse deep-equal undo, serialize
// Shotcut-clean, round-trip). This file pins the op-SPECIFIC mechanics the generic
// harness can't see:
//   • dissolve inserts the right marker between the right two clips, shrinks the
//     timeline by the overlap, serializes to the lumaMix nested-tractor shape,
//     and rejects a too-long / non-adjacent / cross-track overlap with the typed
//     EditError;
//   • fadeIn/fadeOut set the integer sentinel (not a keyframe string), the scalar
//     inverse restores the PREVIOUS length, frames=0 removes the fade, and the
//     length guards fire as typed EditErrors.
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { FADE_IN_SERVICE, FADE_OUT_SERVICE } from "../src/ir/builder";
import { audioTrack, clip, colorClip, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { VERTICAL } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import type { Clip, Dissolve, Item, Timeline } from "../src/ir/types";
import { dissolve, removeDissolve } from "../src/ops/dissolve";
import { fadeIn, fadeOut } from "../src/ops/fade";
import { type EditError, type OpResult, isEditError } from "../src/ops/types";

// ─── helpers ──────────────────────────────────────────────────────────────────
function ok(r: OpResult | EditError): OpResult {
  if (isEditError(r)) throw new Error(`unexpected EditError: ${JSON.stringify(r)}`);
  return r;
}
function videoItems(tl: Timeline, i = 0): Item[] {
  return tl.tracks.video[i]?.items ?? [];
}
function audioItems(tl: Timeline, i = 0): Item[] {
  return tl.tracks.audio[i]?.items ?? [];
}
function asClip(it: Item | undefined): Clip {
  if (!it || it.kind !== "clip") throw new Error("expected a clip item");
  return it;
}
function totalFrames(items: Item[]): number {
  let n = 0;
  for (const it of items)
    n += it.kind === "clip" ? it.out - it.in + 1 : it.kind === "blank" ? it.length : it.frames;
  return n;
}

// ─── dissolve: marker insertion + overlap shrink ───────────────────────────────
describe("dissolve — marker mechanics", () => {
  const twoClips = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "gold", { id: "L" }), colorClip(60, "blue", { id: "R" }))],
    });
  };

  it("splices a dissolve marker BETWEEN the two named clips (left, dissolve, right)", () => {
    const r = ok(
      dissolve(twoClips(), {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        frames: 20,
        luma: "luma",
      }),
    );
    const items = videoItems(r.state);
    expect(items.map((i) => i.kind)).toEqual(["clip", "dissolve", "clip"]);
    expect(asClip(items[0]).id).toBe("L");
    expect(asClip(items[2]).id).toBe("R");
    expect((items[1] as Dissolve).frames).toBe(20);
    expect((items[1] as Dissolve).luma).toBe("luma");
  });

  it("the neighbour clips are NOT mutated in the IR — the serializer owns the overlap trim", () => {
    const before = twoClips();
    const r = ok(
      dissolve(before, {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        frames: 20,
        luma: "luma",
      }),
    );
    const items = videoItems(r.state);
    // Both neighbours keep their full [0,59] window; only a marker was inserted.
    expect(asClip(items[0]).out).toBe(59);
    expect(asClip(items[2]).out).toBe(59);
  });

  it("shrinks the TIMELINE length by the overlap (durationDelta = -frames)", () => {
    const before = twoClips();
    const r = ok(
      dissolve(before, {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        frames: 20,
        luma: "luma",
      }),
    );
    expect(r.consequences.durationDelta).toBe(-20);
    // Effective played length: the serializer emits 40 + 20 + 40 = 100 (was 120).
    expect(totalFrames(videoItems(before))).toBe(120);
    // The IR items still sum to 120 (full clips + marker), but the serialized
    // entries play 100 — verified in the serialize test below.
  });

  it("reports both neighbours trimmed by the overlap (consequences)", () => {
    const r = ok(
      dissolve(twoClips(), {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        frames: 20,
        luma: "luma",
      }),
    );
    expect(r.consequences.clipsTrimmed).toEqual([
      { uuid: "L", inDelta: 0, outDelta: -20, playtimeDelta: -20 },
      { uuid: "R", inDelta: 20, outDelta: 0, playtimeDelta: -20 },
    ]);
  });
});

// ─── dissolve: the lumaMix serialization shape ─────────────────────────────────
describe("dissolve — serializes to the lumaMix nested tractor (xmllint-clean)", () => {
  it("emits a nested tractor with a shotcut:transition PROPERTY child + luma & mix transitions", () => {
    resetIds();
    const state = timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "gold", { id: "L" }), colorClip(60, "blue", { id: "R" }))],
    });
    const r = ok(
      dissolve(state, {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        frames: 20,
        luma: "luma",
      }),
    );
    const xml = toMlt(r.state);

    // The lumaMix tag is a PROPERTY child, NEVER a namespaced attribute.
    expect(xml).toContain('<property name="shotcut:transition">lumaMix</property>');
    expect(xml).toMatch(/<transition mlt_service="luma" in="0" out="19">/);
    expect(xml).toMatch(/<transition mlt_service="mix" in="0" out="19">/);
    // The dissolve eats 20 frames: the two 60f clips now play 40 + 20 + 40 = 100.
    expect(xml).toContain('<entry producer="tractor0" in="0" out="19"/>');

    // No namespaced ATTRIBUTE survives (the Shotcut-openability invariant). Parse
    // namespace-aware and assert zero `prefix:` attribute names.
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      preserveOrder: true,
    });
    type Node = Record<string, unknown> & { ":@"?: Record<string, string> };
    const tree = parser.parse(xml) as Node[];
    const hits: string[] = [];
    const walk = (nodes: Node[]): void => {
      for (const node of nodes) {
        for (const key of Object.keys(node[":@"] ?? {})) {
          const name = key.startsWith("@_") ? key.slice(2) : key;
          if (name.includes(":") && name !== "xmlns" && !name.startsWith("xmlns:")) hits.push(name);
        }
        for (const [k, v] of Object.entries(node))
          if (k !== ":@" && Array.isArray(v)) walk(v as Node[]);
      }
    };
    walk(tree);
    expect(hits).toEqual([]);
  });
});

// ─── dissolve: typed-failure preconditions (law #5) ───────────────────────────
describe("dissolve — typed preconditions (no throw)", () => {
  const twoClips = (lLen = 60, rLen = 60): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [
        videoTrack(colorClip(lLen, "gold", { id: "L" }), colorClip(rLen, "blue", { id: "R" })),
      ],
    });
  };

  it("overlap longer than the LEFT neighbour → dissolve-too-long (side: out)", () => {
    const r = dissolve(twoClips(30, 60), {
      track: { kind: "video", index: 0 },
      leftUuid: "L",
      rightUuid: "R",
      frames: 40,
      luma: "luma",
    });
    expect(r).toMatchObject({ kind: "dissolve-too-long", frames: 40, neighbour: 30, side: "out" });
  });

  it("overlap longer than the RIGHT neighbour → dissolve-too-long (side: in)", () => {
    const r = dissolve(twoClips(60, 25), {
      track: { kind: "video", index: 0 },
      leftUuid: "L",
      rightUuid: "R",
      frames: 40,
      luma: "luma",
    });
    expect(r).toMatchObject({ kind: "dissolve-too-long", frames: 40, neighbour: 25, side: "in" });
  });

  it("non-adjacent clips (a blank between them) → precondition", () => {
    resetIds();
    const state = timeline(VERTICAL, {
      video: [
        videoTrack(
          colorClip(60, "gold", { id: "L" }),
          blankItem(),
          colorClip(60, "blue", { id: "R" }),
        ),
      ],
    });
    const r = dissolve(state, {
      track: { kind: "video", index: 0 },
      leftUuid: "L",
      rightUuid: "R",
      frames: 20,
      luma: "luma",
    });
    expect(isEditError(r)).toBe(true);
    expect((r as { kind: string }).kind).toBe("precondition");
  });

  it("clips on different tracks → precondition", () => {
    resetIds();
    const state = timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "gold", { id: "L" }))],
      audio: [audioTrack(clip("/abs/a.wav", { id: "R", dur: 60 }))],
    });
    const r = dissolve(state, {
      track: { kind: "video", index: 0 },
      leftUuid: "L",
      rightUuid: "R",
      frames: 20,
      luma: "luma",
    });
    expect(isEditError(r)).toBe(true);
    expect((r as { kind: string }).kind).toBe("precondition");
  });

  it("an unknown clip uuid → clip-not-found", () => {
    const r = dissolve(twoClips(), {
      track: { kind: "video", index: 0 },
      leftUuid: "L",
      rightUuid: "nope",
      frames: 20,
      luma: "luma",
    });
    expect(r).toMatchObject({ kind: "clip-not-found", uuid: "nope" });
  });

  // A pre-existing adjacent dissolve consumes part of a neighbour; a new dissolve
  // on the other side must respect the REMAINING playtime (mirrors the
  // serializer's validateTrack: a clip can't be over-consumed by two dissolves).
  it("respects frames already claimed by an adjacent dissolve on the other side", () => {
    resetIds();
    const state = timeline(VERTICAL, {
      video: [
        videoTrack(
          colorClip(60, "gold", { id: "A" }),
          colorClip(60, "blue", { id: "B" }), // middle clip
          colorClip(60, "red", { id: "C" }),
        ),
      ],
    });
    // First dissolve A↔B claims 40 of B's head.
    const r1 = ok(
      dissolve(state, {
        track: { kind: "video", index: 0 },
        leftUuid: "A",
        rightUuid: "B",
        frames: 40,
        luma: "luma",
      }),
    );
    // Now B↔C: B has only 60-40 = 20 frames left on its tail side.
    const r2 = dissolve(r1.state, {
      track: { kind: "video", index: 0 },
      leftUuid: "B",
      rightUuid: "C",
      frames: 30,
      luma: "luma",
    });
    expect(r2).toMatchObject({ kind: "dissolve-too-long", frames: 30, neighbour: 20, side: "out" });
    // …but 20 fits exactly.
    const r3 = dissolve(r1.state, {
      track: { kind: "video", index: 0 },
      leftUuid: "B",
      rightUuid: "C",
      frames: 20,
      luma: "luma",
    });
    expect(isEditError(r3)).toBe(false);
  });
});

// ─── dissolve: inverse removes the marker + restores neighbours ────────────────
describe("dissolve — inverse (_removeDissolve)", () => {
  it("the inverse drops exactly the marker and restores the original item run", () => {
    resetIds();
    const before = timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "gold", { id: "L" }), colorClip(60, "blue", { id: "R" }))],
    });
    const fwd = ok(
      dissolve(before, {
        track: { kind: "video", index: 0 },
        leftUuid: "L",
        rightUuid: "R",
        frames: 20,
        luma: "luma",
      }),
    );
    expect(fwd.inverse.op).toBe("_removeDissolve");
    const back = ok(removeDissolve(fwd.state, fwd.inverse.args));
    expect(back.state).toEqual(before);
    // removeDissolve restores the overlap frames it gave back.
    expect(back.consequences.durationDelta).toBe(20);
    // And its OWN inverse re-applies the same dissolve (undo-of-undo).
    expect(back.inverse).toMatchObject({
      op: "dissolve",
      args: { leftUuid: "L", rightUuid: "R", frames: 20, luma: "luma" },
    });
  });
});

// ─── fadeIn / fadeOut: sentinel mechanics ──────────────────────────────────────
describe("fade — sentinel mechanics", () => {
  const plain = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, { video: [videoTrack(colorClip(60, "gold", { id: "c" }))] });
  };
  const withFadeIn = (frames: number): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "gold", { id: "c", fadeIn: frames }))],
    });
  };

  it("fadeIn adds an INTEGER sentinel filter (vean.fadeIn {frames}), not a keyframe string", () => {
    const r = ok(fadeIn(plain(), { uuid: "c", frames: 12 }));
    const c = asClip(videoItems(r.state)[0]);
    const f = c.filters.find((x) => x.service === FADE_IN_SERVICE);
    expect(f).toBeTruthy();
    expect(f?.properties).toEqual({ frames: 12 });
    // No keyframe `=` anywhere in the sentinel value (the serializer owns that).
    expect(String(f?.properties.frames)).not.toContain("=");
  });

  it("fadeIn on a clip that already has one REPLACES it (one sentinel, new length)", () => {
    const r = ok(fadeIn(withFadeIn(30), { uuid: "c", frames: 10 }));
    const c = asClip(videoItems(r.state)[0]);
    const fades = c.filters.filter((x) => x.service === FADE_IN_SERVICE);
    expect(fades).toHaveLength(1);
    expect(fades[0]?.properties.frames).toBe(10);
  });

  it("fadeIn frames=0 REMOVES the sentinel", () => {
    const r = ok(fadeIn(withFadeIn(15), { uuid: "c", frames: 0 }));
    const c = asClip(videoItems(r.state)[0]);
    expect(c.filters.some((x) => x.service === FADE_IN_SERVICE)).toBe(false);
  });

  it("the scalar inverse carries the PREVIOUS fade length", () => {
    // add (prev 0) → inverse frames 0
    const add = ok(fadeIn(plain(), { uuid: "c", frames: 12 }));
    expect(add.inverse).toMatchObject({ op: "fadeIn", args: { uuid: "c", frames: 0 } });
    // shorten (prev 30) → inverse frames 30
    const shorten = ok(fadeIn(withFadeIn(30), { uuid: "c", frames: 10 }));
    expect(shorten.inverse).toMatchObject({ op: "fadeIn", args: { uuid: "c", frames: 30 } });
  });

  it("fadeOut on an audio clip sets the vean.fadeOut sentinel (serializer → volume)", () => {
    resetIds();
    const state = timeline(VERTICAL, {
      audio: [audioTrack(clip("/abs/vo.wav", { id: "a", dur: 120 }))],
    });
    const r = ok(fadeOut(state, { uuid: "a", frames: 24 }));
    const c = asClip(audioItems(r.state)[0]);
    expect(c.filters.find((x) => x.service === FADE_OUT_SERVICE)?.properties).toEqual({
      frames: 24,
    });
    // The serialized audio fade is a `volume` filter tagged fadeOutVolume.
    const xml = toMlt(r.state);
    expect(xml).toContain('<property name="shotcut:filter">fadeOutVolume</property>');
  });
});

// ─── fade: length guards (law #5) ──────────────────────────────────────────────
describe("fade — length guards (no throw)", () => {
  it("a fade longer than the clip → precondition", () => {
    resetIds();
    const state = timeline(VERTICAL, { video: [videoTrack(colorClip(30, "gold", { id: "c" }))] });
    const r = fadeIn(state, { uuid: "c", frames: 40 });
    expect(isEditError(r)).toBe(true);
    expect((r as { kind: string }).kind).toBe("precondition");
  });

  it("a fadeIn that would overlap the existing fadeOut → precondition", () => {
    resetIds();
    // 50f clip, already fades out 30; a 30f fadeIn would overlap (30+30 > 50).
    const state = timeline(VERTICAL, {
      video: [videoTrack(colorClip(50, "gold", { id: "c", fadeOut: 30 }))],
    });
    const r = fadeIn(state, { uuid: "c", frames: 30 });
    expect(isEditError(r)).toBe(true);
    expect((r as { kind: string }).kind).toBe("precondition");
  });

  it("an unknown clip → clip-not-found", () => {
    resetIds();
    const state = timeline(VERTICAL, { video: [videoTrack(colorClip(60, "gold", { id: "c" }))] });
    const r = fadeIn(state, { uuid: "missing", frames: 10 });
    expect(r).toMatchObject({ kind: "clip-not-found", uuid: "missing" });
  });
});

// A literal blank item (the builder's `blank` rejects 0; this is a fixed gap).
function blankItem(): Item {
  return { kind: "blank", length: 20 };
}
