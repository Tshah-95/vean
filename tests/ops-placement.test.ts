// Focused unit tests for the PLACEMENT + REMOVAL op mechanics (insert, overwrite,
// lift, remove, replace). The registry-driven harness (op-invariants.test.ts)
// already proves the two contract laws (apply→inverse identity + serialize/
// round-trip) across every op's `samples`. THIS file pins the specific surgery
// each op performs — the exact items[] shape, the blanks created, the captured
// region, the ripple effects — so a regression in HOW an op rearranges a track is
// caught with a precise message, not just "deep-equals failed".
//
// It also asserts the Shotcut-openability gate (`bun run lint:xml` semantics) on a
// WRITTEN-OUT sample of each op's result: serialize → `xmllint --noout --nsclean`
// → must emit nothing (no undeclared `shotcut:` prefix, well-formed).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERTICAL,
  blank,
  clip,
  colorClip,
  filter,
  resetIds,
  timeline,
  toMlt,
  videoTrack,
} from "../src/index";
import type { Item, Timeline } from "../src/ir/types";
import { type OpResult, apply, isEditError } from "../src/ops";

// ─── helpers ──────────────────────────────────────────────────────────────────
/** Apply an op and assert it did NOT error (returning the OpResult). */
function ok(op: string, args: unknown, state: Timeline): OpResult {
  const r = apply({ op, args }, state);
  if (isEditError(r)) throw new Error(`${op} errored: ${JSON.stringify(r)}`);
  return r;
}

/** The track-0 video items of a result state. */
function v0(state: Timeline): Item[] {
  return (state.tracks.video[0] as { items: Item[] }).items;
}

/** The stable id of a video track by index (track ids are minted by the builder's
 *  deterministic counter, so we read them from the state rather than guess). */
function vtid(state: Timeline, index: number): string {
  return (state.tracks.video[index] as { id: string }).id;
}

/** A compact, assertable shape of an items run: clips as `id:in-out`, blanks as
 *  `blank:N`, dissolves as `diss:N`. Lets a test name the EXACT track layout. */
function shape(items: Item[]): string[] {
  return items.map((it) =>
    it.kind === "clip"
      ? `${it.id}:${it.in}-${it.out}`
      : it.kind === "blank"
        ? `blank:${it.length}`
        : `diss:${it.frames}`,
  );
}

/** Run `xmllint --noout --nsclean` on serialized state; assert ZERO output (the
 *  exact `lint:xml` gate — an undeclared `shotcut:` prefix is reported on stderr
 *  even at exit 0, so any output is a defect). Proves the op result is
 *  Shotcut-openable. */
function assertXmllintClean(state: Timeline, label: string): void {
  const dir = mkdtempSync(join(tmpdir(), "vean-ops-placement-"));
  const path = join(dir, `${label}.mlt`);
  writeFileSync(path, toMlt(state));
  const out = execFileSync("sh", ["-c", `xmllint --noout --nsclean '${path}' 2>&1 || true`], {
    encoding: "utf8",
  }).trim();
  expect(out, `xmllint must be clean for ${label}, got: ${out}`).toBe("");
}

