// The ergonomic authoring surface — how an agent (or a human, or an op) builds a
// timeline. The obvious way to write something is the correct way: bad states
// are hard to express, every clip gets a stable id, and time stays integer
// frames. No `@/brand` coupling — colors are plain strings.
//
//   import { clip, colorClip, dissolve, videoTrack, audioTrack, timeline, VERTICAL } from "vean";
//
//   export default timeline(VERTICAL, {
//     video: [videoTrack(clip("/abs/intro.mp4", { dur: 90, fadeIn: 12 }), dissolve(20),
//                         colorClip(60, "#C7AE7A", { fadeOut: 15 }))],
//     audio: [audioTrack(clip("/abs/vo.wav", { dur: 170, gain: 0.8 }))],
//   });
import type {
  Blank,
  Clip,
  Dissolve,
  Filter,
  Item,
  Profile,
  Provenance,
  Timeline,
  Track,
  Tracks,
  Transition,
} from "./types";

// ─── Identity ──────────────────────────────────────────────────────────────
// Stable, uuid-like ids. Authoring is deterministic by default (a counter, so a
// hand-authored module serializes byte-identically); pass an explicit `id` to
// pin one. A real uuid is available via `uuid()` for non-deterministic callers
// (ops creating fresh clips at runtime).
let _counter = 0;
/** Reset the deterministic id counter — call at the top of a module/test so ids
 *  are stable regardless of evaluation order elsewhere. */
export function resetIds(): void {
  _counter = 0;
}
/** A deterministic stable id with the given prefix (`clip`, `track`, …). */
export function nextId(prefix: string): string {
  return `${prefix}-${_counter++}`;
}
/** A random uuid-v4-ish id, for runtime-created entities that need true unique-
 *  ness (kept dependency-free; uses crypto.randomUUID when present). */
export function uuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

// ─── Color ───────────────────────────────────────────────────────────────
// MLT wants `#AARRGGBB` (alpha FIRST); the common authoring form is `#RRGGBB`.
// Convert, accept a small set of CSS color names, and pass an already-#AARRGGBB
// value through. NO palette/brand lookup — vean is standalone.
const CSS_NAMES: Record<string, string> = {
  black: "#000000",
  white: "#FFFFFF",
  red: "#FF0000",
  green: "#008000",
  blue: "#0000FF",
  gold: "#FFD700",
  gray: "#808080",
  grey: "#808080",
  transparent: "#00000000",
};

/** Normalize a color to MLT's `#AARRGGBB`. Accepts `#RRGGBB`, `#AARRGGBB`, or a
 *  CSS color name from a small built-in set. */
