// The dials catalog + dial-range diagnostic golden. Two halves, mirroring the
// diagnostics gate:
//   • the CATALOG is well-formed (Zod-valid, generated-from-melt + overrides, with
//     the curated bounds present and provenance stamped); the lookup/range API is
//     correct.
//   • the dial-range CHECK fires on a genuinely out-of-range knob (the exact code +
//     severity + location) and is SILENT on every valid case — in-range values,
//     unbounded dials, percent forms, animated envelopes, dB strings, and
//     un-catalogued services (the zero-false-positive bar the registry harness also
//     enforces over the clean corpus).
import { describe, expect, it } from "vitest";
import { collectDiagnostics } from "../src/diagnostics";
import { VERTICAL, clip, filter, resetIds, timeline, videoTrack } from "../src/index";
import { DIAL_CATALOG, checkScalar, dialCatalog, getDial, getService } from "../src/ir/dials";
import type { Timeline } from "../src/ir/types";

/** The dial-range codes a state produces. */
// The dial-range diagnostics produced by THIS checker specifically (`source:
// "dials"`). Scoping by source keeps these assertions independent of the legacy
// placeholder dial table that still lives in checks/media.ts (S1's scope) — which
// emits the same `dial-out-of-range` code with a coarser, soon-to-be-removed range
// (brightness max 4 vs the catalog's melt-published 15). See the stream's
// integration note: the lead removes that placeholder when S8 lands, leaving this
// catalog-backed checker the single authority on `dial-out-of-range`.
function dialDiags(tl: Timeline) {
  return collectDiagnostics(tl).filter(
    (d) => d.code === "dial-out-of-range" && d.source === "dials",
  );
}

function dialCodes(tl: Timeline): string[] {
  return dialDiags(tl).map((d) => d.code);
}

describe("dials catalog — generated from melt -query + overrides", () => {
  it("is a Zod-valid catalog", () => {
    expect(dialCatalog.safeParse(DIAL_CATALOG).success).toBe(true);
  });

  it("catalogs the services vean emits", () => {
    for (const id of ["brightness", "volume", "qtblend", "luma", "mix", "affine"]) {
      expect(getService(id), `service ${id} catalogued`).toBeDefined();
    }
  });

  it("brightness.level carries melt's published 0..15 range + a curated unit", () => {
    const level = getDial("brightness", "level");
    expect(level).toBeDefined();
    expect(level?.kind).toBe("float");
    expect(level?.min).toBe(0);
    expect(level?.max).toBe(15);
    expect(level?.unit).toBe("ratio");
    expect(level?.animation).toBe(true); // melt marks it animatable
  });

  it("brightness.alpha's one-sided melt range is COMPLETED by the override (source=override)", () => {
    const alpha = getDial("brightness", "alpha");
    expect(alpha?.min).toBe(-1); // melt-published floor
    expect(alpha?.max).toBe(1); // override-supplied ceiling
    expect(alpha?.source).toBe("override");
  });

  it("qtblend.compositing captures melt's enum values:", () => {
    const comp = getDial("qtblend", "compositing");
    expect(comp?.kind).toBe("integer");
    expect(comp?.options?.length ?? 0).toBeGreaterThan(2);
    expect(comp?.options?.[0]).toMatchObject({ value: 0, label: "source over" });
  });

  it("a deprecated knob is flagged, and its leaked '(*DEPRECATED*)' identifier is cleaned", () => {
    // melt leaks the marker into brightness `end`'s identifier; the generator
    // strips it to the bare property name and records `deprecated`.
    const end = getDial("brightness", "end");
    expect(end).toBeDefined();
    expect(end?.identifier).toBe("end");
    expect(end?.deprecated).toBe(true);
  });

  it("has no duplicate dial identifiers within a service", () => {
    for (const [svc, schema] of Object.entries(DIAL_CATALOG)) {
      const ids = schema.dials.map((d) => d.identifier);
      expect(new Set(ids).size, `service ${svc} has unique dial ids`).toBe(ids.length);
    }
  });
});

describe("checkScalar — the bounds primitive", () => {
  it("an in-range value is ok", () => {
    const level = getDial("brightness", "level");
    expect(level && checkScalar(level, 1).ok).toBe(true);
  });

  it("an over-max value reports the max bound + the violating value", () => {
    const level = getDial("brightness", "level");
    const v = level && checkScalar(level, 30);
    expect(v).toMatchObject({ ok: false, bound: "max", limit: 15, value: 30 });
  });

  it("a below-min value reports the min bound", () => {
    const alpha = getDial("brightness", "alpha");
    const v = alpha && checkScalar(alpha, -5);
    expect(v).toMatchObject({ ok: false, bound: "min", limit: -1 });
  });

  it("an ABSENT bound imposes no limit on that side (one-sided dial)", () => {
    // window has a curated min 0 but no max — a huge value is fine.
    const window = getDial("volume", "window");
    expect(window?.min).toBe(0);
    expect(window?.max).toBeUndefined();
    expect(window && checkScalar(window, 1_000_000).ok).toBe(true);
    expect(window && checkScalar(window, -1).ok).toBe(false); // below the min still fires
  });
});

