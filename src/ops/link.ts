// The A/V-split edit algebra — detachAudio + reattachAudio + linkClips +
// unlinkClips. This is vean's answer to Shotcut's "Detach Audio", but BETTER than
// the spec: where Shotcut leaves two independent producers that silently desync on
// any trim (see artifacts/research/shotcut-detach-audio-2026-07-01.md +
// DESIGN-UI.md §"Appendix: modeling linked A/V"), vean auto-creates a TYPED LINK
// joining the pair so the diagnostics + link-aware ops can keep them in sync.
//
// Shotcut mechanics we lift (`DetachAudioCommand::redo`):
//   1. Two producers from the same file: a VIDEO-ONLY clip (audio off:
//      audio_index=-1 + astream=-1) that stays on the original track, and an
//      AUDIO-ONLY clip (video off: video_index=-1 + vstream=-1).
//   2. Find an audio track blank across the clip's span; else create one.
//   3. Overwrite the audio-only clip onto that track at the same position; the
//      video half keeps its slot with the audio selectors turned off.
//   4. `shotcut:defaultAudioIndex` is preserved on the video half for reattach.
// vean adds: a typed `link { id, role, partnerIds }` on both halves (5).
//
// Purity + inverse (contract laws): every op clones the input and returns a
// fully-specified inverse invocation. detachAudio's inverse is the internal
// `_reattachAudio` restore op (re-merge to the single producer, remove any created
// track); linkClips/unlinkClips invert by capturing every clip's prior `link` and
// restoring it via the internal `_restoreLinks` op.
import { z } from "zod";
import { uuid } from "../ir/builder";
import { clipLinkSchema, clipSchema, hasAudio, trackSchema } from "../ir/types";
import type { Clip, ClipLink, Item, StreamSelectors, Timeline, Track } from "../ir/types";
import {
  type ClipLocation,
  clipTouchesDissolve,
  cloneTimeline,
  consolidateBlanks,
  findAudioTrackWithBlank,
  findClip,
  findLinkedPartners,
  insertEntryAt,
  playtime,
} from "./primitives";
import {
  type DetachAudioArgs,
  type EditError,
  type LinkClipsArgs,
  type Op,
  type OpResult,
  type ReattachAudioArgs,
  type UnlinkClipsArgs,
  type Uuid,
  detachAudioArgs,
  editError,
  linkClipsArgs,
  noConsequences,
  reattachAudioArgs,
  unlinkClipsArgs,
} from "./types";

