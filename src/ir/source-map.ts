// The IR ⇄ .mlt SOURCE MAP — the bridge between a diagnostic's STABLE-IDENTITY
// location (a clip uuid, a track id, a transition index) and a TEXT RANGE in the
// `.mlt` document. The LSP needs this: `collectDiagnostics` (the shared engine)
// returns locations by stable identity (never a text offset — the engine is pure
// over the IR and knows nothing about bytes), but `publishDiagnostics` needs a
// `Range` in document coordinates so the editor can underline the right span.
//
// This module is ADDITIVE and STANDALONE — it does NOT touch the parser
// (`./parse`), which must stay byte-faithful so the Move-0/1 round-trip + render
// gates remain green. Instead of threading offsets through the fast-xml-parser
// IR (which would perturb every golden), it does a SEPARATE, lightweight lexical
// scan of the raw text to locate each addressable element by the SAME stable id
// the engine reports. The scan is conservative: it only recognizes the element
// shapes vean + Shotcut actually emit (a `<producer>` whose `shotcut:uuid`
// property carries the clip id; a `<playlist id=…>`/`<tractor id=…>` track; a
// `<transition id=…>` on the main field). A location it can't resolve falls back
// to the document head (range 0:0–0:0) — a diagnostic is never dropped for want
// of a precise span; it just lands at the top of the file.
//
// Offsets are byte/char offsets into the source string; the caller (the LSP)
// converts them to line/character `Position`s with the language-server
// `TextDocument` (`positionAt`), so we never reimplement line counting here.
import type { DiagnosticLocation } from "../diagnostics/types";

/** A half-open character range in the source string: `[start, end)`. */
export type SourceSpan = { start: number; end: number };

/** The lexical index of one `.mlt` document: where each addressable element's
 *  defining text lives, keyed by the stable identity the diagnostics engine uses.
 *  Built once per document text; queried per diagnostic. */
export type SourceMap = {
  /** clip uuid → the span of the `<producer>` that defines it. A uuid can map to
   *  MULTIPLE producers (a clip split across a dissolve emits one producer per
   *  segment, all sharing the uuid) — we record the FIRST, which is the clip's
   *  head/primary definition (good enough to anchor the underline at the clip). */
  clips: Map<string, SourceSpan>;
  /** a uuid → the span of the specific `shotcut:uuid` PROPERTY VALUE, a tighter
   *  underline than the whole producer when we want to point at identity itself. */
  clipUuidProp: Map<string, SourceSpan>;
  /** a clip uuid → the span of the `<entry>` that PLAYS it (the first such entry).
   *  This is where the clip's TIMELINE WINDOW lives (`<entry … in="" out=""/>`) —
   *  the parser reads the played window from the entry, not the producer — so a
   *  window-fixing code action (clamp the out-point) rewrites HERE. A clip played
   *  only inside a nested dissolve tractor (no direct playlist entry) is absent. */
  clipEntries: Map<string, SourceSpan>;
  /** track id (the playlist/tractor `id` attribute) → its element span. */
  tracks: Map<string, SourceSpan>;
  /** field-transition INDEX (document order on the main tractor) → its span.
   *  The engine locates a transition by its ordinal in `timeline.transitions`,
   *  which is exactly the order `<transition>` elements appear on the main
   *  tractor field — so index alignment is by construction. */
  transitions: SourceSpan[];
  /** The whole-document fallback span (0,0) for an unresolvable location. */
  readonly head: SourceSpan;
};

// ─── Element scanning ────────────────────────────────────────────────────────
// A tiny, forgiving lexer: find each `<tag …>` … `</tag>` (or self-closing
// `<tag …/>`) run for the handful of element kinds we address. We do NOT need a
// full XML parser — the parser already validated the document into the IR; this
// is purely a TEXT-LOCATION pass over a document we know is well-formed (it
// parsed). We match the OPENING tag's `<` through the matching close, balancing
// same-named nesting (a `<tractor>` can contain nested `<tractor>`s).