export function mltColor(color: string): string {
  if (/^#[0-9a-fA-F]{8}$/.test(color)) return `#${color.slice(1).toUpperCase()}`;
  const named = CSS_NAMES[color.toLowerCase()];
  const hex = named ?? color;
  if (/^#[0-9a-fA-F]{8}$/.test(hex)) return `#${hex.slice(1).toUpperCase()}`;
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!m?.[1]) {
    throw new Error(`mltColor: "${color}" is not a #RRGGBB / #AARRGGBB hex or a known CSS name`);
  }
  return `#FF${m[1].toUpperCase()}`;
}

// ─── Clips ───────────────────────────────────────────────────────────────
type ClipOpts = {
  /** Stable id; auto-generated (deterministic counter) if omitted. */
  id?: string;
  /** Source-frame in (inclusive). Default 0. */
  in?: number;
  /** Source-frame out (inclusive). Give this OR `dur`. */
  out?: number;
  /** Length in frames from `in` — sugar for `out = in + dur - 1`. */
  dur?: number;
  /** Total source duration (frames). Defaults to out+1; required for color. */
  length?: number;
  /** Audio gain multiplier (1 = unity). */
  gain?: number;
  /** Frames of fade-up (from black / silence) at the head. */
  fadeIn?: number;
  /** Frames of fade-down (to black / silence) at the tail. */
  fadeOut?: number;
  /** Extra MLT filters (the escape hatch). */
  filters?: Filter[];
  /** Optional human label for the .mlt. */
  label?: string;
  /** Remotion-overlay identity — set when this clip is a baked alpha .mov from a
   *  Remotion composition. Flows verbatim onto `Clip.composition`. */
  composition?: { id: string; props?: Record<string, unknown> };
  /** Optional origin metadata (import / generative / capture / remotion),
   *  round-tripped as `vean:provenance.*` producer properties. */
  provenance?: Provenance;
};

// Fades are stored as a marker filter the serializer resolves into the proven
// brightness (video) / volume (audio) keyframe shape with the correct anchoring.
// We keep them as `fadeIn`/`fadeOut` intent on a sentinel filter so the IR has a
// single filter list and the serializer owns the keyframe math (matching the
// seed's behavior). The sentinel service names are reserved.
export const FADE_IN_SERVICE = "vean.fadeIn";
export const FADE_OUT_SERVICE = "vean.fadeOut";

function fadeFilters(opts: ClipOpts): Filter[] {
  const out: Filter[] = [];
  if (opts.fadeIn && opts.fadeIn > 0) {
    out.push({ service: FADE_IN_SERVICE, properties: { frames: opts.fadeIn } });
  }
  if (opts.fadeOut && opts.fadeOut > 0) {
    out.push({ service: FADE_OUT_SERVICE, properties: { frames: opts.fadeOut } });
  }
  return out;
}

function baseClip(
  resource: string,
  service: string | undefined,
  inn: number,
  out: number,
  opts: ClipOpts,
): Clip {
  return {
    kind: "clip",
    id: opts.id ?? nextId("clip"),
    resource,
    service,
    in: inn,
    out,
    length: opts.length,
    gain: opts.gain,
    filters: [...fadeFilters(opts), ...(opts.filters ?? [])],
    label: opts.label,
    composition: opts.composition,
    provenance: opts.provenance,
  };
}

/** A clip from a media file. Give `dur` (frames from `in`, default in 0) or an
 *  explicit `in`/`out` window. Use an ABSOLUTE path so `melt` resolves it
 *  regardless of where it runs. */
export function clip(resource: string, opts: ClipOpts = {}): Clip {
  const inn = opts.in ?? 0;
  const out = opts.out ?? (opts.dur != null ? inn + opts.dur - 1 : undefined);
  if (out == null) throw new Error(`clip("${resource}"): give a \`dur\` or an explicit \`out\``);
  if (out < inn) throw new Error(`clip("${resource}"): out (${out}) must be >= in (${inn})`);
  return baseClip(resource, undefined, inn, out, opts);
}

/** A solid-color clip, `frames` long. `color` is a hex (`#RRGGBB`/`#AARRGGBB`)
 *  or a known CSS name; defaults to black. */
export function colorClip(
  frames: number,
  color = "black",
  opts: Omit<ClipOpts, "in" | "out" | "dur" | "length"> = {},
): Clip {
  if (frames <= 0) throw new Error("colorClip: frames must be > 0");
  return baseClip(mltColor(color), "color", 0, frames - 1, { ...opts, length: frames });
}

/** A gap (black + silence) on a track, `frames` long. */
export function blank(frames: number): Blank {
  if (frames <= 0) throw new Error("blank: frames must be > 0");
  return { kind: "blank", length: frames };
}

/** A same-track cross-fade of `frames`, placed BETWEEN two clips on a track. */
export function dissolve(frames: number, luma = "luma"): Dissolve {
  if (frames <= 0) throw new Error("dissolve: frames must be > 0");
  return { kind: "dissolve", frames, luma };
}

// ─── Filters / transitions (escape hatches) ────────────────────────────────
/** Any MLT filter by service name + properties — animation strings allowed in
 *  values (`filter("brightness", { level: "0=0;14=1" })`). */
export function filter(service: string, properties: Record<string, string | number> = {}): Filter {
  return { service, properties };
}

/** A cross-TRACK field transition on the main tractor over `[in, out]` (timeline
 *  frames), compositing `bTrack` over `aTrack` (0-based indices). For audio mix
 *  pass `{ sum: 1 }`; for video use `qtblend` / `frei0r.cairoblend` / etc. */
export function transition(
  service: string,
  aTrack: number,
  bTrack: number,
  inn: number,
  out: number,
  properties: Record<string, string | number> = {},
): Transition {
  if (out < inn) throw new Error(`transition("${service}"): out (${out}) must be >= in (${inn})`);
  return { service, aTrack, bTrack, in: inn, out, properties };
}

// ─── Tracks / assembly ─────────────────────────────────────────────────────
/** An ordered run of items, flattening nested arrays so groups compose. */
export function sequence(...items: (Item | Item[])[]): Item[] {
  return items.flat();
}

/** A video track from an ordered run of items. */
export function videoTrack(...items: (Item | Item[])[]): Track {
  return { kind: "video", id: nextId("track"), items: items.flat(), hidden: false };
}

/** An audio track (hidden video, `hide=1` when emitted) from a run of items. */
export function audioTrack(...items: (Item | Item[])[]): Track {
  return { kind: "audio", id: nextId("track"), items: items.flat(), hidden: true };
}

/** A complete timeline: a profile + tracks (+ optional field transitions). */
export function timeline(
  profile: Profile,
  tracks: Partial<Tracks>,
  opts: { title?: string; transitions?: Transition[] } = {},
): Timeline {
  return {
    profile,
    tracks: { video: tracks.video ?? [], audio: tracks.audio ?? [] },
    transitions: opts.transitions ?? [],
    title: opts.title ?? "vean timeline",
  };
}