// ─── detachAudio ──────────────────────────────────────────────────────────────
export const detachAudio: Op<DetachAudioArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  // Guard: only a clip that DECODES audio can have it detached (Shotcut enables the
  // gesture iff `audio_index >= 0`). `hasAudio` is selector-derived, so an already
  // detached video-only half (audio_index=-1) is correctly refused.
  if (!hasAudio(loc.clip)) {
    return editError({
      kind: "precondition",
      detail: `detachAudio: clip "${args.uuid}" has no audio to detach (audio is already off)`,
    });
  }
  // Guard: detaching a clip that's ALREADY linked would entangle two link groups;
  // require it be free first (unlink/reattach, then detach). Keeps the auto-created
  // link unambiguous (exactly the A/V pair, never a merge of prior groups).
  if (loc.clip.link != null) {
    return editError({
      kind: "precondition",
      detail: `detachAudio: clip "${args.uuid}" is already in a link group — unlink it first`,
    });
  }
  // Guard: a dissolve-bound clip can't be split cleanly (the video half would keep
  // its dissolve, but detaching mid-transition is out of scope — reject like move/lift).
  const srcItems = (state.tracks[loc.trackKind][loc.trackIndex] as Track).items;
  if (clipTouchesDissolve(srcItems, loc.itemIndex)) {
    return editError({
      kind: "precondition",
      detail: `detachAudio: clip "${args.uuid}" participates in a dissolve — remove the dissolve first`,
    });
  }

  const original: Clip = structuredClone(loc.clip); // captured for the inverse
  const len = playtime(loc.clip);
  const linkId = `link-${uuid()}`;
  const audioId = uuid();
  const videoId = loc.clip.id; // the video half KEEPS the original identity

  // ── The video-only half (audio off) — stays in place, keeps its uuid. ──
  // Merge the audio-off selectors onto any existing stream selectors, preserving a
  // `defaultAudioIndex` reattach hint if the source carried one.
  const videoStreams: StreamSelectors = {
    ...(loc.clip.streams ?? {}),
    audioIndex: -1,
    astream: -1,
  };
  const videoLink: ClipLink = { id: linkId, role: "video", partnerIds: [audioId] };

  // ── The audio-only half (video off) — fresh uuid, same window. ──
  const audioStreams: StreamSelectors = { videoIndex: -1, vstream: -1 };
  const audioLink: ClipLink = { id: linkId, role: "audio", partnerIds: [videoId] };
  const audioClip: Clip = {
    ...structuredClone(loc.clip),
    id: audioId,
    streams: audioStreams,
    link: audioLink,
  };

  const next = cloneTimeline(state);
  const c = noConsequences();

  // Set the video half's selectors + link in place (identity + slot unchanged).
  const vItems = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items;
  const vClip = vItems[loc.itemIndex] as Extract<Item, { kind: "clip" }>;
  vClip.streams = videoStreams;
  vClip.link = videoLink;

  // ── Find (or create) an audio track blank across the clip's span. ──
  let audioIndex = findAudioTrackWithBlank(next, loc.position, len);
  let createdTrackId: string | undefined;
  if (audioIndex < 0) {
    // No blank audio track for this span → add one (reported in consequences).
    createdTrackId = uuid();
    const track: Track = {
      kind: "audio",
      id: createdTrackId,
      name: `A${next.tracks.audio.length + 1}`,
      items: [],
      hidden: true,
    };
    next.tracks.audio.push(track);
    audioIndex = next.tracks.audio.length - 1;
  }
  const audioTrackObj = next.tracks.audio[audioIndex] as Track;

  // Overwrite the audio-only clip onto the (blank) span — insertEntryAt splits any
  // covering blank at the boundary and pads to `position` past the track end.
  const { items: placed } = insertEntryAt(audioTrackObj.items, loc.position, audioClip);
  audioTrackObj.items = consolidateBlanks(placed);

  // ── Consequences ──
  c.clipsAdded.push({
    uuid: audioId,
    track: audioTrackObj.id,
    position: loc.position,
    playtime: len,
  });
  if (createdTrackId != null) {
    // Report the track creation as a warning so the surface can mention it (the
    // structural "track added" fact — there is no dedicated tracksAdded field).
    c.warnings.push({
      code: "audio-track-created",
      detail: `detachAudio: no blank audio track for [${loc.position},${loc.position + len}); created "${audioTrackObj.id}"`,
    });
  }
  c.durationDelta = 0; // the video half keeps its slot; the audio lands on a blank span

  return {
    state: next,
    consequences: c,
    inverse: {
      op: "_reattachAudio",
      args: {
        audioUuid: audioId,
        videoUuid: videoId,
        original,
        createdTrackId: createdTrackId ?? null,
      },
    },
  };
};

// ─── _reattachAudio — the internal inverse (re-merge to one producer) ──────────
// Removes the audio-only half, restores the captured original video clip in place
// (its pre-detach streams/link, which are typically undefined), and removes the
// audio track iff `detachAudio` created it (it's now empty). Self-contained so
// detachAudio's inverse-invariant passes now. Its own inverse is a `detachAudio`
// of the restored clip, so undo-of-undo round-trips.
export const reattachAudioInternalArgs = z.object({
  audioUuid: z.string().min(1),
  videoUuid: z.string().min(1),
  original: clipSchema,
  createdTrackId: z.string().nullable(),
});
export type ReattachAudioInternalArgs = z.infer<typeof reattachAudioInternalArgs>;

export const reattachAudioInternal: Op<ReattachAudioInternalArgs> = (
  state,
  args,
): OpResult | EditError => {
  const audio = findClip(state, args.audioUuid);
  if (!audio) return editError({ kind: "clip-not-found", uuid: args.audioUuid });
  const video = findClip(state, args.videoUuid);
  if (!video) return editError({ kind: "clip-not-found", uuid: args.videoUuid });

  const next = cloneTimeline(state);
  const c = noConsequences();

  // ── Remove the audio-only half (swap its entry for a same-length blank, then
  // consolidate — the exact `lift` shape, but we may drop the whole track below). ──
  const aTrack = next.tracks[audio.trackKind][audio.trackIndex] as Track;
  const aLen = playtime(audio.clip);
  const withoutAudio = [...aTrack.items];
  withoutAudio.splice(audio.itemIndex, 1);
  aTrack.items = consolidateBlanks(withoutAudio);
  c.clipsRemoved.push({
    uuid: args.audioUuid,
    track: aTrack.id,
    position: audio.position,
    playtime: aLen,
  });

  // ── Restore the captured original video clip in place (its streams/link as they
  // were before detach — typically both undefined). ──
  const vLoc = findClip(next, args.videoUuid) as ClipLocation;
  const vItems = (next.tracks[vLoc.trackKind][vLoc.trackIndex] as Track).items;
  vItems.splice(vLoc.itemIndex, 1, structuredClone(args.original));

  // ── Remove the audio track iff detachAudio created it (now empty). ──
  if (args.createdTrackId != null) {
    const idx = next.tracks.audio.findIndex((t) => t.id === args.createdTrackId);
    if (idx >= 0 && (next.tracks.audio[idx] as Track).items.length === 0) {
      next.tracks.audio.splice(idx, 1);
    }
  }

  c.durationDelta = 0;

  return {
    state: next,
    consequences: c,
    // Undo-of-undo: re-detach the restored clip.
    inverse: { op: "detachAudio", args: { uuid: args.videoUuid } },
  };
};

