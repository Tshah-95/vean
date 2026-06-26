// The parser: a pure `.mlt XML → Timeline` function — the inverse of
// `./serialize`. Reads our own emissions (round-tripping byte-identically) AND
// real Shotcut-saved files, normalizing like Shotcut's `MltXmlChecker`:
//   • decimal separators → dot (LC_NUMERIC C),
//   • resources → root-relative,
//   • a version guard on the `<mlt>` root.
//
// It inverts every fact the serializer honors:
//   • collect every top-level `<producer>`/`<playlist>` (defs-before-refs) into
//     id-keyed maps; the nested `lumaMix` tractors stay addressable too;
//   • resolve the MAIN `<tractor>`'s `<track>` children back to tracks — track 0
//     is the Shotcut background (a stretched `color` producer) and is dropped;
//   • read `<blank length>` as gaps, preserving their document order vs entries
//     (`preserveOrder` keeps the interleaving a grouped parse would destroy);
//   • recover same-track dissolves from nested `shotcut:transition="lumaMix"`
//     tractors, stitching the tail/head windows back onto their neighbour clips;
//   • recover the seed's fade wrapper (a 0-based single-track tractor carrying a
//     brightness/volume keyframe filter) back onto the wrapped clip;
//   • recover field transitions from MAIN-tractor `<transition>` elements
//     (integer a_track/b_track), skipping the dissolve's internal luma/mix;
//   • map `shotcut:video`/`shotcut:audio`/`hide` back to track kind;
//   • preserve animation-string property values verbatim (the keyframe model in
//     `./keyframes` owns their interpretation — the parser never rewrites them).
//
// The result is validated against `timelineSchema`, so a malformed document
// fails loudly here rather than feeding a half-formed IR downstream.
import { XMLParser } from "fast-xml-parser";
import { FADE_IN_SERVICE, FADE_OUT_SERVICE } from "./builder";
import { isAnimated, normalizeAnimDecimals } from "./keyframes";
import {
  type Clip,
  type Dissolve,
  type Filter,
  type Item,
  type Profile,
  type PropertyValue,
  type Timeline,
  type Track,
  type Transition,
  timelineSchema,
} from "./types";

// ─── The ordered-node shape (`preserveOrder: true`) ────────────────────────
// fast-xml-parser's preserveOrder mode keeps document order — vital, because a
// playlist's `<entry>`/`<blank>` interleaving is load-bearing and the default
// (grouped) mode collapses it into separate arrays. Each node is exactly one
// real element: `{ <tagName>: ChildNode[], ":@"?: { "@_attr": value } }`. Text
// content arrives as a child `{ "#text": string }`.
type Attrs = Record<string, string>;
type Node = { [tag: string]: unknown } & { ":@"?: Attrs };

const ATTRS = ":@";
const TEXT = "#text";

/** The element's tag name (the single non-`:@` key on an ordered node). */
function tagOf(node: Node): string {
  for (const k of Object.keys(node)) if (k !== ATTRS) return k;
  return "";
}

/** This node's ordered children (the array under its tag key). */
function childrenOf(node: Node): Node[] {
  const t = tagOf(node);
  const v = node[t];
  return Array.isArray(v) ? (v as Node[]) : [];
}

/** All direct children with the given tag name. */
function childrenNamed(node: Node, tag: string): Node[] {
  return childrenOf(node).filter((c) => tagOf(c) === tag);
}

function attrs(node: Node): Attrs {
  return node[ATTRS] ?? {};
}

function attr(node: Node, name: string): string | undefined {
  // Try the un-prefixed name, then the parser's `@_` prefix.
  const a = attrs(node);
  return a[name] ?? a[`@_${name}`];
}

/** Concatenated text content of a node (its `#text` children, in order). */
function textOf(node: Node): string {
  const out: string[] = [];
  for (const c of childrenOf(node)) {
    const t = (c as Record<string, unknown>)[TEXT];
    if (typeof t === "string") out.push(t);
  }
  return out.join("");
}

