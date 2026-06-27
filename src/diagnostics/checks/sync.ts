// Sync / timing diagnostics — A/V alignment + frame-rate hazards (the ROADMAP
// Move-1b Tier-1 SYNC subset). Three perceptual hazards an agent can't hear/see
// in a still frame but that wreck a cut:
//
//   1. av-asymmetric-trim  — detached audio of the SAME source, trimmed or
//      positioned differently from its video, so lip-sync drifts.
//   2. clip-fps-mismatch   — a clip whose SOURCE fps differs from the project
//      profile fps, so melt resamples frames → judder / dropped-or-doubled frames.
//   3. speed-change-no-pitch — a re-timed (speed ≠ 1) clip with audio whose pitch
//      compensation is off, so the audio chipmunks / drones.
//
// These are PERCEPTUAL hazards: the timeline is valid and serializable, but it
// will look/sound wrong. So they are `warning` (not `error`) — they don't block a
// faithful render of what the IR says; they flag that the IR probably says the
// wrong thing.
//
// Pure: reads the IR, returns Diagnostics, no I/O, no mutation. CONSERVATIVE — a
// clean corpus emits zero (the no-false-positive gate). The discriminating signal
// for each rule is a property MLT/Shotcut writes ONLY when the hazard's mechanism
// is in play (`meta.media.frame_rate_*` for a probed source fps, `warp_speed`/
// `warp_pitch` for a `timewarp` producer), carried verbatim in `Clip.extraProps`
// by the parser. A clean color-clip / un-retimed / single-window timeline carries
// none of those, so each checker is silent on it by construction, not by luck.
//
// FINALIZED SIGNATURE. `sync: Checker` is the stable registry contract.
import type { Clip, Profile, Timeline, Track } from "../../ir/types";
import { type Diagnostic, type DiagnosticInput, diag } from "../types";

// ─── Shared helpers ─────────────────────────────────────────────────────────

/** Played length of a clip (inclusive window). */
function playtime(c: Clip): number {
  return c.out - c.in + 1;
}

/** A SYNTHESIZED producer (a solid color or other generator) has no real source
 *  media, fps, or audio — every sync rule is meaningless on it (there is nothing
 *  to drift out of sync, no source fps to mismatch, no audio to chipmunk). The IR
 *  marks these by `service` (`color`, and the small set of melt generators we may
 *  emit). Excluding them is the FIRST guard in every rule. */
const GENERATOR_SERVICES = new Set(["color", "colour", "frei0r.test_pat_B", "noise", "blipflash"]);
function isGenerator(c: Clip): boolean {
  if (c.service != null && GENERATOR_SERVICES.has(c.service)) return true;
  // A `#AARRGGBB`/`#RRGGBB` resource is a color spec even if the service is absent
  // (a bare melt color producer). A media path never starts with `#`.
  return c.resource.startsWith("#");
}

/** Read a producer extra-property as a finite number, or undefined if absent /
 *  non-numeric. `extraProps` values are `string | number` (verbatim from the XML),
 *  so a `"30000"` and a `30000` both resolve. */