// ─── reattachAudio — the public convenience inverse ───────────────────────────
// Re-merge a detached A/V pair back into one producer, addressed by EITHER half.
// Resolves the link group, locates the video + audio halves by role, and produces
// the same result as detachAudio's inverse — but as a first-class agent op (so a
// user can "reattach" without holding the detach's inverse invocation). Its own
// inverse is a `detachAudio` of the merged clip.
export const reattachAudio: Op<ReattachAudioArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  const link = loc.clip.link;
  if (link == null) {
    return editError({
      kind: "precondition",
      detail: `reattachAudio: clip "${args.uuid}" is not a detached A/V half (no link)`,
    });
  }

  // Locate both halves by role across the shared link group.
  const partners = findLinkedPartners(state, loc.clip);
  const all = [loc, ...partners];
  const videoLoc = all.find((l) => l.clip.link?.role === "video");
  const audioLoc = all.find((l) => l.clip.link?.role === "audio");
  if (!videoLoc || !audioLoc) {
    return editError({
      kind: "precondition",
      detail: `reattachAudio: link group "${link.id}" is not a video/audio pair (need one of each role)`,
    });
  }

  // The merged clip = the video half with its audio selectors + link cleared, and
  // the `defaultAudioIndex` reattach hint (if present) promoted back to the live
  // `audio_index` so the audio decodes again. Everything else (resource, window,
  // filters, gain) rides through unchanged.
  const merged = mergeReattached(videoLoc.clip);

  // Capture the audio track's PRE-merge identity (name/hidden/id + index) so the
  // inverse restores it byte-exactly — whether it survives (still holds other
  // content) or is dropped (was audio-half-only).
  const preTrack: Track = structuredClone(
    state.tracks[audioLoc.trackKind][audioLoc.trackIndex] as Track,
  );
  const preTrackIndex = audioLoc.trackIndex;

  const next = cloneTimeline(state);
  const c = noConsequences();

  // Remove the audio-only half.
  const aTrack = next.tracks[audioLoc.trackKind][audioLoc.trackIndex] as Track;
  const aLen = playtime(audioLoc.clip);
  const audioWasOnlyItem =
    aTrack.items.filter((it) => it.kind === "clip").length === 1 &&
    (aTrack.items.find((it) => it.kind === "clip") as Clip | undefined)?.id === audioLoc.clip.id;
  const withoutAudio = [...aTrack.items];
  withoutAudio.splice(audioLoc.itemIndex, 1);
  aTrack.items = consolidateBlanks(withoutAudio);
  c.clipsRemoved.push({
    uuid: audioLoc.clip.id,
    track: aTrack.id,
    position: audioLoc.position,
    playtime: aLen,
  });

  // Replace the video half in place with the merged clip.
  const vLoc = findClip(next, videoLoc.clip.id) as ClipLocation;
  const vItems = (next.tracks[vLoc.trackKind][vLoc.trackIndex] as Track).items;
  vItems.splice(vLoc.itemIndex, 1, structuredClone(merged));

  // Remove the audio track iff the merge left it empty AND the audio half was its
  // only content (don't strip a track carrying unrelated clips).
  let trackRemoved = false;
  if (audioWasOnlyItem) {
    const idx = next.tracks.audio.findIndex((t) => t.id === aTrack.id);
    if (idx >= 0 && (next.tracks.audio[idx] as Track).items.length === 0) {
      trackRemoved = true;
      next.tracks.audio.splice(idx, 1);
    }
  }

  c.durationDelta = 0;

  return {
    state: next,
    consequences: c,
    // Exact inverse: re-detach into the same two halves. `_redetachAudio` captures
    // the original video half AND the audio track VERBATIM (its id/name/hidden +
    // index), so it either splices the captured track back (when reattach dropped
    // it) or re-inserts the audio half onto the surviving track — byte-exact undo.
    inverse: {
      op: "_redetachAudio",
      args: {
        videoUuid: videoLoc.clip.id,
        originalVideo: structuredClone(videoLoc.clip),
        audioClip: structuredClone(audioLoc.clip),
        audioTrack: preTrack,
        audioTrackIndex: preTrackIndex,
        audioPosition: audioLoc.position,
        trackRemoved,
      },
    },
  };
};