// ─── Normalization (the `MltXmlChecker` quirks) ────────────────────────────
/** Locale-normalize a single SCALAR numeric string to a dot decimal. Real Shotcut
 *  files saved under a comma-locale carry `1,5`; MLT's own writer is C-locale
 *  (dot). This handles BARE scalars only — a value that is a list (`;`), an
 *  animation (`=`), or space-separated bails out untouched; comma-decimals INSIDE
 *  an animation string are migrated by `normalizeAnimDecimals` (in `propValue`),
 *  not here. */
function dotDecimal(s: string): string {
  // A lone decimal comma: digits , digits, with no other comma. Leave anything
  // that already contains a dot or looks like a list/animation alone.
  if (s.includes(".") || s.includes(";") || s.includes("=") || s.includes(" ")) return s;
  const m = /^(-?\d+),(\d+)$/.exec(s);
  return m ? `${m[1]}.${m[2]}` : s;
}

/** Parse a melt time value to an integer frame. Honors `time_format` clock
 *  (`HH:MM:SS.mmm` / `HH:MM:SS:FF`) by resolving against fps; a bare integer
 *  (possibly comma-decimal from a foreign locale) is rounded. */
function toFrames(raw: string, fps: [number, number]): number {
  const s = dotDecimal(raw.trim());
  // Clock form HH:MM:SS.mmm or HH:MM:SS:FF (the two melt clock layouts).
  const clock = /^(\d+):(\d+):(\d+)(?:[.:](\d+))?$/.exec(s);
  if (clock) {
    const h = Number(clock[1]);
    const m = Number(clock[2]);
    const sec = Number(clock[3]);
    const frac = clock[4] ?? "";
    const rate = fps[0] / fps[1];
    const whole = (h * 3600 + m * 60 + sec) * rate;
    let sub = 0;
    if (frac) {
      // `.mmm` (a dot or 4th group via `.`) = milliseconds; `:FF` = frames.
      // Disambiguate by which separator preceded the fraction.
      const usedDot = s.includes(".");
      sub = usedDot ? (Number(`0.${frac}`) || 0) * rate : Number(frac);
    }
    return Math.round(whole + sub);
  }
  return Math.round(Number(s));
}

// ─── Property extraction ───────────────────────────────────────────────────
/** A producer/filter/transition's `<property name=…>value</property>` map, in
 *  document order. Animation strings (values containing `=`) are kept verbatim —
 *  the parser is locale-aware on plain scalars only, never on a keyframe string. */
function readProperties(node: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of childrenNamed(node, "property")) {
    const name = attr(p, "name");
    if (name == null) continue;
    out[name] = textOf(p);
  }
  return out;
}

/** Coerce a property string to the IR `PropertyValue`: a finite number stays a
 *  number (locale-normalized), everything else (paths, colors, animation
 *  strings) stays a string. An ANIMATION string (contains `=`) has its
 *  comma-decimal numeric tokens migrated to dots (LC_NUMERIC `.`-decimal): a file
 *  authored under a comma locale carries `0=0,2;59=0,8`, which under the C-locale
 *  header vean re-emits would make melt's `atof("0,2") == 0` — a silent
 *  mis-render. `normalizeAnimDecimals` only touches a comma strictly between
 *  digits, leaving the `;`/`=`/marker structure and non-numeric content (colors,
 *  paths) byte-identical, so a clean dot string is returned unchanged. */
function propValue(raw: string): PropertyValue {
  if (isAnimated(raw)) return normalizeAnimDecimals(raw);
  const s = dotDecimal(raw);
  if (s.trim() !== "" && !/[=; ]/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && String(n) === s.trim()) return n;
  }
  return raw;
}

function readFilters(node: Node): Filter[] {
  const out: Filter[] = [];
  for (const f of childrenNamed(node, "filter")) {
    const props = readProperties(f);
    const service = attr(f, "mlt_service") ?? props.mlt_service;
    if (!service) continue;
    // Shotcut tags a filter's logical name either as an attribute
    // (`<filter shotcut:filter="fadeInBrightness">`, the writer's form) or, in
    // some hand-written docs, as a property — accept both.
    const shotcutName = attr(f, "shotcut:filter") ?? props["shotcut:filter"];
    const properties: Record<string, PropertyValue> = {};
    for (const [k, v] of Object.entries(props)) {
      // `mlt_service`/`shotcut:filter` are carried structurally, not as data
      // properties — never duplicate them into the property map.
      if (k === "mlt_service" || k === "shotcut:filter") continue;
      properties[k] = propValue(v);
    }
    const filter: Filter = { service, properties };
    if (shotcutName != null) filter.shotcutName = shotcutName;
    out.push(filter);
  }
  return out;
}

