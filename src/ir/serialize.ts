// The serializer: a pure `Timeline → MLT XML` function. Deterministic — stable
// id counters (producer0, playlist0, tractor0, transition0), fixed attribute
// order, no timestamps, no clock-derived uuids — so the same IR serializes
// byte-identically. That determinism is the contract a golden test guards
// (see tests/serialize.test.ts).
//
// This PORTS and EXTENDS studio's proven single-track serializer
// (studio/src/mlt/serialize.ts): the head/tail fade compiled to a keyframe
// filter over a 0-based wrapper tractor for windowed clips, and the nested
// transition-tractor dissolve (luma + mix) that round-trips Shotcut. The
// extensions are: multiple video + audio tracks (each a <playlist> behind a
// main <tractor> <track>), an explicit Shotcut document shape (background
// producer at track 0; shotcut:video/shotcut:audio/hide/shotcut:name hints;
// _shotcut:uuid per producer; lumaMix-tagged nested dissolve tractors),
// audio clips with gain, and first-class field-level transitions.
//
// Every XML shape here honors the AUTHORITATIVE MLT FACTS (AGENTS.md):
//   • time is integer frames; in/out inclusive 0-based; playtime = out-in+1;
//     `length` is a SEPARATE source-duration property (never derived from out).
//   • fps is a RATIONAL [num,den] on <profile> (29.97 = 30000/1001).
//   • <profile> is the first <mlt> child; <mlt> carries LC_NUMERIC="C"; all
//     decimals are dot-decimals.
//   • two passes, definitions-before-references: every leaf <producer> and
//     <playlist> is a top-level <mlt> child, emitted BEFORE the <tractor>/
//     <track>/<entry>/<transition> that reference them by id.
//   • gaps are literal <blank length="N"/>; a clip's position is the implicit
//     ordering of <entry>/<blank> in its playlist.
//   • a same-track DISSOLVE is a nested <tractor> (track0 = outgoing tail,
//     track1 = incoming head) carrying a luma (video) + mix (audio, sum=1)
//     transition over [0, dur-1], tagged with a
//     <property name="shotcut:transition">lumaMix</property> child.
//   • Shotcut's `shotcut:*` logical names (the filter name, the lumaMix tag) are
//     emitted as <property> CHILDREN, never as namespaced XML attributes — an
//     undeclared `shotcut:` prefix makes a namespace-aware reader (Shotcut's own
//     QXmlStreamReader, xmllint) reject the file (lint:xml guards this).
//   • cross-track COMPOSITING is a <transition> on the MAIN tractor field,
//     referencing a_track/b_track by integer index.
//   • animated filter properties (value strings containing `=`) are emitted
//     VERBATIM — the keyframe model owns their interpretation, not the
//     serializer; passing them through is what keeps an un-wrapped service
//     round-tripping losslessly.
import { FADE_IN_SERVICE, FADE_OUT_SERVICE } from "./builder";
import { isAnimated } from "./keyframes";
import type {
  Clip,
  ClipLink,
  Filter,
  Item,
  Profile,
  PropertyValue,
  Provenance,
  StreamSelectors,
  Timeline,
  Track,
  Transition,
} from "./types";
import {
  LINK_PROP,
  encodeClipLink,
  encodeProvenanceProps,
  encodeStreamSelectorProps,
  timelineSchema,
} from "./types";

// melt is forgiving about the version string; this matches the local toolchain
// and the value real Shotcut documents carry.
const MLT_VERSION = "7.38.0";

// XML attribute-value / text escaping. MLT property values and resources can
// contain any of these; escaping keeps the document well-formed and the output
// byte-stable regardless of input.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// A property value rendered to its MLT string. Numbers are emitted dot-decimal
// (the JS default IS dot-decimal — there is no locale formatting in
// Number.prototype.toString, so this is LC_NUMERIC=C by construction). A string
// value is emitted VERBATIM (only XML-escaped): an ANIMATED property — its
// string contains `=`, per `isAnimated` — is the keyframe model's concern, and
// emitting it unchanged is precisely what keeps an un-wrapped service round-
// tripping losslessly. We never re-format an animation string here.
function propValue(v: PropertyValue): string {
  if (typeof v === "number") return String(v);
  // Static ("100") or animated ("0=100") alike: pass the authored string
  // through untouched (the keyframe engine, not the serializer, canonicalizes
  // it). `isAnimated` is the rule that classifies the two; asserting on it keeps
  // the verbatim contract visible without altering the emitted bytes.
  void isAnimated(v);
  return esc(v);
}

