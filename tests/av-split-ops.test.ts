// Behavior tests for the SPLIT EDIT ALGEBRA — detachAudio / reattachAudio /
// linkClips / unlinkClips, plus the link-awareness woven into move/trim/split/
// remove. The registry-driven op-invariant harness (tests/op-invariants.test.ts)
// already proves the five contract laws on each op's samples (purity, inverse,
// serialize round-trip, typed failure). THIS file locks the SEMANTICS the harness
// can't assert from a sample alone: the exact stream-selector shape a detach
// produces, that the auto-created link joins the pair, that a linked move shifts
// EVERY partner by the same delta, and that a one-sided trim/split/remove RECORDS a
// desync (record-don't-corrupt) rather than mangling the partner.
//
// Grounded in artifacts/research/shotcut-detach-audio-2026-07-01.md + DESIGN-UI.md
// §"Appendix: modeling linked A/V".
import { describe, expect, it } from "vitest";
import {
  type Clip,
  LANDSCAPE_2997,
  type Timeline,
  audioTrack,
  clip,
  hasAudio,
  resetIds,
  timeline,
  toMlt,
  videoTrack,
} from "../src/index";
import { apply, isEditError } from "../src/ops";
import type { EditError, OpResult } from "../src/ops";

// ─── helpers ──────────────────────────────────────────────────────────────────
/** A single A/V clip on V1 (no audio track yet) — the detach starting point. */
function avClip(): Timeline {
  resetIds();
  return timeline(LANDSCAPE_2997, {
    video: [videoTrack(clip("/abs/interview.mp4", { id: "av", dur: 90 }))],
  });
}

/** Force-narrow an OpResult (fail loudly on an unexpected EditError). */
function ok(r: OpResult | EditError): OpResult {
  if (isEditError(r)) throw new Error(`expected OpResult, got EditError: ${JSON.stringify(r)}`);
  return r;
}

/** Every clip in the timeline, flattened. */
function allClips(tl: Timeline): Clip[] {
  const out: Clip[] = [];
  for (const t of [...tl.tracks.video, ...tl.tracks.audio]) {
    for (const it of t.items) if (it.kind === "clip") out.push(it);
  }
  return out;
}

/** The rendered start frame of the clip `id` on its track (−1 if absent). */
function positionOf(tl: Timeline, id: string): number {
  for (const kind of ["video", "audio"] as const) {
    for (const t of tl.tracks[kind]) {
      let p = 0;
      for (const it of t.items) {
        if (it.kind === "clip" && it.id === id) return p;
        p += it.kind === "clip" ? it.out - it.in + 1 : it.kind === "blank" ? it.length : it.frames;
      }
    }
  }
  return -1;
}

function warnCodes(r: OpResult): string[] {
  return r.consequences.warnings.map((w) => w.code);
}