// ─── insert ─────────────────────────────────────────────────────────────────
describe("insert — ripple placement mechanics", () => {
  it("inserts at a clip boundary and ripples the tail right (no split)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(30, "black", { id: "a" }), colorClip(30, "gold", { id: "b" }))],
    });
    const r = ok(
      "insert",
      {
        track: { kind: "video", index: 0 },
        clip: clip("/abs/i.mp4", { id: "ins", dur: 40 }),
        position: 30,
        rippleAllTracks: false,
      },
      tl,
    );
    // a stays, the new clip lands at 30, b is pushed to start at 70 — and b keeps
    // its identity (a boundary insert does NOT split anything).
    expect(shape(v0(r.state))).toEqual(["a:0-29", "ins:0-39", "b:0-29"]);
    expect(r.consequences.clipsAdded).toEqual([
      { uuid: "ins", track: vtid(r.state, 0), position: 30, playtime: 40 },
    ]);
    expect(r.consequences.durationDelta).toBe(40);
    // Inverse is the public `remove` of the inserted clip.
    expect(r.inverse).toEqual({ op: "remove", args: { uuid: "ins", rippleAllTracks: false } });
  });

  it("inserts PAST the end by padding a leading blank", () => {
    resetIds();
    const tl = timeline(VERTICAL, { video: [videoTrack(colorClip(20, "black", { id: "a" }))] });
    const r = ok(
      "insert",
      {
        track: { kind: "video", index: 0 },
        clip: clip("/abs/late.mp4", { id: "late", dur: 30 }),
        position: 50,
        rippleAllTracks: false,
      },
      tl,
    );
    expect(shape(v0(r.state))).toEqual(["a:0-19", "blank:30", "late:0-29"]);
    expect(r.consequences.blanksCreated).toEqual([
      { track: vtid(r.state, 0), position: 20, length: 30 },
    ]);
    expect(r.consequences.durationDelta).toBe(30 + 30); // 30f pad + 30f clip
  });

  it("rippleAllTracks opens a same-length gap on every OTHER track at `position`", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(colorClip(30, "black", { id: "a" }), colorClip(30, "gold", { id: "b" })),
        videoTrack(
          colorClip(20, "blue", { id: "oa" }),
          blank(40),
          colorClip(20, "green", { id: "ob" }),
        ),
      ],
    });
    const r = ok(
      "insert",
      {
        track: { kind: "video", index: 0 },
        clip: clip("/abs/r.mp4", { id: "ins", dur: 25 }),
        position: 30,
        rippleAllTracks: true,
      },
      tl,
    );
    // Track 1's blank (spanning 30) grows by 25 (20→45) — a lossless blank-merge.
    expect(shape((r.state.tracks.video[1] as { items: Item[] }).items)).toEqual([
      "oa:0-19",
      "blank:65",
      "ob:0-19",
    ]);
    // One ripple note for the single other track, +25 from frame 30.
    expect(r.consequences.ripple).toEqual([{ track: vtid(r.state, 1), shift: 25, from: 30 }]);
  });

  it("a MID-CLIP insert splits the covering clip AND inverts exactly (re-merges the halves)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(clip("/abs/big.mp4", { id: "big", dur: 100 }))],
    });
    const start = tl;
    const r = ok(
      "insert",
      {
        track: { kind: "video", index: 0 },
        clip: clip("/abs/i.mp4", { id: "ins", dur: 20 }),
        position: 40,
        rippleAllTracks: false,
      },
      tl,
    );
    const items = v0(r.state);
    expect(items).toHaveLength(3);
    // The head is a fresh-uuid clip [0,39]; `ins` lands; the original `big` survives
    // as the tail [40,99] (split keeps the original uuid on the right half).
    expect((items[0] as { kind: string; id: string }).id).not.toBe("big");
    expect(shape(items)[0]).toMatch(/:0-39$/);
    expect(shape(items).slice(1)).toEqual(["ins:0-19", "big:40-99"]);
    // The inverse is `_uninsert` (re-merges the split halves into the captured
    // original), NOT a plain `remove` — so a mid-clip insert undoes exactly.
    expect(r.inverse.op).toBe("_uninsert");
    const back = apply(r.inverse, r.state);
    if (isEditError(back))
      throw new Error(`mid-clip insert inverse errored: ${JSON.stringify(back)}`);
    expect(back.state).toEqual(start);
  });
});