// ─── Resolved-producer model ───────────────────────────────────────────────
type ResolvedProducer = {
  id: string;
  resource: string;
  service?: string;
  length?: number;
  gain?: number;
  filters: Filter[];
  /** Arbitrary producer-level properties not modeled structurally (caption, eof,
   *  aspect_ratio, proxy hints, …), in document order — preserved for a lossless
   *  round-trip. */
  extraProps?: Record<string, PropertyValue>;
};

/** Producer `<property>` names the serializer carries STRUCTURALLY (modeled by a
 *  dedicated field or regenerated on emit). They must NOT be captured as
 *  extra-properties, or they would double-emit / fight their structural field. */
const STRUCTURAL_PRODUCER_PROPS = new Set(["mlt_service", "resource", "length", "shotcut:uuid"]);

/** Playlist `<property>` names the serializer carries STRUCTURALLY (the Shotcut
 *  track kind + display name, regenerated on emit). Everything else (shotcut:lock,
 *  custom namespaces, …) is preserved verbatim via `Track.extraProps`. */
const STRUCTURAL_PLAYLIST_PROPS = new Set(["shotcut:video", "shotcut:audio", "shotcut:name"]);

/** Capture every non-structural `<property>` of a node (playlist or main tractor)
 *  into an ordered extra-props map, skipping the given structural names. Returns
 *  `undefined` when nothing non-structural remains, so the field stays absent (and
 *  byte-identical) on vean's own emissions. */