// ─── detachAudio ────────────────────────────────────────────────────────────────
describe("detachAudio — the one-way A/V split with a typed link", () => {
  it("splits into a video-only half (audio off, in place) + an audio-only half", () => {
    const r = ok(apply({ op: "detachAudio", args: { uuid: "av" } }, avClip()));
    const video = r.state.tracks.video[0]?.items[0] as Clip;
    const audio = r.state.tracks.audio[0]?.items[0] as Clip;

    // The video half KEEPS the original identity + slot, audio turned off (both the
    // absolute and relative selector, since the relative overrides — Shotcut's shape).
    expect(video.id).toBe("av");
    expect(video.streams).toMatchObject({ audioIndex: -1, astream: -1 });
    expect(hasAudio(video)).toBe(false);

    // The audio half is a fresh producer over the same window with VIDEO off.
    expect(audio.id).not.toBe("av");
    expect(audio.resource).toBe("/abs/interview.mp4");
    expect(audio.in).toBe(video.in);
    expect(audio.out).toBe(video.out);
    expect(audio.streams).toEqual({ videoIndex: -1, vstream: -1 });
    expect(hasAudio(audio)).toBe(true);
  });

  it("auto-creates a typed link joining the two halves (video ↔ audio roles)", () => {
    const r = ok(apply({ op: "detachAudio", args: { uuid: "av" } }, avClip()));
    const video = r.state.tracks.video[0]?.items[0] as Clip;
    const audio = r.state.tracks.audio[0]?.items[0] as Clip;

    expect(video.link?.role).toBe("video");
    expect(audio.link?.role).toBe("audio");
    expect(video.link?.id).toBe(audio.link?.id); // linked iff they share link.id
    expect(video.link?.partnerIds).toEqual([audio.id]);
    expect(audio.link?.partnerIds).toEqual([video.id]);
  });

  it("creates an audio track when none is blank across the span (reported)", () => {
    const before = avClip();
    expect(before.tracks.audio.length).toBe(0);
    const r = ok(apply({ op: "detachAudio", args: { uuid: "av" } }, before));
    expect(r.state.tracks.audio.length).toBe(1);
    expect(warnCodes(r)).toContain("audio-track-created");
    // The audio half landed on the created track at the clip's position (frame 0).
    const audioHalf = r.state.tracks.audio[0]?.items[0] as Clip;
    expect(positionOf(r.state, audioHalf.id)).toBe(0);
  });

  it("reuses an existing blank audio track (no new track) when the span is free", () => {
    resetIds();
    // A clip at frames [60,149] on V1; A1 already holds music at [0,39], so [60,149]
    // is a blank span on A1 → the audio half lands there, no track created.
    const state = timeline(LANDSCAPE_2997, {
      video: [
        videoTrack(
          clip("/abs/interview.mp4", { id: "gap", dur: 60 }),
          clip("/abs/interview.mp4", { id: "av", dur: 90 }),
        ),
      ],
      audio: [audioTrack(clip("/abs/music.wav", { id: "music", dur: 40 }))],
    });
    const r = ok(apply({ op: "detachAudio", args: { uuid: "av" } }, state));
    expect(r.state.tracks.audio.length).toBe(1); // no new track
    expect(warnCodes(r)).not.toContain("audio-track-created");
  });

  it("preserves a defaultAudioIndex reattach hint on the video half", () => {
    resetIds();
    const state = timeline(LANDSCAPE_2997, {
      video: [
        videoTrack(
          clip("/abs/multicam.mp4", {
            id: "mc",
            dur: 60,
            streams: { audioIndex: 1, defaultAudioIndex: 1 },
          }),
        ),
      ],
    });
    const r = ok(apply({ op: "detachAudio", args: { uuid: "mc" } }, state));
    const video = r.state.tracks.video[0]?.items[0] as Clip;
    expect(video.streams?.defaultAudioIndex).toBe(1); // survives for reattach
    expect(video.streams?.audioIndex).toBe(-1); // audio still turned off
  });

  it("refuses a clip with no audio to detach (typed precondition, not a throw)", () => {
    resetIds();
    const state = timeline(LANDSCAPE_2997, {
      video: [videoTrack(clip("/a.mp4", { id: "x", dur: 30, streams: { audioIndex: -1 } }))],
    });
    const r = apply({ op: "detachAudio", args: { uuid: "x" } }, state);
    expect(isEditError(r)).toBe(true);
    expect((r as { kind: string }).kind).toBe("precondition");
  });

  it("refuses to detach an already-linked clip (keeps the auto-link unambiguous)", () => {
    resetIds();
    const state = timeline(LANDSCAPE_2997, {
      video: [
        videoTrack(
          clip("/a.mp4", { id: "y", dur: 30, link: { id: "L", role: "video", partnerIds: ["z"] } }),
        ),
      ],
    });
    const r = apply({ op: "detachAudio", args: { uuid: "y" } }, state);
    expect(isEditError(r)).toBe(true);
    expect((r as { kind: string }).kind).toBe("precondition");
  });

  it("round-trips the detached state through parse → serialize (namespace-clean)", () => {
    const r = ok(apply({ op: "detachAudio", args: { uuid: "av" } }, avClip()));
    const xml = toMlt(r.state);
    // The typed link + selectors are on the wire and stable.
    expect(xml).toContain("vean:link");
    expect(xml).toContain("audio_index");
    expect(xml).toContain("video_index");
  });
});