// ─── Deterministic identity ────────────────────────────────────────────────
// Stable id counters: producer0, playlist0, tractor0, transition0. A single
// monotonic source per kind, reset per `toMlt` call, makes the document
// byte-identical for the same IR. `_shotcut:uuid` is likewise derived from the
// producer id (NOT crypto.randomUUID) so determinism survives — a real Shotcut
// uuid is random, but ours only needs to be stable + unique within the doc.
type Ids = {
  producer: number;
  playlist: number;
  tractor: number;
  transition: number;
};
function newIds(): Ids {
  return { producer: 0, playlist: 0, tractor: 0, transition: 0 };
}
function shotcutUuid(producerId: string): string {
  // A deterministic, document-stable surrogate for Shotcut's per-producer uuid.
  // Shotcut only requires it be stable across saves; we make it a function of
  // the (already-stable) producer id so the whole document stays byte-stable.
  return `{vean-${producerId}}`;
}

function clipLen(c: { in: number; out: number }): number {
  return c.out - c.in + 1;
}

// ─── Resolved emission shapes ───────────────────────────────────────────────
// Every clip window (solo, dissolve tail/head, background) resolves to one
// concrete <producer> so per-clip filters never collide on a shared producer.
type Prod = {
  id: string;
  /** The CLIP's stable id (`Clip.id`) — emitted as `shotcut:uuid` so identity
   *  survives the round-trip (parse reads it straight back into `Clip.id`). The
   *  internal XML `id` (above) stays the ephemeral `producer${N}` ref target. When
   *  absent (the background producer, which has no clip), `shotcut:uuid` falls back
   *  to the deterministic `{vean-<id>}` surrogate. A clip emitting through two
   *  producers (a dissolve tail+head) carries the SAME uuid on both — the parser
   *  stitches them into one clip, so the shared uuid is correct. */
  uuid?: string;
  resource: string;
  service?: string;
  in: number;
  out: number;
  /** Source duration. Required for `color` producers; carried for files too. */
  length?: number;
  filters: Filter[];
  /** Arbitrary producer-level properties (caption, eof, aspect_ratio, proxy hints,
   *  …) preserved from parse, in document order — re-emitted verbatim so the
   *  round-trip is lossless. Empty/absent for vean's own emissions. */
  extraProps?: Record<string, PropertyValue>;
  /** Remotion-overlay identity (`Clip.composition`) — emitted as the
   *  `vean:composition` / `vean:compositionProps` producer properties so the
   *  overlay's composition id + render props survive the round-trip. */
  composition?: { id: string; props?: Record<string, unknown> };
  /** Origin metadata, emitted as `vean:provenance.*` producer properties so it
   *  survives export. Modeled structurally (never via extraProps), so it never
   *  double-emits. */
  provenance?: Provenance;
  /** MLT stream selectors (`audio_index`/`video_index`/`astream`/`vstream`/
   *  `shotcut:defaultAudioIndex`), emitted as producer properties. Present only on
   *  the video-only/audio-only halves of an A/V split; absent → zero new bytes. */
  streams?: StreamSelectors;
  /** Emit the Shotcut identity/audio hints (true for real timeline producers;
   *  false would be a bare melt producer — we always emit a doc, so always true
   *  except the background, which sets its own). */
  shotcut: boolean;
};

// A 0-based wrapper tractor around one windowed producer, so a fade keyframe
// filter on it sees a local 0-based timeline (melt mis-anchors keyframes on a
// windowed producer — proven by the studio probe).
type Wrapper = { id: string; track: { id: string; in: number; out: number }; filters: Filter[] };

// A same-track dissolve: a nested tractor, track0 = outgoing tail, track1 =
// incoming head, with a luma + mix transition over [0, frames-1].
type Dissolve2 = {
  id: string;
  a: { id: string; in: number; out: number };
  b: { id: string; in: number; out: number };
  frames: number;
  luma: string;
};