/** Find the end offset (exclusive) of the element whose opening `<tag` starts at
 *  `openLt`. Handles self-closing (`/>`) and balanced same-name nesting. Returns
 *  the index just past the closing `>`. Conservative: on any malformed run it
 *  returns the end of the opening tag, so a span is always non-empty + bounded. */
function elementEnd(text: string, openLt: number, tag: string): number {
  // Locate the end of the opening tag.
  const openGt = text.indexOf(">", openLt);
  if (openGt < 0) return Math.min(text.length, openLt + tag.length + 1);
  // Self-closing `<tag …/>`.
  if (text[openGt - 1] === "/") return openGt + 1;
  // Otherwise balance `<tag` opens against `</tag>` closes.
  const openRe = new RegExp(`<${tag}(?=[\\s/>])`, "g");
  const closeRe = new RegExp(`</${tag}\\s*>`, "g");
  let depth = 1;
  let cursor = openGt + 1;
  while (depth > 0) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const o = openRe.exec(text);
    const c = closeRe.exec(text);
    if (!c) return text.length; // unbalanced — take the rest of the doc
    if (o && o.index < c.index) {
      depth++;
      cursor = o.index + 1;
    } else {
      depth--;
      cursor = c.index + c[0].length;
    }
  }
  return cursor;
}

/** Iterate every top-level-or-nested `<tag …>` opening position in the text.
 *  Yields the offset of each `<`. (We don't care about nesting depth for the
 *  scan itself — we record every occurrence and let the id keys disambiguate.) */
function* openings(text: string, tag: string): Generator<number> {
  const re = new RegExp(`<${tag}(?=[\\s/>])`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) yield m.index;
}

/** Read an attribute value off an opening tag starting at `openLt` (scans only
 *  to the tag's `>`). Returns the unescaped-enough raw value or undefined. */
function readAttr(text: string, openLt: number, name: string): string | undefined {
  const openGt = text.indexOf(">", openLt);
  if (openGt < 0) return undefined;
  const head = text.slice(openLt, openGt + 1);
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(head);
  return m ? m[1] : undefined;
}

/** Within `[from, to)`, find the value span of `<property name="NAME">VALUE</property>`.
 *  Returns both the VALUE span (for a tight underline on identity) and the value
 *  string. Used to pull a producer's `shotcut:uuid`. */
function findProperty(
  text: string,
  from: number,
  to: number,
  propName: string,
): { value: string; span: SourceSpan } | undefined {
  const re = new RegExp(`<property\\s+name="${propName}"\\s*>([^<]*)</property>`, "g");
  re.lastIndex = from;
  const m = re.exec(text);
  if (!m || m.index >= to) return undefined;
  // The capture group's span: locate it inside the full match.
  const valStart = m.index + m[0].indexOf(">", 0) + 1;
  const value = m[1] ?? "";
  return { value, span: { start: valStart, end: valStart + value.length } };
}

// ─── Build ───────────────────────────────────────────────────────────────────
/** Build the source map for a `.mlt` document's raw text. Pure: text in, index
 *  out. Cheap enough to run on every `didChange` (a handful of regex scans over
 *  a document that is, in practice, kilobytes). */
