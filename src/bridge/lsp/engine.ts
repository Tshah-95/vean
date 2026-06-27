import { TextDocument } from "vscode-languageserver-textdocument";
// The vean-lsp ENGINE — the pure, transport-free CORE of the language server.
//
// This module owns ONE thing: turn a document's URI + text into its `Analysis`
// (the parsed IR + the LSP-shaped diagnostics with text ranges + the source map),
// by calling the SHARED CORE — `collectDiagnostics` (src/diagnostics) and the
// source map (src/ir/source-map) — and NOTHING ELSE. No rule lives here. Putting a
// diagnostics rule in the bridge is the explicit BUILD-MONITOR escalation trigger;
// this module's whole job is to ADAPT the shared engine's output to LSP shapes,
// never to compute validity itself.
//
// The navigation surface (hover / references / definition) lives in `./navigation`
// and the deterministic repairs in `./codeActions`; both consume the `Analysis`
// this module produces plus the small element-locating helpers it exports here, so
// the engine stays the single place the IR is parsed + diagnosed and the two LSP
// feature surfaces stay small and focused. The stdio server (`./server`) wires the
// JSON-RPC handlers to `analyze` + those two modules.
//
// Because it is transport-free, the ambient smoke test drives THIS directly:
// `analyze(uri, text)` runs the exact same path the stdio `onDidChange` handler
// runs, so the test proves the ambient behavior (didChange → publishDiagnostics)
// without spawning a process or mocking a JSON-RPC connection.
import {
  DiagnosticSeverity,
  type Diagnostic as LspDiagnostic,
  type Position,
  type Range,
} from "vscode-languageserver/node";
import {
  type Severity,
  type Diagnostic as VeanDiagnostic,
  collectDiagnostics,
} from "../../diagnostics";
import { fromMlt } from "../../ir/parse";
import { type SourceMap, buildSourceMap, spanForLocation } from "../../ir/source-map";
import type { Clip, Timeline, Track } from "../../ir/types";

const SOURCE = "vean";

// ─── Severity mapping (vean → LSP) ──────────────────────────────────────────
/** vean severities are the LSP severities by another name; map them 1:1 so the
 *  editor colours each diagnostic the same way the engine ranked it. */
const SEVERITY: Record<Severity, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

// ─── The per-document analysis result ───────────────────────────────────────
/** Everything the engine derives for one document version: the parsed IR (or a
 *  parse error), the raw vean diagnostics, the LSP-shaped diagnostics (with text
 *  ranges), and the source map for follow-up navigation/code-action queries. */
export type Analysis = {
  uri: string;
  doc: TextDocument;
  /** The parsed IR, or undefined if the text didn't parse (a malformed `.mlt`). */
  state?: Timeline;
  /** The shared engine's diagnostics (stable-identity locations). */
  veanDiagnostics: VeanDiagnostic[];
  /** The same set mapped to LSP diagnostics with document ranges — the
   *  `publishDiagnostics` payload. EMPTY clears prior diagnostics. */
  lspDiagnostics: LspDiagnostic[];
  /** The source map (id → text span) for this document version. */
  sourceMap: SourceMap;
};

// ─── analyze — the one entry the sync handlers call ─────────────────────────
/** Parse a `.mlt` document and produce its full LSP diagnostic set. This IS the
 *  ambient path: an LSP `onDidOpen`/`onDidChange` calls `analyze` then publishes
 *  `result.lspDiagnostics` — no manual `diagnose` step, ever.
 *
 *  Parse failures become a single document-head error (a malformed file is itself
 *  a diagnostic the agent should see), so the publish call always has a defined
 *  payload. */
export function analyze(uri: string, text: string): Analysis {
  const doc = TextDocument.create(uri, "mlt", 0, text);
  const sourceMap = buildSourceMap(text);

  let state: Timeline | undefined;
  let veanDiagnostics: VeanDiagnostic[] = [];
  try {
    state = fromMlt(text);
    // THE SHARED ENGINE — the one place rules live. The LSP only adapts its output.
    veanDiagnostics = collectDiagnostics(state);
  } catch (err) {
    // A document that doesn't even parse is a real, publishable defect. Surface it
    // as a synthetic diagnostic at the head so the agent sees it ambiently too.
    const message = err instanceof Error ? err.message : String(err);
    const lsp: LspDiagnostic = {
      range: headRange(doc),
      severity: DiagnosticSeverity.Error,
      source: SOURCE,
      code: "parse-error",
      message: `vean could not parse this .mlt: ${message}`,
    };
    return { uri, doc, veanDiagnostics: [], lspDiagnostics: [lsp], sourceMap };
  }

  const lspDiagnostics = veanDiagnostics.map((d) => toLspDiagnostic(d, doc, sourceMap));
  return { uri, doc, state, veanDiagnostics, lspDiagnostics, sourceMap };
}

