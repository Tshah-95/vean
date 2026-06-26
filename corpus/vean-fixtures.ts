// The IR fixtures behind the `vean-*.mlt` corpus files — the known-good vean
// serializer output that must round-trip BYTE-IDENTICALLY. Defining the IR here
// (not just committing the XML) makes the corpus reproducible and lets a golden
// test assert that the committed `.mlt` still equals deterministic re-serializa-
// tion: change the serializer and the test catches the drift, regenerate with
// `bun corpus/build-vean.ts` to re-bless.
//
// These deliberately exercise shapes the harvested + shotcut corpus don't fully
// cover from the AUTHORING side: multiple video + audio tracks, a same-track
// dissolve, a blank gap, explicit audio gain, a cross-track field transition, and
// the escape-hatch animation-string filters (verbatim keyframe pass-through).
//
// Resources are self-contained: color clips need no media, and audio references
// `corpus/tone.wav` (a committed 4 s 48 kHz sine) so every file renders headless
// with `melt` from the corpus directory.
import { join } from "node:path";
import {
  LANDSCAPE,
  type Timeline,
  VERTICAL,
  audioTrack,
  blank,
  clip,
  colorClip,
  dissolve,
  filter,
  resetIds,
  timeline,
  transition,
  videoTrack,
} from "../src/index";

/** Absolute path to the committed tone used by audio tracks. Kept absolute so a
 *  caller in any cwd resolves it; melt also accepts it relative to the .mlt. */
export const TONE = join(import.meta.dirname, "tone.wav");

// ── vean-multitrack ─────────────────────────────────────────────────────────
// 2 video tracks + 1 audio track. V1: black (fade-in) → dissolve → gold (fade-
// out). V2: a blank gap, then a blue overlay. A1: the tone at 0.8 gain. A
// cross-track qtblend field transition composites V2 (track index 2) over V1
// (index 1) across the overlay window (indices: 0=background, 1=V1, 2=V2, 3=A1).
export function multitrack(): Timeline {
  resetIds();
  return timeline(
    VERTICAL,
    {
      video: [
        videoTrack(
          colorClip(45, "black", { fadeIn: 12 }),
          dissolve(20),
          colorClip(60, "gold", { fadeOut: 15 }),
        ),
        videoTrack(blank(15), colorClip(50, "blue")),
      ],
      audio: [audioTrack(clip(TONE, { dur: 90, gain: 0.8 }))],
    },
    {
      title: "vean multitrack — dissolve + gap + gain + field composite",
      transitions: [transition("qtblend", 1, 2, 15, 64, { compositing: 0 })],
    },
  );
}

// ── vean-keyframes ──────────────────────────────────────────────────────────
// A single video track carrying escape-hatch ANIMATED filters: a keyframed
// affine rect (linear → smooth `~`) and a brightness ramp mixing a discrete hold
// (`|`) and a smooth marker. Exercises the serializer's verbatim animation-string
// pass-through and the keyframe model's byte-faithful round-trip.
export function keyframes(): Timeline {
  resetIds();
  return timeline(
    LANDSCAPE,
    {
      video: [
        videoTrack(
          colorClip(60, "gold", {
            filters: [
              filter("affine", {
                "transition.rect": "0=0 0 1920 1080 1;30~=200 100 1520 880 0.8;59=0 0 1920 1080 1",
              }),
              filter("brightness", { level: "0=0.2;20|=0.6;40~=1;59=0.5" }),
            ],
          }),
        ),
      ],
    },
    { title: "vean keyframes — animated rect + marked brightness" },
  );
}

/** The vean- corpus: a stable map of `<basename>.mlt` → its IR builder. The build
 *  script writes each one; the golden test asserts the committed file equals the
 *  deterministic re-serialization of its builder. */
export const VEAN_FIXTURES: Record<string, () => Timeline> = {
  "vean-multitrack.mlt": multitrack,
  "vean-keyframes.mlt": keyframes,
};