function numProp(c: Clip, key: string): number | undefined {
  const raw = c.extraProps?.[key];
  if (raw == null) return undefined;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Read a producer extra-property as its raw string (trimmed), or undefined. */
function strProp(c: Clip, key: string): string | undefined {
  const raw = c.extraProps?.[key];
  if (raw == null) return undefined;
  return String(raw).trim();
}

// ─── 1. av-asymmetric-trim — detached audio of the same source, misaligned ────
//
// MLT/Shotcut represents "detached audio" as a SECOND producer pointing at the
// SAME media file, placed on an audio track (the video producer keeps its video,
// the audio one sets `audio_index`/`video_index=-1`). When the two were captured
// together they are A/V-linked: the audio at source-frame N must sit at the same
// timeline frame as the video at source-frame N. If a trim moved one window and
// not the other — different `in` (a head trim that didn't ripple to the audio) or
// a different played length — sync drifts by exactly that frame delta.
//
// We detect it WITHOUT an explicit link field (the IR has none yet) by the only
// signal present in the IR today: the SAME real-media `resource` appearing on BOTH
// a video and an audio track. That is conservative on the clean corpus — the one
// shared media file (`tone.wav`) appears on a single audio track, so there is no
// video/audio pair to compare, and color resources are excluded as generators.

/** Compare each (video-clip, audio-clip) pair that shares one real-media resource;
 *  fire when their SOURCE windows differ (a head-trim drift or a length mismatch).
 *  Symmetric pairs (identical `in` and `out`) are silent — that is correct A/V. */
function checkAvAsymmetricTrim(state: Timeline): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];

  type Located = { clip: Clip; track: Track };
  const videoByResource = new Map<string, Located[]>();
  const audioByResource = new Map<string, Located[]>();

  const index = (tracks: Track[], into: Map<string, Located[]>) => {
    for (const track of tracks) {
      for (const it of track.items) {
        if (it.kind !== "clip") continue;
        if (isGenerator(it)) continue; // a solid has no linked audio
        const key = it.resource;
        const list = into.get(key) ?? [];
        list.push({ clip: it, track });
        into.set(key, list);
      }
    }
  };
  index(state.tracks.video, videoByResource);
  index(state.tracks.audio, audioByResource);

  for (const [resource, videos] of videoByResource) {
    const audios = audioByResource.get(resource);
    if (!audios || audios.length === 0) continue; // no detached-audio counterpart
    // Only treat as A/V-linked when the pairing is UNAMBIGUOUS: exactly one video
    // window and one audio window for the source. Multiple uses of the same clip
    // (e.g. a b-roll reused twice) are NOT a link and must not fire — keeping the
    // rule conservative (no false positive on legitimate reuse).
    if (videos.length !== 1 || audios.length !== 1) continue;
    const v = videos[0];
    const a = audios[0];
    if (v == null || a == null) continue;
    const inDelta = a.clip.in - v.clip.in;
    const lenDelta = playtime(a.clip) - playtime(v.clip);
    if (inDelta === 0 && lenDelta === 0) continue; // symmetric — correctly linked

    const drift =
      inDelta !== 0
        ? `the audio starts ${Math.abs(inDelta)} source-frame(s) ${inDelta > 0 ? "later" : "earlier"} than the video`
        : `the audio plays ${Math.abs(lenDelta)} frame(s) ${lenDelta > 0 ? "longer" : "shorter"} than the video`;
    out.push(
      diag({
        code: "av-asymmetric-trim",
        severity: "warning",
        message: `clip "${v.clip.id}" and its detached audio "${a.clip.id}" (same source "${resource}") are trimmed/positioned asymmetrically — ${drift}, so lip-sync drifts`,
        location: { clip: v.clip.id, track: v.track.id },
        related: [
          {
            location: { clip: a.clip.id, track: a.track.id },
            message: "the detached audio of the same source",
          },
        ],
        fix: "trim both the video and its linked audio by the same amount (or relink them)",
        data: { inDelta, lenDelta },
      }),
    );
  }
  return out;
}

// ─── 2. clip-fps-mismatch — source fps ≠ profile fps (judder) ─────────────────
//
// melt renders every clip at the PROFILE fps. A source shot at a different rate is
// resampled — at non-integer ratios (24→30, 25→30) by dropping/doubling whole
// frames, which reads as judder on motion. Shotcut probes and records the source
// rate as `meta.media.frame_rate_num` / `meta.media.frame_rate_den` on the
// producer; the parser carries both in `extraProps`. When that rational source fps
// differs from the profile's `[num, den]`, we warn.
//
// Conservative by construction: a clip WITHOUT both meta props (every clean-corpus
// clip — none was probed) is skipped, and a source whose rate EQUALS the profile
// (the common, correct case) is silent. We compare as exact rationals (cross-
// multiply), never floats, honoring the rational-time invariant.

/** Cross-multiply two rationals for exact equality without float error. */
function ratiosEqual(an: number, ad: number, bn: number, bd: number): boolean {
  return an * bd === bn * ad;
}

function checkClipFpsMismatch(clip: Clip, track: Track, profile: Profile): DiagnosticInput[] {
  if (isGenerator(clip)) return []; // a solid has no source frame rate
  const srcNum = numProp(clip, "meta.media.frame_rate_num");
  const srcDen = numProp(clip, "meta.media.frame_rate_den");
  // Need BOTH halves of the rational and a positive denominator to compare exactly.
  if (srcNum == null || srcDen == null || srcDen <= 0 || srcNum <= 0) return [];
  const [profNum, profDen] = profile.fps;
  if (ratiosEqual(srcNum, srcDen, profNum, profDen)) return []; // matches → no judder
  const srcFps = (srcNum / srcDen).toFixed(3).replace(/\.?0+$/, "");
  const profFps = (profNum / profDen).toFixed(3).replace(/\.?0+$/, "");
  return [
    diag({
      code: "clip-fps-mismatch",
      severity: "warning",
      message: `clip "${clip.id}" source is ${srcFps} fps but the timeline renders at ${profFps} fps — melt resamples frames, which can read as judder on motion`,
      location: { clip: clip.id, track: track.id },
      fix: "conform the source to the timeline fps, set a motion-interpolation filter, or match the project fps to the footage",
      data: {
        sourceFpsNum: srcNum,
        sourceFpsDen: srcDen,
        profileFpsNum: profNum,
        profileFpsDen: profDen,
      },
    }),
  ];
}