// ─── vean Diagnostic → LSP Diagnostic ───────────────────────────────────────
/** Adapt one shared-engine diagnostic to the LSP shape: map its stable-identity
 *  location to a text range via the source map, carry the stable `code`, the
 *  severity, and fold a `fix` hint into the message tail. `relatedInformation`
 *  is mapped through the same source map so "see also" anchors land in the text. */
export function toLspDiagnostic(
  d: VeanDiagnostic,
  doc: TextDocument,
  map: SourceMap,
): LspDiagnostic {
  const span = spanForLocation(map, d.location);
  const range: Range = { start: doc.positionAt(span.start), end: doc.positionAt(span.end) };
  const out: LspDiagnostic = {
    range,
    severity: SEVERITY[d.severity],
    source: SOURCE,
    code: d.code,
    message: d.fix ? `${d.message}\n↳ fix: ${d.fix}` : d.message,
  };
  if (d.related && d.related.length > 0) {
    out.relatedInformation = d.related.map((r) => {
      const rs = spanForLocation(map, r.location);
      return {
        location: {
          uri: doc.uri,
          range: { start: doc.positionAt(rs.start), end: doc.positionAt(rs.end) },
        },
        message: r.message,
      };
    });
  }
  return out;
}

/** A zero-width range at the document head — the fallback anchor + the parse-error
 *  anchor. */
function headRange(doc: TextDocument): Range {
  const at: Position = doc.positionAt(0);
  return { start: at, end: at };
}

// ─── Shared element-locating helpers (consumed by ./navigation + ./codeActions) ─
// The hover/references/definition handlers and the code-action repairs all need to
// (a) find the addressable element under a cursor offset and (b) read a clip/track
// out of the IR by stable id. Those live here, beside `analyze`, so both feature
// modules share one implementation rather than re-deriving "what's under the
// cursor" twice. They are pure reads over the source map + the IR — never a rule.

/** What kind of addressable element a source-map hit names, + its stable id. */
export type ElementHit = { kind: "clip" | "track" | "transition"; id: string };

/** Which addressable element's span contains `offset` (the tightest/innermost
 *  one). Clips are innermost (a producer nests no addressable child), so we check
 *  clips first, then transitions, then tracks. */
export function elementAt(map: SourceMap, offset: number): ElementHit | undefined {
  for (const [id, span] of map.clips) {
    if (offset >= span.start && offset < span.end) return { kind: "clip", id };
  }
  for (let i = 0; i < map.transitions.length; i++) {
    const span = map.transitions[i];
    if (span && offset >= span.start && offset < span.end) {
      return { kind: "transition", id: String(i) };
    }
  }
  for (const [id, span] of map.tracks) {
    if (offset >= span.start && offset < span.end) return { kind: "track", id };
  }
  return undefined;
}

/** Find a clip by stable uuid across every track (video then audio). */
export function findClip(state: Timeline, id: string): Clip | undefined {
  for (const track of [...state.tracks.video, ...state.tracks.audio]) {
    for (const item of track.items) {
      if (item.kind === "clip" && item.id === id) return item;
    }
  }
  return undefined;
}

/** Find the (kind, index) of the track a clip sits on — the timeline coordinates a
 *  positional resolve (resolveValueAtFrame) needs to translate a clip-local frame. */
export function locateClipTrack(
  state: Timeline,
  id: string,
): { track: Track; kind: "video" | "audio"; index: number } | undefined {
  for (const kind of ["video", "audio"] as const) {
    const list = state.tracks[kind];
    for (let i = 0; i < list.length; i++) {
      const track = list[i] as Track;
      if (track.items.some((it) => it.kind === "clip" && it.id === id)) {
        return { track, kind, index: i };
      }
    }
  }
  return undefined;
}

/** Find a track by stable id (video then audio). */
export function findTrack(state: Timeline, id: string): Track | undefined {
  return [...state.tracks.video, ...state.tracks.audio].find((t) => t.id === id);
}

/** Do two ranges overlap (inclusive)? Used to gate code actions to the requested
 *  range. */
export function overlaps(a: Range, b: Range): boolean {
  return !before(a.end, b.start) && !before(b.end, a.start);
}

/** Is position `p` strictly before `q`? */
function before(p: Position, q: Position): boolean {
  if (p.line !== q.line) return p.line < q.line;
  return p.character < q.character;
}