/** The single-producer merge of a detached video half: clear the audio-off stream
 *  selectors + the link, and promote a `defaultAudioIndex` hint back to the live
 *  `audio_index`. If no non-selector data remains, `streams` is dropped entirely
 *  (so the merged clip is byte-identical to an un-split one — zero A/V-split bytes). */
function mergeReattached(videoHalf: Clip): Clip {
  const merged: Clip = structuredClone(videoHalf);
  const s = merged.streams;
  if (s != null) {
    const restored: StreamSelectors = { ...s };
    // Turn audio back on: drop the -1 markers; promote the reattach hint to live.
    restored.audioIndex = restored.defaultAudioIndex ?? undefined;
    restored.astream = undefined;
    restored.defaultAudioIndex = undefined;
    // Prune undefined keys so an all-cleared selector set becomes `undefined`.
    const kept: StreamSelectors = {};
    let any = false;
    for (const [k, v] of Object.entries(restored) as [
      keyof StreamSelectors,
      number | undefined,
    ][]) {
      if (v != null) {
        kept[k] = v;
        any = true;
      }
    }
    merged.streams = any ? kept : undefined;
  }
  merged.link = undefined;
  return merged;
}

// ─── _redetachAudio — reattachAudio's exact inverse (re-split, restore track) ──
// Re-detaches the merged clip into the captured video/audio halves. It captures the
// audio track VERBATIM (its id/name/hidden) + its index, so it restores that exact
// track — splicing the whole captured track back when reattach dropped it (empty),
// or re-inserting the audio half onto the surviving track otherwise. Self-contained
// so reattachAudio round-trips byte-for-byte. Its own inverse is a `reattachAudio`.
export const redetachAudioArgs = z.object({
  videoUuid: z.string().min(1),
  originalVideo: clipSchema,
  audioClip: clipSchema,
  audioTrack: trackSchema,
  audioTrackIndex: z.number().int(),
  audioPosition: z.number().int().nonnegative(),
  trackRemoved: z.boolean(),
});
export type RedetachAudioArgs = z.infer<typeof redetachAudioArgs>;

export const redetachAudio: Op<RedetachAudioArgs> = (state, args): OpResult | EditError => {
  const vLocPre = findClip(state, args.videoUuid);
  if (!vLocPre) return editError({ kind: "clip-not-found", uuid: args.videoUuid });

  const next = cloneTimeline(state);
  const c = noConsequences();

  // Restore the video half (its detached streams/link).
  const vLoc = findClip(next, args.videoUuid) as ClipLocation;
  const vItems = (next.tracks[vLoc.trackKind][vLoc.trackIndex] as Track).items;
  vItems.splice(vLoc.itemIndex, 1, structuredClone(args.originalVideo));

  if (args.trackRemoved) {
    // Reattach had DROPPED the whole audio track (it was audio-half-only) — splice
    // the captured track back at its exact index (verbatim id/name/hidden + the
    // audio half it carried). `structuredClone` restores the audio half with it.
    const idx = Math.min(Math.max(args.audioTrackIndex, 0), next.tracks.audio.length);
    next.tracks.audio.splice(idx, 0, structuredClone(args.audioTrack));
  } else {
    // The track survived (it held other content) — re-insert the audio half onto it.
    const track = next.tracks.audio.find((t) => t.id === args.audioTrack.id);
    if (!track) return editError({ kind: "track-not-found", track: args.audioTrack.id });
    const { items: placed } = insertEntryAt(
      track.items,
      args.audioPosition,
      structuredClone(args.audioClip),
    );
    track.items = consolidateBlanks(placed);
  }

  c.clipsAdded.push({
    uuid: args.audioClip.id,
    track: args.audioTrack.id,
    position: args.audioPosition,
    playtime: playtime(args.audioClip),
  });
  c.durationDelta = 0;

  return {
    state: next,
    consequences: c,
    inverse: { op: "reattachAudio", args: { uuid: args.videoUuid } },
  };
};