// ─── reattachAudio ────────────────────────────────────────────────────────────
describe("reattachAudio — re-merge a detached pair back to one producer", () => {
  it("merges via EITHER half back into a single A/V clip, removing the created track", () => {
    const detached = ok(apply({ op: "detachAudio", args: { uuid: "av" } }, avClip()));
    for (const via of ["av", (detached.state.tracks.audio[0]?.items[0] as Clip).id]) {
      const r = ok(apply({ op: "reattachAudio", args: { uuid: via } }, detached.state));
      const merged = r.state.tracks.video[0]?.items[0] as Clip;
      expect(merged.id).toBe("av");
      expect(merged.streams).toBeUndefined(); // audio-off selectors cleared
      expect(merged.link).toBeUndefined(); // link dissolved
      expect(hasAudio(merged)).toBe(true); // audio decodes again
      expect(r.state.tracks.audio.length).toBe(0); // the created track is gone
    }
  });

  it("promotes a defaultAudioIndex hint back to the live audio_index on merge", () => {
    resetIds();
    const state = timeline(LANDSCAPE_2997, {
      video: [
        videoTrack(
          clip("/abs/interview.mp4", {
            id: "vid",
            dur: 90,
            streams: { audioIndex: -1, astream: -1, defaultAudioIndex: 2 },
            link: { id: "L0", role: "video", partnerIds: ["aud"] },
          }),
        ),
      ],
      audio: [
        audioTrack(
          clip("/abs/interview.mp4", {
            id: "aud",
            dur: 90,
            streams: { videoIndex: -1, vstream: -1 },
            link: { id: "L0", role: "audio", partnerIds: ["vid"] },
          }),
        ),
      ],
    });
    const r = ok(apply({ op: "reattachAudio", args: { uuid: "vid" } }, state));
    const merged = r.state.tracks.video[0]?.items[0] as Clip;
    expect(merged.streams).toEqual({ audioIndex: 2 }); // the hint became the live index
  });

  it("is the round-trip inverse of detachAudio (detach → reattach = the original)", () => {
    const original = avClip();
    const detached = ok(apply({ op: "detachAudio", args: { uuid: "av" } }, original));
    const back = ok(apply({ op: "reattachAudio", args: { uuid: "av" } }, detached.state));
    // The un-split original carries no selectors and no link — byte-identical XML.
    expect(toMlt(back.state)).toBe(toMlt(original));
  });

  it("refuses a clip that is not a detached half (no link)", () => {
    const r = apply({ op: "reattachAudio", args: { uuid: "av" } }, avClip());
    expect(isEditError(r)).toBe(true);
    expect((r as { kind: string }).kind).toBe("precondition");
  });

  it("KEEPS an audio track that carries other content, round-tripping the inverse", () => {
    // The audio half shares A1 with unrelated "music" — reattach must NOT strip the
    // track (only the audio half is removed), and the inverse re-inserts the half.
    resetIds();
    const state = timeline(LANDSCAPE_2997, {
      video: [
        videoTrack(
          clip("/i.mp4", {
            id: "vid",
            dur: 90,
            streams: { audioIndex: -1, astream: -1 },
            link: { id: "L", role: "video", partnerIds: ["aud"] },
          }),
        ),
      ],
      audio: [
        audioTrack(
          clip("/i.mp4", {
            id: "aud",
            dur: 90,
            streams: { videoIndex: -1, vstream: -1 },
            link: { id: "L", role: "audio", partnerIds: ["vid"] },
          }),
          clip("/music.wav", { id: "music", dur: 30 }),
        ),
      ],
    });
    const r = ok(apply({ op: "reattachAudio", args: { uuid: "vid" } }, state));
    expect(r.state.tracks.audio.length).toBe(1); // track survives
    expect(allClips(r.state).some((c) => c.id === "music")).toBe(true); // sibling survives
    // The inverse re-detaches onto the surviving track — byte-identical undo.
    const back = ok(apply(r.inverse, r.state));
    expect(toMlt(back.state)).toBe(toMlt(state));
  });
});

