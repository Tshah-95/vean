// Focused unit tests for the audio-filter-track op family (Move 1a):
//   • gain         — find-or-attach the Clip.gain multiplier; unity clears it;
//                    inverse restores the EXACT prior multiplier (lossless, not
//                    a db round-trip).
//   • addFilter /  — ordered splice/detach on the producer filter list; the
//     removeFilter   inverses are each other and preserve order byte-for-byte.
//   • addTrack /   — video prepends, audio appends; removeTrack captures the
//     removeTrack    whole track + index and the inverse re-adds it exactly.
//
// The registry-driven harness (tests/op-invariants.test.ts) already asserts the
// two contract laws (apply→inverse identity + serialize/round-trip) on every
// `samples` fixture. These tests pin the SPECIFIC mechanics those samples don't
// spell out — the exact field a gain set/clear leaves, the index an inverse
// targets, the slot a restored track lands in, and that a written-out result is
// Shotcut-clean (xmllint).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERTICAL,
  audioTrack,
  clip,
  colorClip,
  filter,
  resetIds,
  timeline,
  toMlt,
  videoTrack,
} from "../src/index";
import type { Clip, Timeline, Track } from "../src/ir/types";
import { apply, dbToGain, isEditError } from "../src/ops";

// ─── helpers ──────────────────────────────────────────────────────────────────
function ok(r: ReturnType<typeof apply>): Extract<ReturnType<typeof apply>, { state: Timeline }> {
  if (isEditError(r)) throw new Error(`unexpected EditError: ${JSON.stringify(r)}`);
  return r;
}
function videoClip(tl: Timeline, uuid: string): Clip {
  for (const t of [...tl.tracks.video, ...tl.tracks.audio]) {
    for (const it of t.items) if (it.kind === "clip" && it.id === uuid) return it;
  }
  throw new Error(`clip "${uuid}" not found`);
}

// ─── gain ───────────────────────────────────────────────────────────────────
describe("gain — find-or-attach the Clip.gain multiplier", () => {
  const audioTl = (g?: number): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      audio: [audioTrack(clip("/abs/vo.wav", { id: "vo", dur: 100, gain: g }))],
    });
  };

  it("sets Clip.gain from a db arg (−6 dB → ~0.501 multiplier)", () => {
    const r = ok(apply({ op: "gain", args: { uuid: "vo", db: -6 } }, audioTl()));
    expect(videoClip(r.state, "vo").gain).toBeCloseTo(dbToGain(-6), 10);
  });

  it("0 dB clears the field to unity (undefined, not a literal 1)", () => {
    const r = ok(apply({ op: "gain", args: { uuid: "vo", db: 0 } }, audioTl(0.5)));
    // Canonical unity is the ABSENT field (the serializer emits no volume filter,
    // and parse recovers undefined) — never a stored `1`.
    expect(videoClip(r.state, "vo").gain).toBeUndefined();
  });

  it("the inverse restores the EXACT prior multiplier (lossless, not via db)", () => {
    // 0.3 is the canonical db-lossy value: dbToGain(gainToDb(0.3)) !== 0.3.
    const original = audioTl(0.3);
    const fwd = ok(apply({ op: "gain", args: { uuid: "vo", db: 12 } }, original));
    expect(videoClip(fwd.state, "vo").gain).toBeCloseTo(dbToGain(12) * 1, 6); // forward set
    const back = ok(apply(fwd.inverse, fwd.state));
    // Byte-exact restore of 0.3 — proving the inverse captures the multiplier, not db.
    expect(videoClip(back.state, "vo").gain).toBe(0.3);
    expect(back.state).toEqual(original);
  });

  it("the inverse of a unity-start restores the ABSENT field (not a stored 1)", () => {
    const original = audioTl(); // no gain field
    const fwd = ok(apply({ op: "gain", args: { uuid: "vo", db: -3 } }, original));
    const back = ok(apply(fwd.inverse, fwd.state));
    expect(videoClip(back.state, "vo").gain).toBeUndefined();
    expect(back.state).toEqual(original);
  });

  it("clip-not-found → typed EditError (not a throw)", () => {
    const r = apply({ op: "gain", args: { uuid: "nope", db: -6 } }, audioTl());
    expect(r).toMatchObject({ kind: "clip-not-found", uuid: "nope" });
  });
});

// ─── addFilter / removeFilter ─────────────────────────────────────────────────
describe("addFilter / removeFilter — ordered producer filter list", () => {
  const twoFilterTl = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/abs/scene.mp4", {
            id: "shot",
            dur: 60,
            filters: [filter("sepia", { u: 75 }), filter("oldfilm", { delta: 1 })],
          }),
        ),
      ],
    });
  };

  it("appends when no index is given; inverse removeFilter targets the tail index", () => {
    const r = ok(
      apply(
        { op: "addFilter", args: { uuid: "shot", filter: { service: "grain", properties: {} } } },
        twoFilterTl(),
      ),
    );
    const fs = videoClip(r.state, "shot").filters;
    expect(fs.map((f) => f.service)).toEqual(["sepia", "oldfilm", "grain"]);
    // The new filter landed at index 2 → that's exactly what the inverse removes.
    expect(r.inverse).toEqual({ op: "removeFilter", args: { uuid: "shot", index: 2 } });
  });

  it("inserts at an explicit index, shifting later filters right", () => {
    const r = ok(
      apply(
        {
          op: "addFilter",
          args: { uuid: "shot", index: 0, filter: { service: "grain", properties: { n: 40 } } },
        },
        twoFilterTl(),
      ),
    );
    expect(videoClip(r.state, "shot").filters.map((f) => f.service)).toEqual([
      "grain",
      "sepia",
      "oldfilm",
    ]);
  });

  it("removeFilter drops the indexed filter and its inverse re-adds it AT that index (order-preserving)", () => {
    const original = twoFilterTl();
    const fwd = ok(apply({ op: "removeFilter", args: { uuid: "shot", index: 0 } }, original));
    expect(videoClip(fwd.state, "shot").filters.map((f) => f.service)).toEqual(["oldfilm"]);
    // The inverse carries the captured filter + its original index 0.
    expect(fwd.inverse).toMatchObject({
      op: "addFilter",
      args: { uuid: "shot", index: 0, filter: { service: "sepia" } },
    });
    const back = ok(apply(fwd.inverse, fwd.state));
    expect(back.state).toEqual(original);
  });

  it("removeFilter out-of-range index → typed EditError (no throw)", () => {
    const r = apply({ op: "removeFilter", args: { uuid: "shot", index: 9 } }, twoFilterTl());
    expect((r as { kind: string }).kind).toBe("frame-out-of-range");
  });

  it("warns when removeFilter targets a fade sentinel (fades own their surface)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "gold", { id: "f", fadeIn: 10 }))],
    });
    // The fade sentinel is the only filter (index 0).
    const r = ok(apply({ op: "removeFilter", args: { uuid: "f", index: 0 } }, tl));
    expect(r.consequences.warnings.map((w) => w.code)).toContain("filter-targets-fade-sentinel");
  });
});