// ─── linkClips ────────────────────────────────────────────────────────────────
// Join ≥2 clips into one typed link group. The first uuid is the anchor (role
// `video`); the rest are role `audio` (partners). A clip already in a link group is
// captured (its prior link) and re-linked. Inverse: `_restoreLinks` restores every
// touched clip's prior `link` (undefined if it had none).
export const linkClips: Op<LinkClipsArgs> = (state, args): OpResult | EditError => {
  // Resolve every uuid up front (a missing one is a typed error before mutation).
  const locs: ClipLocation[] = [];
  for (const id of args.uuids) {
    const loc = findClip(state, id);
    if (!loc) return editError({ kind: "clip-not-found", uuid: id });
    locs.push(loc);
  }
  // De-dupe while preserving order (linking a clip to itself is a no-op member).
  const ordered: string[] = [];
  for (const id of args.uuids) if (!ordered.includes(id)) ordered.push(id);
  if (ordered.length < 2) {
    return editError({
      kind: "invalid-args",
      detail: `linkClips: need ≥2 distinct clips, got ${ordered.length}`,
    });
  }

  const linkId = `link-${uuid()}`;
  const next = cloneTimeline(state);
  const c = noConsequences();

  // Capture each clip's PRIOR link for the inverse, then set the new one.
  const prior: Array<{ uuid: Uuid; link: ClipLink | null }> = [];
  for (let i = 0; i < ordered.length; i++) {
    const id = ordered[i] as string;
    const loc = findClip(next, id) as ClipLocation;
    const item = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items[
      loc.itemIndex
    ] as Extract<Item, { kind: "clip" }>;
    prior.push({ uuid: id, link: item.link ?? null });
    const role: "video" | "audio" = i === 0 ? "video" : "audio";
    item.link = { id: linkId, role, partnerIds: ordered.filter((o) => o !== id) };
  }

  return {
    state: next,
    consequences: c,
    inverse: { op: "_restoreLinks", args: { links: prior } },
  };
};

// ─── unlinkClips ──────────────────────────────────────────────────────────────
// Dissolve the FULL link group of each named clip: clear `link` on every member
// (a group is atomic — unlinking one member unlinks all). Inverse: `_restoreLinks`.
export const unlinkClips: Op<UnlinkClipsArgs> = (state, args): OpResult | EditError => {
  // Collect the full set of link ids to dissolve (from the named clips).
  const linkIds = new Set<string>();
  for (const id of args.uuids) {
    const loc = findClip(state, id);
    if (!loc) return editError({ kind: "clip-not-found", uuid: id });
    if (loc.clip.link != null) linkIds.add(loc.clip.link.id);
  }

  const next = cloneTimeline(state);
  const c = noConsequences();
  const prior: Array<{ uuid: Uuid; link: ClipLink | null }> = [];

  if (linkIds.size === 0) {
    // Nothing linked — a valid identity result (so callers compose without a special
    // case). The inverse is a no-op `_restoreLinks`.
    return { state: next, consequences: c, inverse: { op: "_restoreLinks", args: { links: [] } } };
  }

  // Clear `link` on every clip whose group is being dissolved.
  for (const kind of ["video", "audio"] as const) {
    for (const track of next.tracks[kind]) {
      for (const it of track.items) {
        if (it.kind === "clip" && it.link != null && linkIds.has(it.link.id)) {
          prior.push({ uuid: it.id, link: structuredClone(it.link) });
          it.link = undefined;
        }
      }
    }
  }

  return {
    state: next,
    consequences: c,
    inverse: { op: "_restoreLinks", args: { links: prior } },
  };
};

// ─── _restoreLinks — the shared inverse of linkClips / unlinkClips ─────────────
// Restore each captured clip's `link` (or clear it when the captured value is
// null). Idempotent-shaped and self-inverting: its own inverse re-captures the
// CURRENT link of each named clip, so undo-of-undo round-trips.
export const restoreLinksArgs = z.object({
  links: z
    .array(z.object({ uuid: z.string().min(1), link: clipLinkSchema.nullable() }))
    .default([]),
});
export type RestoreLinksArgs = z.infer<typeof restoreLinksArgs>;