export function buildSourceMap(text: string): SourceMap {
  const clips = new Map<string, SourceSpan>();
  const clipUuidProp = new Map<string, SourceSpan>();
  const clipEntries = new Map<string, SourceSpan>();
  const tracks = new Map<string, SourceSpan>();
  const transitions: SourceSpan[] = [];

  // Producers → clip uuids. A producer's clip identity is its `shotcut:uuid`
  // property (Clip.id round-trips through it — see parse.ts resolveProducer);
  // fall back to the producer's XML `id` attribute when the uuid is absent, which
  // is exactly the parser's fallback, so the keys agree with the IR's clip ids. We
  // also record the producer's XML `id` → clip uuid so an `<entry producer="…">`
  // (which references the producer by XML id) can be tied back to the clip.
  const producerXmlIdToUuid = new Map<string, string>();
  for (const lt of openings(text, "producer")) {
    const end = elementEnd(text, lt, "producer");
    const uuid = findProperty(text, lt, end, "shotcut:uuid");
    const xmlId = readAttr(text, lt, "id");
    const id = uuid?.value ?? xmlId;
    if (!id) continue;
    if (xmlId) producerXmlIdToUuid.set(xmlId, id);
    // FIRST occurrence wins (the head segment of a split-across-dissolve clip).
    if (!clips.has(id)) clips.set(id, { start: lt, end });
    if (uuid && !clipUuidProp.has(id)) clipUuidProp.set(id, uuid.span);
  }

  // Entries → the clip's TIMELINE WINDOW. The parser reads a played clip's
  // `[in,out]` from its `<entry … in="" out=""/>` (not the producer), so this is
  // where a window-clamping code action rewrites. Map each entry to the clip uuid
  // via the producer XML id it references; the FIRST entry for a uuid wins (a
  // dissolve-split clip's head segment). An entry pointing at a nested tractor
  // (a dissolve) references no producer uuid and is skipped.
  for (const lt of openings(text, "entry")) {
    const ref = readAttr(text, lt, "producer");
    if (!ref) continue;
    const uuid = producerXmlIdToUuid.get(ref);
    if (!uuid || clipEntries.has(uuid)) continue;
    const end = elementEnd(text, lt, "entry");
    clipEntries.set(uuid, { start: lt, end });
  }

  // Tracks → playlists (timeline spine) and the main/nested tractors. A track is
  // addressed by its playlist `id` in the IR; index both playlists and tractors
  // by their `id` so either resolves.
  for (const tag of ["playlist", "tractor"] as const) {
    for (const lt of openings(text, tag)) {
      const id = readAttr(text, lt, "id");
      if (!id) continue;
      const end = elementEnd(text, lt, tag);
      if (!tracks.has(id)) tracks.set(id, { start: lt, end });
    }
  }

  // Field transitions → the `<transition>` elements that sit DIRECTLY on the main
  // tractor field, in document order (the engine's `transition` index is the
  // ordinal into `timeline.transitions`, which the parser fills in that same
  // document order). We must EXCLUDE the luma/mix transitions nested inside a
  // dissolve tractor — those are not field transitions. A field transition is the
  // one Shotcut writes with an `id="transitionN"` attribute; the nested
  // dissolve's luma/mix transitions carry NO `id`. That single discriminator
  // (has an `id` attribute) cleanly separates the two, matching how vean emits
  // them (serialize.ts gives field transitions an id; the dissolve's internal
  // pair none).
  const fieldTransitions: Array<{ at: number; span: SourceSpan }> = [];
  for (const lt of openings(text, "transition")) {
    const id = readAttr(text, lt, "id");
    if (!id) continue; // a nested dissolve's luma/mix transition — skip
    const end = elementEnd(text, lt, "transition");
    fieldTransitions.push({ at: lt, span: { start: lt, end } });
  }
  fieldTransitions.sort((a, b) => a.at - b.at);
  for (const t of fieldTransitions) transitions.push(t.span);

  return { clips, clipUuidProp, clipEntries, tracks, transitions, head: { start: 0, end: 0 } };
}

// ─── Query ─────────────────────────────────────────────────────────────────────
/** Resolve a diagnostic's stable-identity location to a source span. Priority:
 *  the most specific anchor a location offers — a clip (tightest available), then
 *  a transition, then a track. An unresolved location returns the document head
 *  (0,0) so the diagnostic still publishes (at the top of the file) rather than
 *  being dropped. Pure. */
export function spanForLocation(map: SourceMap, loc: DiagnosticLocation): SourceSpan {
  if (loc.clip) {
    const s = map.clips.get(loc.clip);
    if (s) return s;
  }
  if (loc.transition != null) {
    const s = map.transitions[loc.transition];
    if (s) return s;
  }
  if (loc.track) {
    const s = map.tracks.get(loc.track);
    if (s) return s;
  }
  return map.head;
}