// ─── linkClips / unlinkClips ──────────────────────────────────────────────────
describe("linkClips / unlinkClips — the typed link primitives", () => {
  function pair(): Timeline {
    resetIds();
    return timeline(LANDSCAPE_2997, {
      video: [videoTrack(clip("/v.mp4", { id: "v", dur: 60 }))],
      audio: [audioTrack(clip("/a.wav", { id: "a", dur: 60 }))],
    });
  }

  it("links the anchor (first uuid → video role) to its partners (audio role)", () => {
    const r = ok(apply({ op: "linkClips", args: { uuids: ["v", "a"] } }, pair()));
    const v = r.state.tracks.video[0]?.items[0] as Clip;
    const a = r.state.tracks.audio[0]?.items[0] as Clip;
    expect(v.link?.role).toBe("video");
    expect(a.link?.role).toBe("audio");
    expect(v.link?.id).toBe(a.link?.id);
    expect(v.link?.partnerIds).toEqual(["a"]);
    expect(a.link?.partnerIds).toEqual(["v"]);
  });

  it("dissolves the WHOLE group when unlinking any one member (a group is atomic)", () => {
    const linked = ok(apply({ op: "linkClips", args: { uuids: ["v", "a"] } }, pair()));
    const r = ok(apply({ op: "unlinkClips", args: { uuids: ["v"] } }, linked.state));
    for (const c of allClips(r.state)) expect(c.link).toBeUndefined();
  });

  it("unlink on unlinked clips is a valid no-op (identity result)", () => {
    const r = ok(apply({ op: "unlinkClips", args: { uuids: ["v"] } }, pair()));
    for (const c of allClips(r.state)) expect(c.link).toBeUndefined();
  });

  it("captures + restores a prior link when re-linking a clip already in a group", () => {
    resetIds();
    const state = timeline(LANDSCAPE_2997, {
      video: [videoTrack(clip("/v.mp4", { id: "v", dur: 60 }))],
      audio: [
        audioTrack(
          clip("/a.wav", {
            id: "a",
            dur: 60,
            link: { id: "OLD", role: "audio", partnerIds: ["gone"] },
          }),
        ),
      ],
    });
    const r = ok(apply({ op: "linkClips", args: { uuids: ["v", "a"] } }, state));
    const a = r.state.tracks.audio[0]?.items[0] as Clip;
    expect(a.link?.id).not.toBe("OLD"); // re-linked into the new group
    // The inverse restores the exact prior link.
    const back = ok(apply(r.inverse, r.state));
    const a2 = back.state.tracks.audio[0]?.items[0] as Clip;
    expect(a2.link).toEqual({ id: "OLD", role: "audio", partnerIds: ["gone"] });
  });
});

// ─── Link-aware MOVE — shift every partner by the same delta ───────────────────
describe("move — link-aware: the whole linked unit shifts together", () => {
  function detached(): { state: Timeline; audioId: string; videoTrackId: string } {
    const r = ok(apply({ op: "detachAudio", args: { uuid: "av" } }, avClip()));
    return {
      state: r.state,
      audioId: (r.state.tracks.audio[0]?.items[0] as Clip).id,
      videoTrackId: r.state.tracks.video[0]?.id as string,
    };
  }

  it("moving the video half shifts the linked audio half by the same delta", () => {
    const { state, audioId, videoTrackId } = detached();
    const r = ok(
      apply(
        {
          op: "move",
          args: {
            uuid: "av",
            toTrack: { trackId: videoTrackId },
            toPosition: 30,
            ripple: false,
            rippleAllTracks: false,
          },
        },
        state,
      ),
    );
    expect(positionOf(r.state, "av")).toBe(30); // primary moved
    expect(positionOf(r.state, audioId)).toBe(30); // partner followed by the same delta
  });

  it("undo of a linked move restores BOTH halves to their origin", () => {
    const { state, audioId, videoTrackId } = detached();
    const fwd = ok(
      apply(
        {
          op: "move",
          args: {
            uuid: "av",
            toTrack: { trackId: videoTrackId },
            toPosition: 40,
            ripple: false,
            rippleAllTracks: false,
          },
        },
        state,
      ),
    );
    const back = ok(apply(fwd.inverse, fwd.state));
    expect(positionOf(back.state, "av")).toBe(0);
    expect(positionOf(back.state, audioId)).toBe(0);
    // A full deep-equality undo (the contract law, re-checked here for the pair).
    expect(back.state).toEqual(state);
  });

  it("refuses a linked move that would push a partner before frame 0", () => {
    // Two clips linked at DIFFERENT offsets: the anchor "lead" at frame 20, its
    // partner "follow" at frame 5 (both on their own video tracks). Moving the anchor
    // back to frame 0 (delta −20) would drive the partner to −15 — the guard rejects.
    resetIds();
    const state = timeline(LANDSCAPE_2997, {
      video: [
        videoTrack(clip("/lead.mp4", { id: "lead", dur: 30 })),
        videoTrack(
          clip("/pad.mp4", { id: "pad", dur: 5 }),
          clip("/follow.mp4", { id: "follow", dur: 30 }),
        ),
      ],
    });
    const linked = ok(apply({ op: "linkClips", args: { uuids: ["lead", "follow"] } }, state));
    // "lead" is at 20? No — it's at 0. Shift it to 20 first (linked move drags follow
    // from 5 to 25), so a subsequent move back to 0 would send follow to −20.
    const leadTrackId = linked.state.tracks.video[0]?.id as string;
    const shifted = ok(
      apply(
        {
          op: "move",
          args: {
            uuid: "lead",
            toTrack: { trackId: leadTrackId },
            toPosition: 20,
            ripple: false,
            rippleAllTracks: false,
          },
        },
        linked.state,
      ),
    );
    // follow is now at 25; move lead to 0 → delta −20 → follow would be 5 (fine).
    // Move lead to a position that drives follow negative: lead at 20→follow at 25,
    // so a delta of −30 (lead to −10) is impossible via toPosition≥0. Instead the
    // partner-negative case: follow starts LOWER than lead, so a big negative delta
    // on lead underflows follow first. lead@20, follow@25 → delta to reach follow=−1
    // needs lead=−6 (impossible). The reachable underflow: swap which is anchor.
    // Re-link with follow as anchor so lead (lower) is the partner.
    const relinked = ok(
      apply({ op: "linkClips", args: { uuids: ["follow", "lead"] } }, shifted.state),
    );
    // follow@25 (anchor), lead@20 (partner). Move follow to 4 → delta −21 → lead → −1.
    const followTrackId = relinked.state.tracks.video[1]?.id as string;
    const r = apply(
      {
        op: "move",
        args: {
          uuid: "follow",
          toTrack: { trackId: followTrackId },
          toPosition: 4,
          ripple: false,
          rippleAllTracks: false,
        },
      },
      relinked.state,
    );
    expect(isEditError(r)).toBe(true);
    expect((r as EditError).kind).toBe("frame-out-of-range");
  });
});