export const restoreLinks: Op<RestoreLinksArgs> = (state, args): OpResult | EditError => {
  const next = cloneTimeline(state);
  const c = noConsequences();
  const prior: Array<{ uuid: Uuid; link: ClipLink | null }> = [];

  for (const entry of args.links) {
    const loc = findClip(next, entry.uuid);
    if (!loc) return editError({ kind: "clip-not-found", uuid: entry.uuid });
    const item = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items[
      loc.itemIndex
    ] as Extract<Item, { kind: "clip" }>;
    prior.push({ uuid: entry.uuid, link: item.link ?? null });
    item.link = entry.link ?? undefined;
  }

  return {
    state: next,
    consequences: c,
    inverse: { op: "_restoreLinks", args: { links: prior } },
  };
};

export { detachAudioArgs, reattachAudioArgs, linkClipsArgs, unlinkClipsArgs };

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { audioTrack, clip, resetIds, timeline, videoTrack } from "../ir/builder";
import { LANDSCAPE_2997, VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samplesDetachAudio: OpSample<DetachAudioArgs>[] = [
  {
    // The canonical detach: one A/V clip on V1, no audio track yet → detach creates
    // A1, drops the audio-only half there, video half keeps its slot + audio off.
    name: "detach audio from an A/V clip (creates an audio track for the audio half)",
    state: (): Timeline => {
      resetIds();
      return timeline(LANDSCAPE_2997, {
        video: [videoTrack(clip("/abs/interview.mp4", { id: "av", dur: 90 }))],
      });
    },
    args: { uuid: "av" },
  },
  {
    // Detach onto an EXISTING blank audio-track span → no new track created. The AV
    // clip plays [60,149] on V1 (after a 60f lead); A1 holds music at [0,39], so
    // A1's [60,149] is blank → the audio half lands there (exercises find-blank reuse).
    name: "detach audio onto an existing blank audio-track span (no track created)",
    state: (): Timeline => {
      resetIds();
      return timeline(LANDSCAPE_2997, {
        video: [
          videoTrack(
            clip("/abs/interview.mp4", { id: "lead", dur: 60 }),
            clip("/abs/interview.mp4", { id: "av", dur: 90 }),
          ),
        ],
        audio: [audioTrack(clip("/abs/music.wav", { id: "music", dur: 40 }))],
      });
    },
    args: { uuid: "av" },
  },
  {
    // Detach preserving a `defaultAudioIndex` reattach hint on a source that already
    // carries stream selectors — the hint rides onto the video half.
    name: "detach audio preserving a defaultAudioIndex reattach hint",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
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
    },
    args: { uuid: "mc" },
  },
];

export const samplesReattachAudio: OpSample<ReattachAudioArgs>[] = [
  {
    // Reattach a pair detached in a fresh session: build the detached shape directly
    // (video-only + audio-only sharing a link), then merge back to one producer.
    name: "reattach a detached A/V pair (re-merge to one producer, remove the created track)",
    state: (): Timeline => {
      resetIds();
      return timeline(LANDSCAPE_2997, {
        video: [
          videoTrack(
            clip("/abs/interview.mp4", {
              id: "vid",
              dur: 90,
              streams: { audioIndex: -1, astream: -1, defaultAudioIndex: 1 },
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
    },
    args: { uuid: "vid" },
  },
];

export const samplesLinkClips: OpSample<LinkClipsArgs>[] = [
  {
    name: "link a video clip to an audio clip (anchor = the video)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(clip("/abs/a.mp4", { id: "v", dur: 60 }))],
        audio: [audioTrack(clip("/abs/vo.wav", { id: "a", dur: 60 }))],
      });
    },
    args: { uuids: ["v", "a"] },
  },
  {
    name: "re-link a clip that was already in another group (prior link captured)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(clip("/abs/a.mp4", { id: "v", dur: 60 }))],
        audio: [
          audioTrack(
            clip("/abs/vo.wav", {
              id: "a",
              dur: 60,
              link: { id: "OLD", role: "audio", partnerIds: ["gone"] },
            }),
          ),
        ],
      });
    },
    args: { uuids: ["v", "a"] },
  },
];

export const samplesUnlinkClips: OpSample<UnlinkClipsArgs>[] = [
  {
    name: "unlink a linked A/V pair (clears link on both members)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/a.mp4", {
              id: "v",
              dur: 60,
              link: { id: "L", role: "video", partnerIds: ["a"] },
            }),
          ),
        ],
        audio: [
          audioTrack(
            clip("/abs/vo.wav", {
              id: "a",
              dur: 60,
              link: { id: "L", role: "audio", partnerIds: ["v"] },
            }),
          ),
        ],
      });
    },
    args: { uuids: ["v"] },
  },
];
