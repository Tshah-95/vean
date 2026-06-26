// MLT render profiles — the canvas an assembled timeline renders onto.
//
// A profile is pure dimensions + RATIONAL frame rate + display aspect. fps is a
// `[num, den]` pair on every preset (30 = `[30,1]`); the rational form is the
// load-bearing invariant — 29.97 is `[30000,1001]`, never the float `29.97`, so
// every downstream frame computation stays exact. All presets use SQUARE pixels
// (sample aspect 1:1), so display aspect equals width:height — no anamorphic
// surprises.
import type { Fps, Profile } from "./types";

function profile(
  description: string,
  width: number,
  height: number,
  fps: Fps,
  displayAspectNum: number,
  displayAspectDen: number,
): Profile {
  return {
    description,
    width,
    height,
    fps,
    progressive: 1,
    sampleAspectNum: 1,
    sampleAspectDen: 1,
    displayAspectNum,
    displayAspectDen,
    colorspace: 709,
  };
}

/** 1080×1920 @30 — reels / shorts / vertical. */
export const VERTICAL = profile("vertical-1080x1920-30", 1080, 1920, [30, 1], 9, 16);
/** 1080×1080 @30 — square feed posts. */
export const SQUARE = profile("square-1080x1080-30", 1080, 1080, [30, 1], 1, 1);
/** 1920×1080 @30 — landscape (YouTube, X landscape). */
export const LANDSCAPE = profile("landscape-1920x1080-30", 1920, 1080, [30, 1], 16, 9);
/** 1920×1080 @29.97 (`30000/1001`) — broadcast/NTSC-rate landscape. */
export const LANDSCAPE_2997 = profile("landscape-1920x1080-2997", 1920, 1080, [30000, 1001], 16, 9);
/** 1920×1080 @23.976 (`24000/1001`) — film-rate landscape. */
export const LANDSCAPE_23976 = profile(
  "landscape-1920x1080-23976",
  1920,
  1080,
  [24000, 1001],
  16,
  9,
);

/** Lookup by name — for the CLI and config-driven selection. */
export const PROFILES = {
  vertical: VERTICAL,
  square: SQUARE,
  landscape: LANDSCAPE,
  "landscape-2997": LANDSCAPE_2997,
  "landscape-23976": LANDSCAPE_23976,
} as const;
export type ProfileName = keyof typeof PROFILES;

/** The profile's fps as an exact ratio (num/den), for frame⇄second math. */
export function fpsRatio(p: Profile): number {
  return p.fps[0] / p.fps[1];
}

/** Whole frames for `s` seconds at the profile's (rational) fps, rounded — so
 *  timings read in seconds, `seconds(VERTICAL, 1.5)`, not magic frame counts. */
export function seconds(p: Profile, s: number): number {
  return Math.round(s * fpsRatio(p));
}