// ─── Link-aware TRIM / SPLIT / REMOVE — record the desync, don't corrupt ───────
describe("trim / split / remove — record a link desync (never silently corrupt)", () => {
  function detached(): Timeline {
    return ok(apply({ op: "detachAudio", args: { uuid: "av" } }, avClip())).state;
  }

  it("trimIn on one half flags a link-desync (the edit still applies correctly)", () => {
    const state = detached();
    const r = ok(
      apply({ op: "trimIn", args: { uuid: "av", delta: 10, rippleAllTracks: false } }, state),
    );
    expect(warnCodes(r)).toContain("link-desync");
    // The trim IS performed (the video half's in-point moved), the partner untouched.
    const video = allClips(r.state).find((c) => c.id === "av") as Clip;
    expect(video.in).toBe(10);
    const audio = allClips(r.state).find((c) => c.id !== "av") as Clip;
    expect(audio.in).toBe(0); // partner NOT mangled — just flagged
  });

  it("split on one half flags a link-desync", () => {
    const state = detached();
    const r = ok(apply({ op: "split", args: { uuid: "av", frame: 30 } }, state));
    expect(warnCodes(r)).toContain("link-desync");
    // The video track now has two halves; the audio partner is still one clip.
    expect(r.state.tracks.video[0]?.items.filter((i) => i.kind === "clip").length).toBe(2);
    expect(r.state.tracks.audio[0]?.items.filter((i) => i.kind === "clip").length).toBe(1);
  });

  it("remove on one half flags a link-desync (dangling partner)", () => {
    const state = detached();
    const r = ok(apply({ op: "remove", args: { uuid: "av", rippleAllTracks: false } }, state));
    expect(warnCodes(r)).toContain("link-desync");
    // The video half is gone; the audio partner survives (now dangling), not shredded.
    expect(r.state.tracks.video[0]?.items.some((i) => i.kind === "clip" && i.id === "av")).toBe(
      false,
    );
    expect(r.state.tracks.audio[0]?.items.some((i) => i.kind === "clip")).toBe(true);
  });

  it("an UNLINKED clip's trim/split/remove emit NO link-desync (zero overhead)", () => {
    resetIds();
    const state = timeline(LANDSCAPE_2997, {
      video: [videoTrack(clip("/plain.mp4", { id: "p", dur: 60 }))],
    });
    const tr = ok(
      apply({ op: "trimIn", args: { uuid: "p", delta: 5, rippleAllTracks: false } }, state),
    );
    expect(warnCodes(tr)).not.toContain("link-desync");
    const sp = ok(apply({ op: "split", args: { uuid: "p", frame: 30 } }, state));
    expect(warnCodes(sp)).not.toContain("link-desync");
    const rm = ok(apply({ op: "remove", args: { uuid: "p", rippleAllTracks: false } }, state));
    expect(warnCodes(rm)).not.toContain("link-desync");
  });
});