// ─── overwrite ────────────────────────────────────────────────────────────────
describe("overwrite — split+consume+insert, capturing the region", () => {
  it("stamps over a whole clip and captures it for the inverse", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          colorClip(30, "black", { id: "a" }),
          clip("/abs/v.mp4", { id: "victim", dur: 40, fadeIn: 8 }),
          colorClip(30, "gold", { id: "c" }),
        ),
      ],
    });
    const r = ok(
      "overwrite",
      {
        track: { kind: "video", index: 0 },
        clip: colorClip(40, "blue", { id: "stamp" }),
        position: 30,
      },
      tl,
    );
    expect(shape(v0(r.state))).toEqual(["a:0-29", "stamp:0-39", "c:0-29"]);
    // The victim is reported removed…
    expect(r.consequences.clipsRemoved).toEqual([
      { uuid: "victim", track: vtid(r.state, 0), position: 30, playtime: 40 },
    ]);
    // …and captured verbatim in the inverse so it can be restored exactly.
    expect(r.inverse.op).toBe("_restoreRegion");
    expect(r.inverse.args.removed).toHaveLength(1);
    expect(r.inverse.args.removed[0].id).toBe("victim");
    expect(r.inverse.args.insertedUuid).toBe("stamp");
    // overwrite replaces in place: no net duration change.
    expect(r.consequences.durationDelta).toBe(0);
  });

  it("captures a MULTI-item removed region (blank + clip) when the region spans both", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          colorClip(20, "black", { id: "a" }),
          blank(20),
          clip("/abs/b.mp4", { id: "b", dur: 30 }),
        ),
      ],
    });
    // Overwrite 50f at position 20 (a clean boundary) → covers the blank AND b.
    const r = ok(
      "overwrite",
      {
        track: { kind: "video", index: 0 },
        clip: colorClip(50, "blue", { id: "stamp" }),
        position: 20,
      },
      tl,
    );
    expect(shape(v0(r.state))).toEqual(["a:0-19", "stamp:0-49"]);
    const removed = r.inverse.args.removed as Item[];
    expect(removed.map((it) => it.kind)).toEqual(["blank", "clip"]);
    expect((removed[1] as { id: string }).id).toBe("b");
    expect(r.consequences.blanksRemoved).toEqual([
      { track: vtid(r.state, 0), position: 20, length: 20 },
    ]);
  });

  it("PAST the end pads a leading blank then appends (padded captured for the inverse)", () => {
    resetIds();
    const tl = timeline(VERTICAL, { video: [videoTrack(colorClip(20, "black", { id: "a" }))] });
    const r = ok(
      "overwrite",
      {
        track: { kind: "video", index: 0 },
        clip: colorClip(30, "gold", { id: "late" }),
        position: 50,
      },
      tl,
    );
    expect(shape(v0(r.state))).toEqual(["a:0-19", "blank:30", "late:0-29"]);
    expect(r.inverse.args.padded).toBe(30);
    expect(r.inverse.args.removed).toEqual([]);
    expect(r.consequences.durationDelta).toBe(60); // track 20→80
  });
});

// ─── lift ─────────────────────────────────────────────────────────────────────
describe("lift — replace a clip with an equal blank (leave a gap)", () => {
  it("opens a same-length blank where the clip was (no ripple)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          colorClip(30, "black", { id: "a" }),
          clip("/abs/m.mp4", { id: "liftme", dur: 40 }),
          colorClip(30, "gold", { id: "c" }),
        ),
      ],
    });
    const r = ok("lift", { uuid: "liftme" }, tl);
    // The clip becomes a 40f gap; the neighbours do NOT move (lift never ripples).
    expect(shape(v0(r.state))).toEqual(["a:0-29", "blank:40", "c:0-29"]);
    expect(r.consequences.blanksCreated).toEqual([
      { track: vtid(r.state, 0), position: 30, length: 40 },
    ]);
    expect(r.consequences.durationDelta).toBe(0);
    expect(r.inverse.op).toBe("_unlift");
  });
});

// ─── remove ─────────────────────────────────────────────────────────────────
describe("remove — drop a clip and ripple-close the gap", () => {
  it("closes the gap so the right neighbour slides left by the playtime", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          colorClip(30, "black", { id: "a" }),
          clip("/abs/m.mp4", { id: "rm", dur: 40 }),
          colorClip(30, "gold", { id: "c" }),
        ),
      ],
    });
    const r = ok("remove", { uuid: "rm", rippleAllTracks: false }, tl);
    // No gap remains — c slides left to abut a (ripple-CLOSE, the opposite of lift).
    expect(shape(v0(r.state))).toEqual(["a:0-29", "c:0-29"]);
    expect(r.consequences.durationDelta).toBe(-40);
    expect(r.inverse.op).toBe("_reinsert");
  });
});

