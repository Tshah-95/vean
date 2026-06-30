// import-with-provenance (S4 / roadmap T7 import-half) — the differentiator vs
// Palmier is that an imported clip's typed origin SURVIVES EXPORT. H2 proved the
// IR-level round-trip (tests/parse.test.ts); these tests prove the IMPORT PATH —
// the `importWithProvenance` helper and the `timeline.importWithProvenance` action
// — actually PIN the provenance and that it survives the full export round-trip
// (serialize → .mlt → parse) and re-emits byte-identically.
import { describe, expect, it } from "vitest";
import { importWithProvenance, normalizeImportProvenance } from "../src/actions/generate-import";
import { audioTrack, clip, colorClip, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { fromMlt } from "../src/ir/parse";
import { VERTICAL } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import { PROVENANCE_PROP_PREFIX } from "../src/ir/types";
import type { Clip, Provenance, Timeline } from "../src/ir/types";
import { apply } from "../src/ops";
import { isEditError } from "../src/ops/types";
import { isGraphicClip } from "../src/preview/proxy";

function withVideo(): Timeline {
  resetIds();
  return timeline(VERTICAL, { video: [videoTrack(colorClip(90, "blue", { id: "base" }))] });
}

function audioOnly(): Timeline {
  resetIds();
  return timeline(VERTICAL, { audio: [audioTrack(clip("/abs/vo.wav", { id: "vo", dur: 30 }))] });
}

const fullProvenance: Provenance = {
  source: "generative",
  model: "veo-3.1",
  prompt: "slow aerial push over a city skyline at dusk, no text",
  references: ["/abs/refs/mood-a.png", "/abs/refs/mood-b.png"],
  tool: "timeline.importWithProvenance",
  createdAt: "2026-06-30T12:00:00.000Z",
};

/** Find the (single) appended footage clip on the first video track. */
function appendedClip(state: Timeline): Clip {
  const track = state.tracks.video[0];
  if (!track) throw new Error("no video track");
  const last = track.items[track.items.length - 1];
  if (!last || last.kind !== "clip") throw new Error("last item is not a clip");
  return last;
}

describe("importWithProvenance (pure helper)", () => {
  it("PINS the full typed provenance onto the imported clip", () => {
    const result = importWithProvenance(withVideo(), {
      resource: "/abs/broll/skyline.mov",
      durationFrames: 120,
      inFrame: 0,
      provenance: fullProvenance,
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    const added = appendedClip(result.state);
    expect(added.resource).toBe("/abs/broll/skyline.mov");
    expect(added.provenance).toEqual(fullProvenance);
    // The reported clipId is the appended clip's stable id.
    expect(added.id).toBe(result.clipId);
  });

  it("SURVIVES EXPORT — provenance round-trips through serialize → .mlt → parse", () => {
    const result = importWithProvenance(withVideo(), {
      resource: "/abs/broll/skyline.mov",
      durationFrames: 120,
      inFrame: 0,
      provenance: fullProvenance,
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");

    // The export round-trip: IR → .mlt XML → IR'. The provenance must come back
    // byte-faithfully (this is exactly what Palmier's lossy export drops).
    const xml = toMlt(result.state);
    const reparsed = fromMlt(xml);
    expect(appendedClip(reparsed).provenance).toEqual(fullProvenance);

    // It rides as namespaced `vean:provenance.*` producer properties on the wire…
    expect(xml).toContain(`<property name="${PROVENANCE_PROP_PREFIX}source">generative</property>`);
    expect(xml).toContain(`<property name="${PROVENANCE_PROP_PREFIX}model">veo-3.1</property>`);
    expect(xml).toContain(
      `<property name="${PROVENANCE_PROP_PREFIX}references">/abs/refs/mood-a.png,/abs/refs/mood-b.png</property>`,
    );

    // …and re-emits byte-identically (fixpoint), so a second export tool that just
    // preserves unknown children never drifts the provenance.
    expect(toMlt(reparsed)).toBe(xml);
  });

  it("round-trips the minimal (source-only) provenance", () => {
    const result = importWithProvenance(withVideo(), {
      resource: "/abs/clip.mov",
      durationFrames: 30,
      inFrame: 0,
      provenance: { source: "import" },
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    const reparsed = fromMlt(toMlt(result.state));
    expect(appendedClip(reparsed).provenance).toEqual({ source: "import" });
  });

  it("does NOT label an imported clip a graphic (preview proxy keeps it as footage)", () => {
    const result = importWithProvenance(withVideo(), {
      resource: "/abs/clip.mov",
      durationFrames: 30,
      inFrame: 0,
      provenance: { source: "generative" },
      label: "graphic:sneaky",
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    const added = appendedClip(result.state);
    expect(isGraphicClip(added)).toBe(false);
    expect(added.label).toBe("footage");
  });

  it("creates a video track when none exists and createTrackIfMissing is true", () => {
    const state = audioOnly();
    expect(state.tracks.video).toHaveLength(0);
    const result = importWithProvenance(state, {
      resource: "/abs/clip.mov",
      durationFrames: 60,
      inFrame: 0,
      provenance: { source: "generative", model: "kling-3.0" },
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    expect(result.createdTrack).toBe(true);
    expect(result.state.tracks.video).toHaveLength(1);
    expect(appendedClip(result.state).provenance).toEqual({
      source: "generative",
      model: "kling-3.0",
    });
  });

  it("returns a typed precondition when no video track and createTrackIfMissing is false", () => {
    const result = importWithProvenance(audioOnly(), {
      resource: "/abs/clip.mov",
      durationFrames: 60,
      inFrame: 0,
      provenance: { source: "generative" },
      createTrackIfMissing: false,
    });
    expect("state" in result).toBe(false);
    if ("state" in result) return;
    expect(result.kind).toBe("precondition");
  });

  it("rejects a malformed provenance source loudly (before any IR is built)", () => {
    expect(() =>
      importWithProvenance(withVideo(), {
        resource: "/abs/clip.mov",
        durationFrames: 30,
        inFrame: 0,
        // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid for the loud-failure check.
        provenance: { source: "hallucinated" } as any,
        createTrackIfMissing: true,
      }),
    ).toThrow();
  });

  it("inverts exactly: applying the inverse reconstructs the original IR", () => {
    const original = audioOnly();
    const result = importWithProvenance(original, {
      resource: "/abs/clip.mov",
      durationFrames: 60,
      inFrame: 0,
      provenance: fullProvenance,
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    let work = result.state;
    for (const inv of result.inverse) {
      const back = apply(inv, work);
      if (isEditError(back)) throw new Error(`inverse step errored: ${JSON.stringify(back)}`);
      work = back.state;
    }
    expect(work).toEqual(original);
  });
});

// The action's `execute` resolves a timeline target + writes through the state
// layer, which dynamically loads `bun:sqlite`-backed modules vitest can't load —
// so the action surface's provenance-stamping logic is factored into the pure,
// clock-injected `normalizeImportProvenance`, verified here. (The discovery/CLI
// projection of the registered action is covered by the registry tests once the
// commented registration block in src/actions/registry.ts is enabled by the lead.)
describe("normalizeImportProvenance (action stamping)", () => {
  const NOW = "2026-06-30T09:30:00.000Z";

  it("stamps the producing tool + a (clock-injected) createdAt when omitted", () => {
    const out = normalizeImportProvenance(
      {
        source: "generative",
        model: "veo-3.1",
        prompt: "city skyline at dusk, no text",
        references: ["/abs/refs/mood.png"],
      },
      NOW,
    );
    expect(out).toEqual({
      source: "generative",
      model: "veo-3.1",
      prompt: "city skyline at dusk, no text",
      references: ["/abs/refs/mood.png"],
      tool: "timeline.importWithProvenance",
      createdAt: NOW,
    });
  });

  it("defaults the source to `generative` (the posture this action exists for)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: exercising the source default on an input without `source`.
    const out = normalizeImportProvenance({} as any, NOW);
    expect(out.source).toBe("generative");
  });

  it("never overwrites a caller-supplied tool or createdAt", () => {
    const out = normalizeImportProvenance(
      { source: "import", tool: "my-cli", createdAt: "2020-01-01T00:00:00.000Z" },
      NOW,
    );
    expect(out.tool).toBe("my-cli");
    expect(out.createdAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("produces a Provenance that survives export through an imported clip", () => {
    // The stamped provenance, when imported, round-trips through serialize→parse —
    // closing the loop between the action's stamping and the export-survival proof.
    const provenance = normalizeImportProvenance({ source: "generative", model: "kling-3.0" }, NOW);
    const result = importWithProvenance(withVideo(), {
      resource: "/abs/broll/atmos.mov",
      durationFrames: 48,
      inFrame: 0,
      provenance,
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    expect(appendedClip(fromMlt(toMlt(result.state))).provenance).toEqual(provenance);
  });
});