function captureExtraProps(
  props: Record<string, string>,
  structural: Set<string>,
): Record<string, PropertyValue> | undefined {
  const out: Record<string, PropertyValue> = {};
  for (const [k, v] of Object.entries(props)) {
    if (structural.has(k)) continue;
    out[k] = propValue(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const FADE_BRIGHTNESS_SERVICES = new Set(["brightness", "fadeInBrightness", "fadeOutBrightness"]);
const FADE_VOLUME_SERVICES = new Set(["volume", "fadeInVolume", "fadeOutVolume"]);

/** Split a producer's raw filters into: the gain (a static volume/gain filter),
 *  the fade markers (which the IR carries as sentinel `vean.fadeIn/Out`), and
 *  the remaining genuine filters kept verbatim. Returns the reconstructed IR
 *  filter list plus the extracted gain. */
function classifyFilters(raw: Filter[], playtime: number): { filters: Filter[]; gain?: number } {
  const filters: Filter[] = [];
  let gain: number | undefined;
  for (const f of raw) {
    // A static gain/volume filter (`level`/`gain` with no `=`) is the IR `gain`.
    if (FADE_VOLUME_SERVICES.has(f.service) || f.service === "gain") {
      const level = f.properties.level ?? f.properties.gain;
      const asStr = level == null ? "" : String(level);
      if (asStr !== "" && !asStr.includes("=")) {
        const g = Number(dotDecimal(asStr));
        if (Number.isFinite(g)) {
          gain = g;
          continue;
        }
      }
      // An ANIMATED volume = a fade-out (to silence) or fade-in (from silence).
      const fade = fadeFromKeyframes(asStr, playtime);
      if (fade) {
        filters.push(fade);
        continue;
      }
    }
    if (FADE_BRIGHTNESS_SERVICES.has(f.service)) {
      const level = f.properties.level;
      const asStr = level == null ? "" : String(level);
      const fade = fadeFromKeyframes(asStr, playtime);
      if (fade) {
        filters.push(fade);
        continue;
      }
    }
    filters.push(f);
  }
  return gain == null ? { filters } : { filters, gain };
}

/** Recover a fade sentinel from a brightness/volume keyframe string. The seed
 *  emits fadeIn as `0=0;{n-1}=1` and fadeOut as `{len-n}=1;{len-1}=0`, both
 *  0-based over the played window of `playtime` frames. We detect those exact
 *  shapes and rebuild the sentinel; anything else stays a literal filter. */
function fadeFromKeyframes(level: string, playtime: number): Filter | undefined {
  if (!level.includes("=")) return undefined;
  const kfs = level
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const eq = s.lastIndexOf("=");
      const t = Number(s.slice(0, eq).replace(/\D+$/, ""));
      const v = Number(dotDecimal(s.slice(eq + 1)));
      return { t, v };
    });
  if (kfs.length !== 2) return undefined;
  const a = kfs[0];
  const b = kfs[1];
  if (a == null || b == null) return undefined;
  // fadeIn: 0=0 → frames-1=1
  if (a.t === 0 && a.v === 0 && b.v === 1) {
    return { service: FADE_IN_SERVICE, properties: { frames: b.t + 1 } };
  }
  // fadeOut: (len-frames)=1 → (len-1)=0
  if (a.v === 1 && b.v === 0 && b.t === playtime - 1) {
    return { service: FADE_OUT_SERVICE, properties: { frames: playtime - a.t } };
  }
  return undefined;
}

// ─── Producer registry ─────────────────────────────────────────────────────
function resolveProducer(node: Node): ResolvedProducer {
  const id = attr(node, "id") ?? "";
  const props = readProperties(node);
  const service = props.mlt_service;
  const resource = props.resource ?? "";
  const lengthRaw = props.length;
  const filters = readFilters(node);
  const out: ResolvedProducer = { id, resource, service, filters };
  if (lengthRaw != null) {
    const n = Number(dotDecimal(lengthRaw));
    if (Number.isFinite(n)) out.length = Math.round(n);
  }
  // Preserve every non-structural producer property (caption, eof, aspect_ratio,
  // proxy hints, …) in document order, so the round-trip is genuinely lossless.
  const extraProps: Record<string, PropertyValue> = {};
  for (const [k, v] of Object.entries(props)) {
    if (STRUCTURAL_PRODUCER_PROPS.has(k)) continue;
    extraProps[k] = propValue(v);
  }
  if (Object.keys(extraProps).length > 0) out.extraProps = extraProps;
  return out;
}

// ─── Track-kind / Shotcut hints ────────────────────────────────────────────
/** A `<track>` referencing a playlist tells us audio vs video via `hide` and the
 *  playlist's `shotcut:audio`/`shotcut:video` property. `hide="audio"` or
 *  `hide="both"` (and Shotcut's `shotcut:audio=1`) ⇒ an audio track (hidden
 *  video). Defaults to video. */
function trackKindFor(trackNode: Node, playlist: Node | undefined): "video" | "audio" {
  const hide = attr(trackNode, "hide") ?? "";
  if (hide === "video" || hide === "both") {
    // hide=video means the VIDEO is hidden ⇒ it's an audio track.
    return "audio";
  }
  const props = playlist ? readProperties(playlist) : {};
  if (props["shotcut:audio"] === "1") return "audio";
  if (props["shotcut:video"] === "1") return "video";
  // Shotcut also marks audio tracks with hide=audio? No: hide=video hides video.
  if (hide === "audio") return "video";
  return "video";
}

// ─── Nested-tractor (lumaMix dissolve) detection ───────────────────────────
/** A nested tractor is a same-track dissolve iff it has exactly two `<track>`
 *  children and a `luma`/`mix` transition on its field (Shotcut tags it
 *  `shotcut:transition="lumaMix"`). Returns the windows + frame count to stitch
 *  back onto the neighbour clips. */
type DissolveTractor = {
  frames: number;
  /** outgoing tail (track 0): producer id + window. */
  tail: { producer: string; in: number; out: number };
  /** incoming head (track 1): producer id + window. */
  head: { producer: string; in: number; out: number };
  luma: string;
};

function asDissolveTractor(node: Node, fps: [number, number]): DissolveTractor | undefined {
  const tracks = childrenNamed(node, "track");
  const transitions = childrenNamed(node, "transition");
  if (tracks.length !== 2 || transitions.length === 0) return undefined;
  const hasLuma = transitions.some((t) => {
    const svc = attr(t, "mlt_service") ?? readProperties(t).mlt_service;
    return svc != null && svc !== "mix";
  });
  const shotcutTag = attr(node, "shotcut:transition");
  if (!hasLuma && shotcutTag !== "lumaMix") return undefined;
  const lumaSvc =
    transitions
      .map((t) => attr(t, "mlt_service") ?? readProperties(t).mlt_service)
      .find((s) => s != null && s !== "mix") ?? "luma";
  const t0 = tracks[0];
  const t1 = tracks[1];
  if (!t0 || !t1) return undefined;
  const win = (tn: Node) => {
    const inn = toFrames(attr(tn, "in") ?? "0", fps);
    const out = toFrames(attr(tn, "out") ?? "0", fps);
    return { producer: attr(tn, "producer") ?? "", in: inn, out };
  };
  const tail = win(t0);
  const head = win(t1);
  return { frames: tail.out - tail.in + 1, tail, head, luma: lumaSvc };
}

// ─── Clip reconstruction ───────────────────────────────────────────────────
/** Build an IR `Clip` from a resolved producer + the played `[in,out]` window
 *  taken from the playlist entry (or a wrapper/tractor track). */
function buildClip(
  prod: ResolvedProducer,
  inn: number,
  out: number,
  extraFilters: Filter[] = [],
): Clip {
  const playtime = out - inn + 1;
  const { filters, gain } = classifyFilters([...prod.filters, ...extraFilters], playtime);
  const clip: Clip = {
    kind: "clip",
    id: prod.id,
    resource: prod.resource,
    in: inn,
    out,
    filters,
  };
  if (prod.service != null && prod.service !== "") clip.service = prod.service;
  if (prod.extraProps != null) clip.extraProps = prod.extraProps;
  // A color producer's authored window is always 0-based; its `length` is the
  // played count (the serializer regenerates it). Keep an explicit `length` when
  // present and meaningful (it's required for color in the IR? — optional there,
  // but we preserve it for fidelity on color producers).
  if (prod.service === "color") {
    clip.length = prod.length ?? playtime;
  } else if (prod.length != null) {
    clip.length = prod.length;
  }
  if (gain != null) clip.gain = gain;
  return clip;
}

// ─── The wrapper tractor (fade on a windowed file clip) ────────────────────
/** The seed wraps a windowed file clip that fades in a single-track 0-based
 *  tractor carrying the fade filter. Detect that shape (one `<track>`, no
 *  transition) and fold the wrapper's filters back onto the wrapped producer. */
function asFadeWrapper(
  node: Node,
): { producer: string; in: number; out: number; filters: Filter[] } | undefined {
  const tracks = childrenNamed(node, "track");
  const transitions = childrenNamed(node, "transition");
  if (tracks.length !== 1 || transitions.length > 0) return undefined;
  const t = tracks[0];
  if (!t) return undefined;
  return {
    producer: attr(t, "producer") ?? "",
    in: Number(attr(t, "in") ?? "0"),
    out: Number(attr(t, "out") ?? "0"),
    filters: readFilters(node),
  };
}

// ─── Profile ───────────────────────────────────────────────────────────────
function parseProfile(node: Node): Profile {
  const num = (name: string, dflt: number): number => {
    const v = attr(node, name);
    if (v == null) return dflt;
    const n = Number(dotDecimal(v));
    return Number.isFinite(n) ? Math.round(n) : dflt;
  };
  const fpsNum = num("frame_rate_num", 30);
  const fpsDen = num("frame_rate_den", 1);
  const width = num("width", 1920);
  const height = num("height", 1080);
  return {
    description: attr(node, "description") ?? "",
    width,
    height,
    fps: [fpsNum, fpsDen],
    progressive: num("progressive", 1) === 0 ? 0 : 1,
    sampleAspectNum: num("sample_aspect_num", 1),
    sampleAspectDen: num("sample_aspect_den", 1),
    displayAspectNum: num("display_aspect_num", width),
    displayAspectDen: num("display_aspect_den", height),
    colorspace: num("colorspace", 709),
  };
}

// ─── Main parse ────────────────────────────────────────────────────────────
export function fromMlt(xml: string): Timeline {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false, // keep property text exact (animation strings, paths)
  });
  const tree = parser.parse(xml) as Node[];

  // Root: the <mlt> node (skip the <?xml?> prolog node, which has no real tag).
  const mltNode = tree.find((n) => tagOf(n) === "mlt");
  if (!mltNode) throw new Error("fromMlt: no <mlt> root element");
  const version = attr(mltNode, "version");
  if (version != null && !/^\d/.test(version.trim())) {
    throw new Error(`fromMlt: unrecognized <mlt version="${version}">`);
  }
  const title = attr(mltNode, "title") ?? "vean timeline";

  const top = childrenOf(mltNode);

  // 1. Profile (first child by contract; found anywhere defensively).
  const profileNode = top.find((n) => tagOf(n) === "profile");
  const profile = profileNode ? parseProfile(profileNode) : parseProfile({ profile: [] } as Node);
  const fps = profile.fps;

  // 2. Index every producer + playlist + tractor by id.
  const producers = new Map<string, ResolvedProducer>();
  const playlists = new Map<string, Node>();
  const tractors = new Map<string, Node>();
  for (const n of top) {
    const t = tagOf(n);
    const id = attr(n, "id") ?? "";
    if (t === "producer") producers.set(id, resolveProducer(n));
    else if (t === "playlist") playlists.set(id, n);
    else if (t === "tractor") tractors.set(id, n);
  }

  // 3. The MAIN tractor: the one whose <track>s reference PLAYLISTS (the timeline
  //    spine). Nested dissolve tractors reference producers, not playlists, and
  //    are themselves referenced by an entry — so the main tractor is the one not
  //    referenced by any playlist entry, and pointing at playlists.
  const referencedByEntry = new Set<string>();
  for (const pl of playlists.values()) {
    for (const e of childrenNamed(pl, "entry")) {
      const p = attr(e, "producer");
      if (p) referencedByEntry.add(p);
    }
  }
  let mainTractor: Node | undefined;
  for (const [id, tr] of tractors) {
    if (referencedByEntry.has(id)) continue; // nested (spliced into a playlist)
    const tracks = childrenNamed(tr, "track");
    const pointsAtPlaylist = tracks.some((t) => playlists.has(attr(t, "producer") ?? ""));
    if (pointsAtPlaylist) {
      mainTractor = tr;
      break;
    }
  }
  // The seed's single-track form (`<tractor id="timeline"><track producer=
  // "playlist0"/></tractor>`) also matches the above.
  if (!mainTractor) {
    // Degenerate: a lone top-level playlist with no tractor (rare) — synthesize.
    const firstPlaylist = [...playlists.keys()][0];
    if (firstPlaylist) {
      mainTractor = { tractor: [{ track: [], [ATTRS]: { "@_producer": firstPlaylist } }] } as Node;
    }
  }
  if (!mainTractor) throw new Error("fromMlt: no main <tractor> referencing a playlist");

  // 4. Walk the main tractor's tracks. Track 0 may be the Shotcut background
  //    producer (a stretched `color`); drop a leading track that points at a
  //    bare color producer (not a playlist).
  const mainTracks = childrenNamed(mainTractor, "track");
  const videoTracks: Track[] = [];
  const audioTracks: Track[] = [];
  // Map a main-tractor track INDEX → the IR track index space the field
  // transitions reference. Background (dropped) keeps its index slot so a_track
  // /b_track integers still line up.
  for (let ti = 0; ti < mainTracks.length; ti++) {
    const trackNode = mainTracks[ti];
    if (!trackNode) continue;
    const prodRef = attr(trackNode, "producer") ?? "";
    const playlist = playlists.get(prodRef);
    if (!playlist) {
      // Not a playlist ⇒ background producer (index 0) or stray; skip it.
      continue;
    }
    const kind = trackKindFor(trackNode, playlist);
    const plProps = readProperties(playlist);
    const name = plProps["shotcut:name"];
    const items = walkPlaylist(playlist, producers, tractors, fps);
    const track: Track = { kind, id: prodRef, items };
    if (name != null) track.name = name;
    // Preserve every non-structural playlist property (shotcut:lock, custom:*, …)
    // in document order, so the round-trip is genuinely lossless.
    const plExtra = captureExtraProps(plProps, STRUCTURAL_PLAYLIST_PROPS);
    if (plExtra != null) track.extraProps = plExtra;
    if (kind === "audio") track.hidden = true;
    if (kind === "video") track.hidden = false;
    if (kind === "video") videoTracks.push(track);
    else audioTracks.push(track);
  }

  // 5. Field transitions on the main tractor (cross-track compositing). Skip the
  //    luma/mix pair that belongs to a nested dissolve (those live inside the
  //    nested tractor, never on the main field, so any transition HERE is a
  //    genuine field transition).
  const transitions: Transition[] = [];
  for (const tn of childrenNamed(mainTractor, "transition")) {
    const service = attr(tn, "mlt_service") ?? readProperties(tn).mlt_service;
    if (!service) continue;
    const props = readProperties(tn);
    const aTrack = Math.round(Number(dotDecimal(props.a_track ?? "0")));
    const bTrack = Math.round(Number(dotDecimal(props.b_track ?? "0")));
    // The [in, out] window is the structural Transition.in/out — Shotcut may write
    // it as in=/out= ATTRIBUTES (vean's canonical form) or as <property> children.
    // Honor the property fallback for BOTH so a property-form transition reads its
    // real window, and exclude `in`/`out` from the property map below so the window
    // is modeled ONCE — never duplicated as both an attribute and a stale property.
    const inn = toFrames(attr(tn, "in") ?? props.in ?? "0", fps);
    const out = toFrames(attr(tn, "out") ?? props.out ?? "0", fps);
    const properties: Record<string, PropertyValue> = {};
    for (const [k, v] of Object.entries(props)) {
      if (k === "a_track" || k === "b_track" || k === "mlt_service") continue;
      if (k === "in" || k === "out") continue; // window is structural (Transition.in/out)
      properties[k] = propValue(v);
    }
    transitions.push({ service, aTrack, bTrack, in: inn, out, properties });
  }

  // 6. The main tractor's own `<property>` children: Shotcut writes project
  //    metadata here (shotcut:projectAudioChannels, shotcut:scaleFactor, …). vean
  //    emits none of its own (shotcut="1"/title are attributes), so every property
  //    here is non-structural and preserved verbatim for a lossless round-trip.
  const tractorProps = captureExtraProps(readProperties(mainTractor), new Set());

  const result: Timeline = {
    profile,
    tracks: { video: videoTracks, audio: audioTracks },
    transitions,
    title,
  };
  if (tractorProps != null) result.tractorProps = tractorProps;
  return timelineSchema.parse(result);
}