// ─── replace ──────────────────────────────────────────────────────────────────
describe("replace — swap the producer, keep the slot window", () => {
  it("pins the replacement's window to the slot length (neighbours fixed)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          colorClip(20, "black", { id: "a" }),
          clip("/abs/old.mp4", { id: "swap", dur: 40, fadeIn: 6 }),
          colorClip(20, "gold", { id: "c" }),
        ),
      ],
    });
    // The incoming clip has in=5; replace pins out to in + slot(40) - 1 = 44.
    const r = ok(
      "replace",
      {
        uuid: "swap",
        clip: clip("/abs/new.mp4", { id: "newc", in: 5, out: 9 }),
        copyFilters: false,
      },
      tl,
    );
    expect(shape(v0(r.state))).toEqual(["a:0-19", "newc:5-44", "c:0-19"]);
    const newc = v0(r.state)[1] as { in: number; out: number; filters: unknown[] };
    expect(newc.out - newc.in + 1).toBe(40); // playtime preserved
    expect(newc.filters).toHaveLength(0); // copyFilters:false → no inherited filters
    expect(r.consequences.durationDelta).toBe(0);
    // Inverse restores the captured OLD clip (with its own fade) and never re-copies.
    expect(r.inverse.op).toBe("replace");
    expect(r.inverse.args.uuid).toBe("newc");
    expect(r.inverse.args.clip.id).toBe("swap");
    expect(r.inverse.args.copyFilters).toBe(false);
  });

  it("copyFilters carries the OLD clip's filters onto the replacement (old first)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/old.mp4", {
            id: "swap",
            dur: 50,
            fadeOut: 10,
            filters: [filter("brightness", { level: "0=0.5;49=1" })],
          }),
        ),
      ],
    });
    const r = ok(
      "replace",
      { uuid: "swap", clip: clip("/abs/new.mp4", { id: "newc", dur: 5 }), copyFilters: true },
      tl,
    );
    const newc = v0(r.state)[0] as { filters: { service: string }[] };
    // Old fadeOut sentinel + brightness ride onto the replacement, ahead of its own
    // (empty) filter list.
    const services = newc.filters.map((f) => f.service);
    expect(services).toContain("vean.fadeOut");
    expect(services).toContain("brightness");
  });
});

// ─── Shotcut-openability (lint:xml gate) on every op family's result ───────────
describe("placement ops: results are Shotcut-clean (xmllint --noout --nsclean)", () => {
  const cases: Array<{ label: string; build: () => OpResult }> = [
    {
      label: "insert",
      build: () => {
        resetIds();
        const tl = timeline(VERTICAL, {
          video: [videoTrack(colorClip(30, "black"), colorClip(30, "gold"))],
        });
        return ok(
          "insert",
          {
            track: { kind: "video", index: 0 },
            clip: clip("/abs/i.mp4", { id: "ins", dur: 40, fadeIn: 8 }),
            position: 30,
            rippleAllTracks: false,
          },
          tl,
        );
      },
    },
    {
      label: "overwrite",
      build: () => {
        resetIds();
        const tl = timeline(VERTICAL, {
          video: [
            videoTrack(
              colorClip(30, "black"),
              clip("/abs/v.mp4", { id: "victim", dur: 40, fadeIn: 8, fadeOut: 8 }),
              colorClip(30, "gold"),
            ),
          ],
        });
        return ok(
          "overwrite",
          {
            track: { kind: "video", index: 0 },
            clip: colorClip(40, "blue", { id: "stamp" }),
            position: 30,
          },
          tl,
        );
      },
    },
    {
      label: "lift",
      build: () => {
        resetIds();
        const tl = timeline(VERTICAL, {
          video: [
            videoTrack(
              colorClip(30, "black"),
              clip("/abs/m.mp4", { id: "liftme", dur: 40, fadeIn: 8 }),
              colorClip(30, "gold"),
            ),
          ],
        });
        return ok("lift", { uuid: "liftme" }, tl);
      },
    },
    {
      label: "remove",
      build: () => {
        resetIds();
        const tl = timeline(VERTICAL, {
          video: [
            videoTrack(
              colorClip(30, "black"),
              clip("/abs/m.mp4", { id: "rm", dur: 40, fadeOut: 8 }),
              colorClip(30, "gold"),
            ),
          ],
        });
        return ok("remove", { uuid: "rm", rippleAllTracks: false }, tl);
      },
    },
    {
      label: "replace",
      build: () => {
        resetIds();
        const tl = timeline(VERTICAL, {
          video: [
            videoTrack(
              clip("/abs/old.mp4", {
                id: "swap",
                dur: 50,
                fadeOut: 10,
                filters: [filter("brightness", { level: "0=0.5;49=1" })],
              }),
            ),
          ],
        });
        return ok(
          "replace",
          { uuid: "swap", clip: clip("/abs/new.mp4", { id: "newc", dur: 5 }), copyFilters: true },
          tl,
        );
      },
    },
  ];

  for (const { label, build } of cases) {
    it(`${label}: serialized result is namespace-clean + well-formed`, () => {
      assertXmllintClean(build().state, label);
    });
  }
});