// One resolved playlist (= one track): its id, kind (drives the Shotcut hints +
// the main-tractor `hide="video"` on audio tracks), display name, the ordered
// entry/blank XML lines, and its total frame length (for sizing the background
// producer).
type Playlist = {
  id: string;
  kind: "video" | "audio";
  name: string;
  entries: string[];
  length: number;
  /** Arbitrary non-structural playlist properties (shotcut:lock, custom:*, …)
   *  preserved from parse, in document order — re-emitted verbatim so the
   *  round-trip is lossless. Empty/absent for vean's own emissions. */
  extraProps?: Record<string, PropertyValue>;
};

// ─── Validation (deterministic, up front) ───────────────────────────────────
// Validate every track's item sequence before emitting anything, so error
// messages don't depend on emission order and every dissolve is known to sit
// between two long-enough clips by the time the walk reaches it.
function validateTrack(track: Track, ti: number): void {
  const items = track.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || it.kind !== "dissolve") continue;
    const prev = items[i - 1];
    const next = items[i + 1];
    if (!prev || prev.kind !== "clip") {
      throw new Error(`track ${ti}: dissolve at item ${i} must be preceded by a clip`);
    }
    if (!next || next.kind !== "clip") {
      throw new Error(`track ${ti}: dissolve at item ${i} must be followed by a clip`);
    }
    if (it.frames > clipLen(prev)) {
      throw new Error(
        `track ${ti}: dissolve (${it.frames}f) is longer than the preceding clip (${clipLen(prev)}f)`,
      );
    }
    if (it.frames > clipLen(next)) {
      throw new Error(
        `track ${ti}: dissolve (${it.frames}f) is longer than the following clip (${clipLen(next)}f)`,
      );
    }
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || it.kind !== "clip") continue;
    const before = items[i - 1];
    const after = items[i + 1];
    const consumed =
      (before?.kind === "dissolve" ? before.frames : 0) +
      (after?.kind === "dissolve" ? after.frames : 0);
    if (consumed > clipLen(it)) {
      throw new Error(
        `track ${ti}: clip "${it.label ?? it.resource}" (${clipLen(it)}f) is too short for its ` +
          `adjacent dissolves (${consumed}f total)`,
      );
    }
  }
}