// ─── Playlist walk (the order-preserving core) ─────────────────────────────
/** Walk one playlist's ordered children into IR items. An entry pointing at a
 *  nested lumaMix tractor becomes a `dissolve` marker between its neighbours,
 *  with the tail/head windows stitched back onto the adjacent solo clips. */
function walkPlaylist(
  playlist: Node,
  producers: Map<string, ResolvedProducer>,
  tractors: Map<string, Node>,
  fps: [number, number],
): Item[] {
  const items: Item[] = [];
  // First pass: linearize into a working list of {type, ...} so stitching a
  // dissolve onto its neighbours is a local edit.
  type Work =
    | { t: "clip"; clip: Clip }
    | { t: "blank"; length: number }
    | {
        t: "dissolve";
        d: Dissolve;
        tail: { producer: string; in: number; out: number };
        head: { producer: string; in: number; out: number };
      };
  const work: Work[] = [];

  for (const child of childrenOf(playlist)) {
    const tag = tagOf(child);
    if (tag === "blank") {
      const len = Math.round(Number(dotDecimal(attr(child, "length") ?? "0")));
      if (len > 0) work.push({ t: "blank", length: len });
      continue;
    }
    if (tag !== "entry") continue;
    const ref = attr(child, "producer") ?? "";
    const inn = toFrames(attr(child, "in") ?? "0", fps);
    const out = toFrames(attr(child, "out") ?? "0", fps);

    // (a) Entry → a nested tractor? Could be a dissolve OR a fade wrapper.
    const nested = tractors.get(ref);
    if (nested) {
      const diss = asDissolveTractor(nested, fps);
      if (diss) {
        work.push({
          t: "dissolve",
          d: { kind: "dissolve", frames: diss.frames, luma: diss.luma },
          tail: diss.tail,
          head: diss.head,
        });
        continue;
      }
      const wrap = asFadeWrapper(nested);
      if (wrap) {
        const prod = producers.get(wrap.producer);
        if (prod) {
          work.push({
            t: "clip",
            clip: buildClip(prod, wrap.in, wrap.out, wrap.filters),
          });
          continue;
        }
      }
      // An unknown nested tractor — fall through and treat its first producer
      // window as a plain clip if resolvable, else skip.
    }

    // (b) Entry → a plain producer.
    const prod = producers.get(ref);
    if (!prod) continue; // dangling ref — drop (the validator would reject it)
    work.push({ t: "clip", clip: buildClip(prod, inn, out) });
  }

  // Second pass: resolve dissolves by stitching the tail onto the preceding clip
  // and the head onto the following clip, then emit the IR dissolve between them.
  for (let i = 0; i < work.length; i++) {
    const w = work[i];
    if (!w) continue;
    if (w.t === "blank") {
      items.push({ kind: "blank", length: w.length });
      continue;
    }
    if (w.t === "clip") {
      items.push(w.clip);
      continue;
    }
    // w.t === "dissolve": the serializer trimmed `frames` off the OUTGOING
    // clip's tail (into the nested tractor's track 0) and `frames` off the
    // INCOMING clip's head (track 1). Stitch both windows back so the IR carries
    // the original full clips with a `dissolve` marker between them.
    //
    // Two regimes, distinguished by producer kind:
    //   • FILE producers keep REAL source windows — solo + tail/head are
    //     contiguous in source. The full clip is min(in)…max(out): the tail
    //     extends `out`, the head extends `in` backwards.
    //   • COLOR producers are content-identical, so the serializer re-bases every
    //     segment to a fresh 0-based producer — solo and tail/head are SEPARATE
    //     0-based windows whose PLAYTIMES CONCATENATE. The full clip's playtime is
    //     solo + `frames`; `out` and `length` grow, `in` stays 0.
    const tailProd = producers.get(w.tail.producer);
    const headProd = producers.get(w.head.producer);
    const tailFrames = w.tail.out - w.tail.in + 1;
    const headFrames = w.head.out - w.head.in + 1;

    const prev = items[items.length - 1];
    if (prev && prev.kind === "clip") {
      if (prev.service === "color") {
        prev.out += tailFrames; // concatenate the trimmed tail's playtime
        if (prev.length != null) prev.length = prev.out + 1;
      } else {
        prev.out = Math.max(prev.out, w.tail.out); // contiguous source window
      }
    } else if (tailProd) {
      // No preceding solo clip (the whole outgoing clip was consumed by its
      // dissolve) — emit one from the tail window as the left neighbour.
      items.push(buildClip(tailProd, w.tail.in, w.tail.out));
    }

    items.push({ kind: "dissolve", frames: w.d.frames, luma: w.d.luma });

    // Stitch the head onto the FOLLOWING work clip (mutate it before it emits).
    const next = work[i + 1];
    if (next && next.t === "clip") {
      if (next.clip.service === "color") {
        next.clip.out += headFrames; // concatenate the trimmed head's playtime
        if (next.clip.length != null) next.clip.length = next.clip.out + 1;
      } else {
        next.clip.in = Math.min(next.clip.in, w.head.in); // head precedes solo
      }
    } else if (headProd) {
      // No following solo clip — emit one from the head window.
      items.push(buildClip(headProd, w.head.in, w.head.out));
    }
  }

  return items;
}