describe("dial-range diagnostic — fires on a genuinely out-of-range knob", () => {
  it("a brightness level past 15 is a warning, located on the clip+filter", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "c",
            in: 0,
            out: 99,
            filters: [filter("brightness", { level: 30 })],
          }),
        ),
      ],
    });
    const d = dialDiags(tl)[0];
    expect(d).toBeDefined();
    expect(d?.severity).toBe("warning");
    expect(d?.source).toBe("dials");
    expect(d?.location.clip).toBe("c");
    expect(d?.location.filter).toBe(0);
    expect(d?.data).toMatchObject({
      service: "brightness",
      dial: "level",
      value: 30,
      bound: "max",
      limit: 15,
    });
  });

  it("an ANIMATED level whose peak exceeds the range fires (the whole envelope is checked)", () => {
    resetIds();
    const tl = timeline(VERTICAL, {
      // ramps 0 → 99 (way past max 15) over the clip.
      video: [
        videoTrack(
          clip("/a.mp4", {
            id: "c",
            in: 0,
            out: 99,
            filters: [filter("brightness", { level: "0=1;50=99" })],
          }),
        ),
      ],
    });
    const d = dialDiags(tl)[0];
    expect(d).toBeDefined();
    expect(d?.data).toMatchObject({ dial: "level", bound: "max", limit: 15, frame: 50 });
  });

  it("an out-of-range field transition knob fires, located on the transition", () => {
    resetIds();
    const tl: Timeline = {
      profile: VERTICAL,
      title: "t",
      tracks: {
        video: [videoTrack(clip("/a.mp4", { id: "a", in: 0, out: 49 }))],
        audio: [],
      },
      // mix.start is a curated 0..1 dial; 5 is out of range.
      transitions: [
        { service: "mix", aTrack: 0, bTrack: 1, in: 0, out: 10, properties: { start: 5 } },
      ],
    };
    const d = dialDiags(tl)[0];
    expect(d).toBeDefined();
    expect(d?.location.transition).toBe(0);
    expect(d?.data).toMatchObject({ dial: "start", value: 5, bound: "max", limit: 1 });
  });
});

describe("dial-range diagnostic — SILENT on every valid case (zero false positives)", () => {
  function clean(filters: ReturnType<typeof filter>[]): Timeline {
    resetIds();
    return timeline(VERTICAL, {
      video: [videoTrack(clip("/a.mp4", { id: "c", in: 0, out: 99, filters }))],
    });
  }

  it("an in-range brightness level is silent", () => {
    expect(dialCodes(clean([filter("brightness", { level: 1 })]))).toEqual([]);
  });

  it("a level at the exact max (15) is silent (inclusive bound)", () => {
    expect(dialCodes(clean([filter("brightness", { level: 15 })]))).toEqual([]);
  });

  it("an in-range animated level is silent", () => {
    expect(dialCodes(clean([filter("brightness", { level: "0=0;50=1;99=0" })]))).toEqual([]);
  });

  it("a percent value read in its 0..1 form against a 0..1 dial is silent", () => {
    // alpha is a 0..1-ceilinged dial; 50% = 0.5 is in range.
    expect(dialCodes(clean([filter("brightness", { alpha: "50%" })]))).toEqual([]);
  });

  it("a dB-string audio knob is NOT scalar-checked (no flat float bound)", () => {
    // volume.normalize ships as a dB string ("-12dBFS"); it has no numeric range
    // to violate, so the check leaves it alone.
    expect(dialCodes(clean([filter("volume", { normalize: "-200dBFS" })]))).toEqual([]);
  });

  it("an unbounded dial never fires regardless of magnitude", () => {
    // volume.level is an UNBOUNDED float (its dB/ratio semantics have no flat float
    // ceiling in the catalog) — a huge numeric value has no bound to violate.
    expect(dialCodes(clean([filter("volume", { level: 99999 })]))).toEqual([]);
  });

  it("an UN-catalogued service is skipped (no schema ⇒ no bound)", () => {
    expect(dialCodes(clean([filter("frei0r.glitch0r", { intensity: 999 })]))).toEqual([]);
  });

  it("a non-scalar (string/mode) property on a catalogued service is skipped", () => {
    // brightness.rgb_only is a boolean knob; a stray string doesn't trip the scalar check.
    expect(dialCodes(clean([filter("brightness", { rgb_only: "1" })]))).toEqual([]);
  });
});