// ─── Fades → keyframe filters ───────────────────────────────────────────────
// A clip's fadeIn/fadeOut are carried as sentinel filters (vean.fadeIn /
// vean.fadeOut, each `{ frames: N }`) by the builder. Resolve them into the
// proven keyframe shape over the 0-based played window of `len` frames:
//   • VIDEO: a `brightness` filter, `level` ramping 0→1 (head) and 1→0 (tail).
//   • AUDIO: a `volume` filter, `gain` ramping 0→1 / 1→0 (silence at the edges).
// Returns the resolved fade filters AND the clip's remaining (non-fade) filters
// in original order, so callers can place the fade either on the producer (a
// 0-based window) or on a wrapping tractor (a windowed file clip).
function fadeFrames(f: Filter): number {
  const v = f.properties.frames;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${f.service}: frames must be a positive integer, got ${String(v)}`);
  }
  return n;
}

function resolveFades(
  clip: Clip,
  len: number,
  kind: "video" | "audio",
): { fades: Filter[]; rest: Filter[] } {
  let fadeIn = 0;
  let fadeOut = 0;
  const rest: Filter[] = [];
  for (const f of clip.filters) {
    if (f.service === FADE_IN_SERVICE) fadeIn = fadeFrames(f);
    else if (f.service === FADE_OUT_SERVICE) fadeOut = fadeFrames(f);
    else rest.push(f);
  }
  if (fadeIn === 0 && fadeOut === 0) return { fades: [], rest };
  if (fadeIn + fadeOut > len) {
    throw new Error(
      `clip "${clip.label ?? clip.resource}" fades (fadeIn ${fadeIn} + fadeOut ${fadeOut}) ` +
        `exceed its ${len}-frame length`,
    );
  }
  const kf: string[] = [];
  if (fadeIn > 0) kf.push("0=0", `${fadeIn - 1}=1`);
  if (fadeOut > 0) kf.push(`${len - fadeOut}=1`, `${len - 1}=0`);
  const service = kind === "audio" ? "volume" : "brightness";
  const prop = kind === "audio" ? "gain" : "level";
  // Shotcut's logical filter name encodes the fade direction (in/out). A single
  // clip with BOTH fades compiles to ONE keyframe filter here (the proven melt
  // shape), so we name it by whichever directions are present — "in" when only
  // a head fade, "out" when only a tail, "inOut" when both.
  const dir = fadeIn > 0 && fadeOut > 0 ? "InOut" : fadeIn > 0 ? "In" : "Out";
  const shotcutName = kind === "audio" ? `fade${dir}Volume` : `fade${dir}Brightness`;
  return {
    fades: [{ service, properties: { [prop]: kf.join(";") }, shotcutName }],
    rest,
  };
}

// A clip's audio gain (≠ unity) compiles to a `volume` filter with a static
// `gain` (a bare number string is NOT animated — no `=`). Stacks after any
// fade-derived volume filter; melt applies filters in order.
function gainFilters(clip: Clip): Filter[] {
  if (clip.gain == null || clip.gain === 1) return [];
  return [{ service: "volume", properties: { gain: String(clip.gain) }, shotcutName: "volume" }];
}

// ─── Element emitters (indentation is fixed for byte-stability) ──────────────
function filterLines(f: Filter, indent: string): string[] {
  const lines = [`${indent}<filter mlt_service="${esc(f.service)}">`];
  // Shotcut's logical filter name is a `<property name="shotcut:filter">` CHILD —
  // a plain string, NEVER a namespaced (`shotcut:filter=`) XML attribute. Genuine
  // Shotcut writes it this way and a namespace-aware reader (Shotcut's
  // QXmlStreamReader, xmllint) rejects the attribute form with an undeclared-prefix
  // error. Emit it FIRST (a deterministic, stable slot the parser re-captures) so
  // it precedes the filter's data properties — matching the shotcut:uuid/video/
  // audio/name property convention already used elsewhere in this serializer.
  if (f.shotcutName) {
    lines.push(`${indent}  <property name="shotcut:filter">${esc(f.shotcutName)}</property>`);
  }
  for (const [k, v] of Object.entries(f.properties)) {
    lines.push(`${indent}  <property name="${esc(k)}">${propValue(v)}</property>`);
  }
  lines.push(`${indent}</filter>`);
  return lines;
}

function prodXml(p: Prod): string {
  const lines = [`  <producer id="${p.id}" in="${p.in}" out="${p.out}">`];
  if (p.length != null) {
    lines.push(`    <property name="length">${p.length}</property>`);
  }
  if (p.service) {
    lines.push(`    <property name="mlt_service">${esc(p.service)}</property>`);
  }
  lines.push(`    <property name="resource">${esc(p.resource)}</property>`);
  if (p.shotcut) {
    // Route the CLIP's stable id through shotcut:uuid so identity survives the
    // round-trip; the background producer (no clip) falls back to the derived
    // `{vean-<id>}` surrogate. Either way it's deterministic → byte-stable.
    const uuid = p.uuid ?? shotcutUuid(p.id);
    lines.push(`    <property name="shotcut:uuid">${esc(uuid)}</property>`);
  }
  // Remotion-overlay identity, right after shotcut:uuid (a deterministic, stable
  // slot the parser re-captures structurally). `vean:compositionProps` is emitted
  // ONLY when props are present AND non-empty, so a propless overlay stays minimal
  // and byte-stable. JSON.stringify with the object's own key order is
  // deterministic for the IR we construct.
  if (p.composition) {
    lines.push(`    <property name="vean:composition">${esc(p.composition.id)}</property>`);
    if (p.composition.props && Object.keys(p.composition.props).length > 0) {
      lines.push(
        `    <property name="vean:compositionProps">${esc(JSON.stringify(p.composition.props))}</property>`,
      );
    }
  }
  // Origin metadata, emitted as namespaced `vean:provenance.*` CHILDREN in a fixed
  // (schema) order — after the structural props + uuid, before the verbatim
  // extra-props — a deterministic position the parser re-captures structurally, so
  // a clip with provenance round-trips to a stable fixpoint.
  if (p.provenance) {
    for (const [name, value] of encodeProvenanceProps(p.provenance)) {
      lines.push(`    <property name="${esc(name)}">${esc(value)}</property>`);
    }
  }
  // MLT stream selectors (audio_index/video_index/astream/vstream +
  // shotcut:defaultAudioIndex), emitted in the fixed schema order right after
  // provenance — a deterministic position the parser re-captures structurally.
  // ONLY the present selectors emit, so an unsplit clip adds zero new bytes.
  if (p.streams) {
    for (const [name, value] of encodeStreamSelectorProps(p.streams)) {
      lines.push(`    <property name="${esc(name)}">${esc(value)}</property>`);
    }
  }
  // Non-structural producer metadata (caption, eof, aspect_ratio, proxy hints, …),
  // preserved from parse in document order for a lossless round-trip. Emitted
  // after the structural props + uuid, before the filters — a stable position the
  // parser re-captures in the same order (so the round-trip is a fixpoint).
  if (p.extraProps) {
    for (const [k, v] of Object.entries(p.extraProps)) {
      lines.push(`    <property name="${esc(k)}">${propValue(v)}</property>`);
    }
  }
  for (const f of p.filters) lines.push(...filterLines(f, "    "));
  lines.push("  </producer>");
  return lines.join("\n");
}

function wrapperXml(w: Wrapper): string {
  const lines = [
    `  <tractor id="${w.id}">`,
    `    <track producer="${w.track.id}" in="${w.track.in}" out="${w.track.out}"/>`,
  ];
  for (const f of w.filters) lines.push(...filterLines(f, "    "));
  lines.push("  </tractor>");
  return lines.join("\n");
}

// A same-track dissolve = a 2-track nested tractor (Shotcut's lumaMix shape):
// track0 = outgoing tail under track1 = incoming head, with a luma video
// cross-dissolve + a mix audio cross-fade (sum=1) over the whole overlap.
function dissolveXml(d: Dissolve2): string {
  // `shotcut:transition` is a `<property>` CHILD (a plain string), NEVER a
  // namespaced (`shotcut:transition=`) XML attribute — genuine Shotcut writes it
  // this way and a namespace-aware reader rejects the attribute form. Emit it FIRST
  // inside the tractor (the slot Shotcut uses and the parser re-captures), before
  // the tracks/transitions, mirroring the shotcut:uuid/name property convention.
  return [
    `  <tractor id="${d.id}">`,
    `    <property name="shotcut:transition">lumaMix</property>`,
    `    <track producer="${d.a.id}" in="${d.a.in}" out="${d.a.out}"/>`,
    `    <track producer="${d.b.id}" in="${d.b.in}" out="${d.b.out}"/>`,
    `    <transition mlt_service="${esc(d.luma)}" in="0" out="${d.frames - 1}">`,
    `      <property name="a_track">0</property>`,
    `      <property name="b_track">1</property>`,
    "    </transition>",
    `    <transition mlt_service="mix" in="0" out="${d.frames - 1}">`,
    `      <property name="a_track">0</property>`,
    `      <property name="b_track">1</property>`,
    '      <property name="sum">1</property>',
    "    </transition>",
    "  </tractor>",
  ].join("\n");
}

function playlistXml(p: Playlist): string {
  const lines = [`  <playlist id="${p.id}">`];
  // Shotcut tags every playlist with its kind + display name. An audio track is
  // hidden video — `hide="video"` rides on the main-tractor <track> (emitted in
  // toMlt); the playlist itself just carries the name + kind hints.
  lines.push(`    <property name="shotcut:video">${p.kind === "video" ? 1 : 0}</property>`);
  lines.push(`    <property name="shotcut:audio">${p.kind === "audio" ? 1 : 0}</property>`);
  lines.push(`    <property name="shotcut:name">${esc(p.name)}</property>`);
  // Non-structural playlist metadata (shotcut:lock, custom:*, …) preserved from
  // parse, in document order — emitted after the structural hints, before the
  // entries: a stable position the parser re-captures in the same order (so the
  // round-trip is a fixpoint).
  if (p.extraProps) {
    for (const [k, v] of Object.entries(p.extraProps)) {
      lines.push(`    <property name="${esc(k)}">${propValue(v)}</property>`);
    }
  }
  lines.push(...p.entries);
  lines.push("  </playlist>");
  return lines.join("\n");
}

// A field-level (cross-track) transition on the MAIN tractor: a service over
// [in, out] (timeline frames, inclusive) referencing two tracks by integer
// index. Audio mix passes sum=1; video blends (qtblend/cairoblend/…) carry
// their own properties. a_track/b_track always precede the user properties so
// the index references are first + stable.
function fieldTransitionXml(t: Transition, id: string): string {
  const lines = [
    `    <transition id="${id}" mlt_service="${esc(t.service)}" in="${t.in}" out="${t.out}">`,
    `      <property name="a_track">${t.aTrack}</property>`,
    `      <property name="b_track">${t.bTrack}</property>`,
  ];
  for (const [k, v] of Object.entries(t.properties)) {
    if (k === "a_track" || k === "b_track") continue; // index refs are emitted above
    lines.push(`      <property name="${esc(k)}">${propValue(v)}</property>`);
  }
  lines.push("    </transition>");
  return lines.join("\n");
}

// A playlist ENTRY (cut) — a windowed reference to a producer/wrapper/dissolve
// tractor. Without a link it stays the byte-stable self-closing form (so an
// unlinked clip, the vast majority, adds zero new bytes). WITH a link it becomes
// a container carrying a single `vean:link` JSON `<property>` child — the typed
// A/V link, emitted on the cut (Shotcut's `shotcut:group` lives here too), which
// the parser re-captures onto `Clip.link`.
function entryXml(producerId: string, inn: number, out: number, link?: ClipLink): string {
  const open = `    <entry producer="${producerId}" in="${inn}" out="${out}"`;
  if (!link) return `${open}/>`;
  return [
    `${open}>`,
    `      <property name="${LINK_PROP}">${esc(encodeClipLink(link))}</property>`,
    "    </entry>",
  ].join("\n");
}

// ─── Profile ────────────────────────────────────────────────────────────────
function profileXml(p: Profile): string {
  // frame_rate is the RATIONAL [num,den] — never a float. Square pixels by
  // default (sample_aspect 1:1). All numeric attrs are dot-decimal (integers).
  return (
    `  <profile description="${esc(p.description)}"` +
    ` width="${p.width}" height="${p.height}"` +
    ` progressive="${p.progressive}"` +
    ` sample_aspect_num="${p.sampleAspectNum}" sample_aspect_den="${p.sampleAspectDen}"` +
    ` display_aspect_num="${p.displayAspectNum}" display_aspect_den="${p.displayAspectDen}"` +
    ` frame_rate_num="${p.fps[0]}" frame_rate_den="${p.fps[1]}"` +
    ` colorspace="${p.colorspace}"/>`
  );
}

// ─── A producer factory ─────────────────────────────────────────────────────
function makeProd(
  id: string,
  c: Clip,
  inn: number,
  out: number,
  length: number | undefined,
  filters: Filter[],
): Prod {
  const prod: Prod = {
    id,
    uuid: c.id, // route Clip.id → shotcut:uuid (identity survives the round-trip)
    resource: c.resource,
    service: c.service,
    in: inn,
    out,
    length,
    filters,
    shotcut: true,
  };
  // Carry the clip's preserved producer-level metadata (caption, eof, …) onto
  // EVERY producer minted from it (solo, dissolve tail/head) so it survives the
  // round-trip regardless of which window the clip emits through.
  if (c.extraProps && Object.keys(c.extraProps).length > 0) prod.extraProps = c.extraProps;
  // Carry the Remotion-overlay identity onto every producer minted from the clip
  // (solo, dissolve tail/head) so the composition survives the round-trip.
  if (c.composition) prod.composition = c.composition;
  // Carry origin metadata onto EVERY producer minted from the clip (solo, dissolve
  // tail/head), so it survives the round-trip regardless of emission window.
  if (c.provenance) prod.provenance = c.provenance;
  // Carry the stream selectors onto every producer minted from the clip so the
  // A/V-split selectors (astream=-1 / vstream=-1, …) survive the round-trip.
  if (c.streams) prod.streams = c.streams;
  return prod;
}

// ─── Per-track walk ──────────────────────────────────────────────────────────
// Walk one track's items into producers/wrappers/dissolves + the playlist's
// ordered entry/blank lines, mutating the shared emission buffers. Returns the
// playlist's total frame length (for the background producer + Shotcut hints).
type Emit = {
  producers: Prod[];
  wrappers: Wrapper[];
  dissolves: Dissolve2[];
  ids: Ids;
};

function walkTrack(
  track: Track,
  kind: "video" | "audio",
  emit: Emit,
): { entries: string[]; length: number } {
  const items: Item[] = track.items;
  const entries: string[] = [];
  let length = 0;
  const nextProducer = () => `producer${emit.ids.producer++}`;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it) continue;

    if (it.kind === "blank") {
      entries.push(`    <blank length="${it.length}"/>`);
      length += it.length;
      continue;
    }

    if (it.kind === "dissolve") {
      // validateTrack guaranteed both neighbours are clips long enough for it.
      const prev = items[i - 1] as Clip;
      const next = items[i + 1] as Clip;
      const d = it.frames;
      const aId = nextProducer();
      emit.producers.push(
        makeProd(aId, prev, prev.out - d + 1, prev.out, prev.length, dropFades(prev.filters)),
      );
      const bId = nextProducer();
      emit.producers.push(
        makeProd(bId, next, next.in, next.in + d - 1, next.length, dropFades(next.filters)),
      );
      const id = `tractor${emit.ids.tractor++}`;
      emit.dissolves.push({
        id,
        a: { id: aId, in: prev.out - d + 1, out: prev.out },
        b: { id: bId, in: next.in, out: next.in + d - 1 },
        frames: d,
        luma: it.luma,
      });
      entries.push(`    <entry producer="${id}" in="0" out="${d - 1}"/>`);
      length += d;
      continue;
    }

    // A clip — trim head/tail for adjacent dissolves (those frames moved into
    // the nested dissolve tractor); the remainder is its solo entry.
    const before = items[i - 1];
    const after = items[i + 1];
    const trimHead = before?.kind === "dissolve" ? before.frames : 0;
    const trimTail = after?.kind === "dissolve" ? after.frames : 0;
    const inn = it.in + trimHead;
    const out = it.out - trimTail;
    if (out < inn) {
      // Wholly consumed by its dissolve(s) (validateTrack permits exactly-
      // consumed); it appears only blended, with no solo entry.
      continue;
    }
    const len = out - inn + 1;
    const { fades, rest } = resolveFades(it, len, kind);
    const gain = gainFilters(it);
    const id = nextProducer();

    if (it.service === "color") {
      // Color frames are content-identical, so a windowed solid is meaningless:
      // emit a fresh 0-based producer (length = len) so any fade keyframe stays
      // anchored to the played segment. Fades + gain ride on the producer.
      emit.producers.push(makeProd(id, it, 0, len - 1, len, [...fades, ...gain, ...rest]));
      entries.push(entryXml(id, 0, len - 1, it.link));
    } else if (inn === 0 || fades.length === 0) {
      // A file clip that already plays from source 0, or has no fade to anchor:
      // every filter sits on the producer over its (0-based or windowed) domain.
      emit.producers.push(makeProd(id, it, inn, out, it.length, [...fades, ...gain, ...rest]));
      entries.push(entryXml(id, inn, out, it.link));
    } else {
      // A windowed file clip WITH a fade: its window can't reset to 0 (the
      // source frames differ), so the fade keyframes would mis-anchor on the
      // producer. Wrap it in a 0-based tractor and put the fade there; gain +
      // escape-hatch filters stay on the producer (they operate in source
      // space and don't depend on a 0-based domain).
      emit.producers.push(makeProd(id, it, inn, out, it.length, [...gain, ...rest]));
      const wid = `tractor${emit.ids.tractor++}`;
      emit.wrappers.push({ id: wid, track: { id, in: inn, out }, filters: fades });
      entries.push(entryXml(wid, 0, len - 1, it.link));
    }
    length += len;
  }

  return { entries, length };
}

// Drop the fade sentinels from a clip's filter list (used for dissolve tail/head
// producers, where a separate cross-fade — not an edge fade — governs the edge).
function dropFades(filters: Filter[]): Filter[] {
  return filters.filter((f) => f.service !== FADE_IN_SERVICE && f.service !== FADE_OUT_SERVICE);
}

// ─── The serializer ──────────────────────────────────────────────────────────
export function toMlt(timeline: Timeline): string {
  // Validate up front so failures are deterministic and point at the field,
  // before any XML is built.
  const tl = timelineSchema.parse(timeline);

  // Validate every track's item sequence (dissolve placement / clip lengths).
  const allTracks = [...tl.tracks.video, ...tl.tracks.audio];
  allTracks.forEach((t, i) => validateTrack(t, i));

  const ids = newIds();
  const emit: Emit = { producers: [], wrappers: [], dissolves: [], ids };

  // Walk every track into its playlist. Video tracks first, then audio — that
  // ordering defines the main-tractor track indices a field Transition's
  // aTrack/bTrack reference (after the implicit background at index 0).
  const playlists: Playlist[] = [];
  let videoN = 0;
  let audioN = 0;
  let maxLength = 0;

  for (const t of tl.tracks.video) {
    const { entries, length } = walkTrack(t, "video", emit);
    const pid = `playlist${ids.playlist++}`;
    const pl: Playlist = {
      id: pid,
      kind: "video",
      name: t.name ?? `V${++videoN}`,
      entries,
      length,
    };
    if (t.extraProps && Object.keys(t.extraProps).length > 0) pl.extraProps = t.extraProps;
    playlists.push(pl);
    if (length > maxLength) maxLength = length;
  }
  for (const t of tl.tracks.audio) {
    const { entries, length } = walkTrack(t, "audio", emit);
    const pid = `playlist${ids.playlist++}`;
    const pl: Playlist = {
      id: pid,
      kind: "audio",
      name: t.name ?? `A${++audioN}`,
      entries,
      length,
    };
    if (t.extraProps && Object.keys(t.extraProps).length > 0) pl.extraProps = t.extraProps;
    playlists.push(pl);
    if (length > maxLength) maxLength = length;
  }

  // The background producer at track 0 — a black solid stretched the full
  // timeline length, exactly as Shotcut writes it. Its window is [0, len-1];
  // for an empty timeline (no tracks/items) it is a single black frame.
  const bgLen = Math.max(maxLength, 1);
  const bgId = `producer${ids.producer++}`;
  const background: Prod = {
    id: bgId,
    resource: "0",
    service: "color",
    in: 0,
    out: bgLen - 1,
    length: bgLen,
    filters: [],
    shotcut: true,
  };

  // The main tractor: track 0 = background, then each playlist as a <track>
  // with the Shotcut audio/hide hint. Field transitions reference these by
  // integer index. Background is index 0; playlists are 1..N in video-then-
  // audio order — the indexing a Transition's aTrack/bTrack assumes.
  const mainId = `tractor${ids.tractor++}`;
  const mainLines: string[] = [`  <tractor id="${mainId}" shotcut="1" title="${esc(tl.title)}">`];
  // Non-structural main-tractor metadata (shotcut:projectAudioChannels,
  // shotcut:scaleFactor, …) preserved from parse, in document order — emitted
  // first (before the tracks/transitions), the position Shotcut writes them and a
  // stable slot the parser re-captures in the same order (so the round-trip is a
  // fixpoint). Absent on vean's own emissions, so they stay byte-identical.
  if (tl.tractorProps) {
    for (const [k, v] of Object.entries(tl.tractorProps)) {
      mainLines.push(`    <property name="${esc(k)}">${propValue(v)}</property>`);
    }
  }
  mainLines.push(`    <track producer="${bgId}"/>`);
  for (const p of playlists) {
    const hide = p.kind === "audio" ? ' hide="video"' : "";
    mainLines.push(`    <track producer="${p.id}"${hide}/>`);
  }
  for (const t of tl.transitions) {
    mainLines.push(fieldTransitionXml(t, `transition${ids.transition++}`));
  }
  mainLines.push("  </tractor>");

  // ── Assemble: two passes, definitions-before-references ──
  // PASS 1 (top-level <mlt> children): the background producer, every leaf clip
  // <producer>, every fade-wrapper + dissolve nested <tractor>, every track
  // <playlist>. PASS 2: the main <tractor> referencing them by id.
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    "<!-- Generated by vean (src/ir/serialize). Edit the IR and re-serialize,",
    "     not this file. Safe to open in Shotcut — it round-trips losslessly. -->",
    `<mlt LC_NUMERIC="C" version="${MLT_VERSION}" root="" title="${esc(tl.title)}">`,
    profileXml(tl.profile),
    prodXml(background),
    ...emit.producers.map(prodXml),
    ...emit.wrappers.map(wrapperXml),
    ...emit.dissolves.map(dissolveXml),
    ...playlists.map(playlistXml),
    ...mainLines,
    "</mlt>",
  ];
  return `${lines.join("\n")}\n`;
}