// ─── 3. speed-change-no-pitch — retimed clip, audio not pitch-corrected ────────
//
// A speed change is an MLT `timewarp` producer: `warp_speed` is the multiplier
// (1 = normal, 2 = double speed) and `warp_pitch` toggles pitch compensation
// (1 = preserve pitch, 0/absent = let pitch ride the speed → chipmunk on fast,
// drone on slow). If a retimed clip carries audio (it's on an audio track, or it's
// an a/v clip whose audio isn't disabled) and pitch compensation is OFF, the audio
// pitch-shifts audibly. We warn so the agent enables pitch handling or mutes.
//
// Conservative: fires ONLY when `warp_speed` is present AND ≠ 1 (a real retime) AND
// pitch handling is off AND the clip plausibly carries audio. A clip with no warp
// props (every clean-corpus clip) is skipped; a video-only retime is skipped (no
// audio to chipmunk).

/** True when the clip is on an audio track, or is an a/v clip that hasn't disabled
 *  its audio (`audio_index = -1` / `set.test_audio = 1` mean no audio). A video-
 *  only source has no audio to pitch-shift, so a speed change is harmless there. */
function carriesAudio(clip: Clip, track: Track): boolean {
  if (numProp(clip, "audio_index") === -1) return false; // audio explicitly disabled
  if (numProp(clip, "set.test_audio") === 1) return false; // melt's "no real audio" marker
  if (track.kind === "audio") return true;
  // A video-track clip carries audio unless it's a known video-only/muted source.
  // We can't probe the file (no I/O), so default to "has audio" for a real media
  // clip — but ONLY a retimed one ever reaches the pitch check below, and a silent
  // retimed video clip is the rare case (the safe over-warn is acceptable since the
  // gate is presence-of-warp, which no clean file has).
  return true;
}

function checkSpeedChangeNoPitch(clip: Clip, track: Track): DiagnosticInput[] {
  if (isGenerator(clip)) return []; // a solid isn't retimed media
  const speedStr = strProp(clip, "warp_speed");
  if (speedStr == null) return []; // not a timewarp producer → not retimed
  const speed = Number(speedStr.replace(/x$/i, "")); // Shotcut may write "2x"
  if (!Number.isFinite(speed) || speed === 1) return []; // no real speed change
  const pitch = numProp(clip, "warp_pitch") ?? 0; // absent ⇒ no compensation
  if (pitch === 1) return []; // pitch is preserved → no hazard
  if (!carriesAudio(clip, track)) return []; // no audio to pitch-shift
  return [
    diag({
      code: "speed-change-no-pitch",
      severity: "warning",
      message:
        `clip "${clip.id}" is retimed to ${speed}× speed without pitch compensation — ` +
        `its audio will ${speed > 1 ? "rise in pitch (chipmunk)" : "drop in pitch (drone)"}`,
      location: { clip: clip.id, track: track.id },
      fix: "enable pitch compensation (warp_pitch=1) on the speed change, or mute/replace the clip's audio",
      data: { speed, warpPitch: pitch },
    }),
  ];
}

// ─── The sync checker ─────────────────────────────────────────────────────────
/** Run every sync rule over the timeline. Per-clip rules (fps mismatch, speed/
 *  pitch) iterate clips; the A/V symmetry rule is whole-document (it pairs across
 *  video and audio tracks). The registry stamps `source`. */
export function sync(state: Timeline): Diagnostic[] {
  const out: DiagnosticInput[] = [];

  // Whole-document rule: pair detached audio against its video by shared source.
  out.push(...checkAvAsymmetricTrim(state));

  // Per-clip rules.
  for (const track of [...state.tracks.video, ...state.tracks.audio]) {
    for (const it of track.items) {
      if (it.kind !== "clip") continue;
      out.push(...checkClipFpsMismatch(it, track, state.profile));
      out.push(...checkSpeedChangeNoPitch(it, track));
    }
  }

  return out.map((d) => ({ ...d, source: "sync" }));
}