// ─── addTrack / removeTrack ───────────────────────────────────────────────────
describe("addTrack / removeTrack — playlist tracks on the tractor", () => {
  const baseTl = (): Timeline => {
    resetIds();
    return timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "gold", { id: "v" }))],
      audio: [audioTrack(clip("/abs/vo.wav", { id: "a", dur: 60 }))],
    });
  };

  it("addTrack(video) PREPENDS (front of compositing)", () => {
    const r = ok(apply({ op: "addTrack", args: { kind: "video", id: "v-new" } }, baseTl()));
    expect(r.state.tracks.video.map((t) => t.id)).toEqual(["v-new", "track-0"]);
    expect((r.state.tracks.video[0] as Track).items).toEqual([]);
  });

  it("addTrack(audio) APPENDS, hidden:true, inverse removeTrack drops it", () => {
    const original = baseTl();
    const r = ok(apply({ op: "addTrack", args: { kind: "audio", id: "a-new" } }, original));
    expect(r.state.tracks.audio.map((t) => t.id)).toEqual(["track-1", "a-new"]);
    expect((r.state.tracks.audio[1] as Track).hidden).toBe(true);
    expect(r.inverse).toEqual({ op: "removeTrack", args: { track: { trackId: "a-new" } } });
    const back = ok(apply(r.inverse, r.state));
    expect(back.state).toEqual(original);
  });

  it("removeTrack captures the full track + index; the inverse re-adds it exactly", () => {
    const original = timeline(VERTICAL, {
      video: [
        videoTrack(colorClip(60, "gold", { id: "v0" })),
        videoTrack(clip("/abs/b.mp4", { id: "v1", dur: 40 })),
      ],
    });
    const r = ok(
      apply({ op: "removeTrack", args: { track: { kind: "video", index: 1 } } }, original),
    );
    expect(r.state.tracks.video).toHaveLength(1);
    // Inverse is the internal _restoreTrack at the captured (kind, index).
    expect(r.inverse).toMatchObject({ op: "_restoreTrack", args: { kind: "video", index: 1 } });
    const back = ok(apply(r.inverse, r.state));
    expect(back.state).toEqual(original);
  });

  it("removeTrack reports the removed track's clips as removed content", () => {
    const r = ok(
      apply({ op: "removeTrack", args: { track: { kind: "audio", index: 0 } } }, baseTl()),
    );
    expect(r.consequences.clipsRemoved.map((c) => c.uuid)).toEqual(["a"]);
  });

  it("removeTrack unresolvable → typed track-not-found EditError", () => {
    const r = apply({ op: "removeTrack", args: { track: { kind: "video", index: 9 } } }, baseTl());
    expect((r as { kind: string }).kind).toBe("track-not-found");
  });
});

// ─── xmllint cleanliness on a written-out sample (Shotcut-openable) ───────────
// The op layer's emitted XML must be Shotcut-clean: no undeclared-prefix
// (`shotcut:`) attributes. We write a real result to disk and run xmllint over it
// (skipped automatically if xmllint isn't on PATH — the harness's namespace-aware
// parse already covers the same property in-process).
function xmllintAvailable(): boolean {
  try {
    execFileSync("xmllint", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("audio/filter/track op results are xmllint-clean", () => {
  const run = xmllintAvailable() ? it : it.skip;

  run("a gain + addFilter + addTrack result writes Shotcut-clean XML", () => {
    resetIds();
    let tl: Timeline = timeline(VERTICAL, {
      video: [videoTrack(colorClip(60, "gold", { id: "v" }))],
      audio: [audioTrack(clip("/abs/vo.wav", { id: "a", dur: 60 }))],
    });
    tl = ok(apply({ op: "gain", args: { uuid: "a", db: -6 } }, tl)).state;
    tl = ok(
      apply(
        {
          op: "addFilter",
          args: { uuid: "v", filter: { service: "sepia", properties: { u: 75 } } },
        },
        tl,
      ),
    ).state;
    tl = ok(apply({ op: "addTrack", args: { kind: "audio", id: "a2" } }, tl)).state;

    const xml = toMlt(tl);
    const dir = mkdtempSync(join(tmpdir(), "vean-aft-"));
    const path = join(dir, "out.mlt");
    writeFileSync(path, xml);
    // --noout: parse only; non-zero exit on any malformed/namespaced XML.
    expect(() => execFileSync("xmllint", ["--noout", path], { stdio: "pipe" })).not.toThrow();
  });
});
