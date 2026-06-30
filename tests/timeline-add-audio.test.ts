// timeline.addAudio — assert an audio clip is appended to an audio track with
// optional gain (dB → multiplier) and fades, that a missing audio track is
// created when allowed, and that the inverse sequence reconstructs the original.
import { describe, expect, it } from "vitest";
import { addAudio } from "../src/actions/timelineBuild";
import { audioTrack, clip, colorClip, resetIds, timeline, videoTrack } from "../src/ir/builder";
import { fromMlt } from "../src/ir/parse";
import { VERTICAL } from "../src/ir/profile";
import { toMlt } from "../src/ir/serialize";
import type { Clip, Timeline } from "../src/ir/types";
import { apply } from "../src/ops";
import { dbToGain } from "../src/ops/types";
import { isEditError } from "../src/ops/types";

function videoOnly(): Timeline {
  resetIds();
  return timeline(VERTICAL, { video: [videoTrack(colorClip(90, "blue", { id: "v" }))] });
}

function withAudio(): Timeline {
  resetIds();
  return timeline(VERTICAL, {
    video: [videoTrack(colorClip(90, "blue", { id: "v2" }))],
    audio: [audioTrack(clip("/abs/vo.wav", { id: "existing", dur: 30 }))],
  });
}

describe("timeline.addAudio", () => {
  it("appends to an existing audio track with gain (dB → multiplier) and fades", () => {
    const state = withAudio();
    const result = addAudio(state, {
      resource: "/abs/music.wav",
      durationFrames: 90,
      inFrame: 0,
      gainDb: -6,
      fadeIn: 6,
      fadeOut: 6,
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error(`unexpected error: ${JSON.stringify(result)}`);
    expect(result.createdTrack).toBe(false);
    const track = result.state.tracks.audio[0];
    if (!track) throw new Error("no audio track");
    // existing + appended music.
    expect(track.items).toHaveLength(2);
    const added = track.items[1] as Clip;
    expect(added.resource).toBe("/abs/music.wav");
    expect(added.out - added.in + 1).toBe(90);
    // -6 dB → ~0.501 multiplier.
    expect(added.gain).toBeCloseTo(dbToGain(-6), 6);
    // Fades are stored as sentinel filters the serializer resolves.
    const services = added.filters.map((f) => f.service);
    expect(services).toContain("vean.fadeIn");
    expect(services).toContain("vean.fadeOut");
  });

  it("creates an audio track when none exists and createTrackIfMissing is true", () => {
    const state = videoOnly();
    expect(state.tracks.audio).toHaveLength(0);
    const result = addAudio(state, {
      resource: "/abs/bed.wav",
      durationFrames: 60,
      inFrame: 0,
      createTrackIfMissing: true,
    });
    if (!("state" in result)) throw new Error("unexpected error");
    expect(result.createdTrack).toBe(true);
    expect(result.state.tracks.audio).toHaveLength(1);
    expect(result.state.tracks.audio[0]?.items).toHaveLength(1);
  });

  it("returns a typed precondition when no audio track and createTrackIfMissing is false", () => {
    const state = videoOnly();
    const result = addAudio(state, {
      resource: "/abs/bed.wav",
      durationFrames: 60,
      inFrame: 0,
      createTrackIfMissing: false,
    });
    expect("state" in result).toBe(false);
    if ("state" in result) return;
    expect(result.kind).toBe("precondition");
  });

  it("inverts exactly: applying the inverse reconstructs the original IR", () => {
    const original = videoOnly();
    const result = addAudio(original, {
      resource: "/abs/bed.wav",
      durationFrames: 60,
      inFrame: 0,
      gainDb: -3,
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

  // ─── uuid-collision regression (stable producer identity invariant) ──────────
  // `timeline.addAudio` runs as a ONE-SHOT CLI process: PARSE the .mlt, append one
  // clip, WRITE it back. A parsed track keeps its persisted id and consumes NO
  // authoring-counter slots, so the appended clip is the FIRST counter use —
  // `nextId('clip')` → `clip-0` — in every process (the counter resets to 0 per
  // run). Two sequential add-audio calls therefore used to mint TWO clips sharing
  // uuid `clip-0`, violating the AGENTS.md invariant "Identity = stable producer
  // UUIDs" and making the returned inverse `{op:_dropAppended, uuid:clip-0}` match
  // BOTH clips (undo of the second insert is then unsound). The fix mints a runtime-
  // unique `uuid()` per appended clip. We reproduce the two CLI processes FAITHFULLY
  // by serializing→parsing between appends (and resetIds() each "process"), which is
  // exactly the on-disk round-trip that exposes the collision.
  it("mints DISTINCT clip ids across two CLI processes (no clip-0 collision)", () => {
    // Seed on disk: a timeline with one empty audio track (the persisted .mlt).
    resetIds();
    const seedXml = toMlt(timeline(VERTICAL, { audio: [audioTrack()] }));

    // Process 1: PARSE the seed (counter at 0), append the first clip, WRITE.
    resetIds();
    const before1 = fromMlt(seedXml);
    const r1 = addAudio(before1, {
      resource: "/abs/a.wav",
      durationFrames: 30,
      inFrame: 0,
      createTrackIfMissing: false,
    });
    if (!("state" in r1)) throw new Error(`r1 error: ${JSON.stringify(r1)}`);
    const after1Xml = toMlt(r1.state);

    // Process 2: PARSE process 1's output (counter resets to 0 again), append a
    // SECOND clip to the now-one-clip track.
    resetIds();
    const before2 = fromMlt(after1Xml);
    const r2 = addAudio(before2, {
      resource: "/abs/b.wav",
      durationFrames: 30,
      inFrame: 0,
      createTrackIfMissing: false,
    });
    if (!("state" in r2)) throw new Error(`r2 error: ${JSON.stringify(r2)}`);

    const items = r2.state.tracks.audio[0]?.items ?? [];
    expect(items).toHaveLength(2);
    const [first, second] = items as [Clip, Clip];
    // The whole point: the two appended clips have DISTINCT ids (no shared clip-0).
    expect(first.id).not.toBe(second.id);
    // And neither is a deterministic authoring-counter id (they must be runtime
    // uuids — a `clip-N` id is precisely what collides across processes).
    expect(first.id.startsWith("clip-")).toBe(false);
    expect(second.id.startsWith("clip-")).toBe(false);

    // The second insert's inverse must UNAMBIGUOUSLY drop only the second clip,
    // reconstructing exactly the pre-second state (the `_dropAppended` precondition
    // checks the LAST item's id — with a shared clip-0 it would still match, but the
    // resulting state would carry the wrong surviving uuid; distinct ids make it
    // exact). Replay r2's inverse over r2's state → it must equal `before2`.
    let work = r2.state;
    for (const inv of r2.inverse) {
      const back = apply(inv, work);
      if (isEditError(back)) throw new Error(`r2 inverse step errored: ${JSON.stringify(back)}`);
      work = back.state;
    }
    expect(work).toEqual(before2);
  });
});
