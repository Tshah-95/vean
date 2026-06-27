// vean-lsp NAVIGATION — hover / find-references / go-to-definition over the
// `.mlt` document.
//
// This is the READ side of the LSP surface (the write side is `./codeActions`,
// the validity side is the shared `src/diagnostics` engine the `./engine` calls).
// Every answer is computed by reading the SHARED CORE: the IR + source map that
// `analyze` already produced (`./engine`), and the SHARED navigation queries in
// `src/query` — `resolveValueAtFrame` (the "what is the effective value HERE?"
// scope-chain walk) and `findReferences` (the "where else does this appear?" set).
// The bridge NEVER recomputes a resolved value or a reference adjacency itself;
// it locates the element under the cursor (the source map) and delegates the
// answer to the query layer.
//
// PROTOCOL FIDELITY (BUILD-MONITOR review lens #5): these are the standard LSP
// `textDocument/hover`, `textDocument/references`, `textDocument/definition`
// requests — no bespoke surface. The stdio server (`./server`) binds them.
import type { Hover, Location, Position } from "vscode-languageserver/node";
import { FADE_IN_SERVICE, FADE_OUT_SERVICE } from "../../ir/builder";
import type { Clip, Filter, Timeline } from "../../ir/types";
import { startOf } from "../../ops/primitives";
import {
  type ResolveResult,
  type ResolveTarget,
  findReferences,
  resolveValueAtFrame,
} from "../../query";
import { type Analysis, elementAt, findClip, findTrack, locateClipTrack } from "./engine";

// ─── Hover ──────────────────────────────────────────────────────────────────
/** Hover over a position. The cursor identifies an addressable element via the
 *  source map; we report a compact summary read from the IR:
 *
 *   • on a CLIP — its window, resource, filters, gain, AND (the "go-to-definition
 *     for video" payoff) the effective value of each animated/fade parameter AT
 *     the hovered clip's start frame, resolved through the SHARED
 *     `resolveValueAtFrame` query (never recomputed here). This is what makes
 *     hover a real value-resolution surface, not just a property dump.
 *   • on a TRACK — its kind, id, and item count.
 *   • on a TRANSITION — its service, the composited track pair, the timeline
 *     window, and each property's resolved value at the transition's start.
 *
 *  Read-only; reuses the SAME source map + IR the diagnostics use. */
export function hover(analysis: Analysis, position: Position): Hover | null {
  const offset = analysis.doc.offsetAt(position);
  const hit = elementAt(analysis.sourceMap, offset);
  if (!hit || !analysis.state) return null;

  if (hit.kind === "clip") return clipHover(analysis.state, hit.id);
  if (hit.kind === "transition") return transitionHover(analysis.state, Number(hit.id));
  if (hit.kind === "track") {
    const track = findTrack(analysis.state, hit.id);
    if (!track) return null;
    return markdown(`**${track.kind} track** \`${track.id}\` — ${track.items.length} item(s)`);
  }
  return null;
}

/** A clip hover: the static facts (window/resource/filters/gain) PLUS the
 *  resolved effective value of each animated filter property + fade at the clip's
 *  first timeline frame — the value the SHARED resolver reports. */
function clipHover(state: Timeline, id: string): Hover | null {
  const clip = findClip(state, id);
  const loc = locateClipTrack(state, id);
  if (!clip || !loc) return null;
  const playtime = clip.out - clip.in + 1;
  const start = startFrameOf(state, id);

  const lines: string[] = [
    `**clip** \`${clip.id}\``,
    `window: ${clip.in}–${clip.out} (playtime ${playtime})`,
    `resource: \`${clip.resource}\``,
  ];
  if (clip.filters.length) lines.push(`filters: ${clip.filters.map((f) => f.service).join(", ")}`);
  if (clip.gain != null) lines.push(`gain: ${clip.gain}`);

  // The resolved-value section: for each fade / animated property, ask the SHARED
  // query for the effective value at the clip's first frame. This is the
  // hover-as-resolution surface — the bridge locates the target, the query answers.
  const resolved = resolveClipParams(state, clip, start);
  if (resolved.length) {
    lines.push("—");
    lines.push(`resolved @ frame ${start} (clip start):`);
    lines.push(...resolved);
  }
  return markdown(lines.join("\n\n"));
}

/** Resolve every fade + animated filter parameter on `clip` at timeline `frame`
 *  via the SHARED `resolveValueAtFrame`, formatting each as a hover line. A static
 *  (non-animated, non-fade) property is omitted — its value is already shown in the
 *  filter summary and a resolve adds nothing. */
function resolveClipParams(state: Timeline, clip: Clip, frame: number): string[] {
  const lines: string[] = [];
  for (const f of clip.filters) {
    if (f.service === FADE_IN_SERVICE) {
      lines.push(
        formatResolve("fadeIn level", resolveValueAtFrame(state, fadeTarget(clip.id, "in"), frame)),
      );
      continue;
    }
    if (f.service === FADE_OUT_SERVICE) {
      lines.push(
        formatResolve(
          "fadeOut level",
          resolveValueAtFrame(state, fadeTarget(clip.id, "out"), frame),
        ),
      );
      continue;
    }
    for (const [prop, value] of Object.entries(f.properties)) {
      if (!isAnimatedValue(value)) continue;
      const target: ResolveTarget = {
        scope: "clip",
        clip: clip.id,
        service: f.service,
        property: prop,
      };
      lines.push(formatResolve(`${f.service}.${prop}`, resolveValueAtFrame(state, target, frame)));
    }
  }
  return lines;
}

/** A transition hover: service + composited track pair + window + each property's
 *  effective value at the transition's first frame (the SHARED resolver again). */
function transitionHover(state: Timeline, index: number): Hover | null {
  const tr = state.transitions[index];
  if (!tr) return null;
  const lines: string[] = [
    `**transition** #${index} \`${tr.service}\``,
    `composites track ${tr.bTrack} over ${tr.aTrack}`,
    `window: ${tr.in}–${tr.out} (timeline frames)`,
  ];
  const resolved: string[] = [];
  for (const [prop, value] of Object.entries(tr.properties)) {
    if (!isAnimatedValue(value)) continue;
    resolved.push(
      formatResolve(
        prop,
        resolveValueAtFrame(state, { scope: "transition", index, property: prop }, tr.in),
      ),
    );
  }
  if (resolved.length) {
    lines.push("—");
    lines.push(`resolved @ frame ${tr.in} (transition start):`);
    lines.push(...resolved);
  }
  return markdown(lines.join("\n\n"));
}

// ─── References ───────────────────────────────────────────────────────────────
/** Find-all-references for the clip under the cursor: every clip that shares its
 *  SOURCE (same media path / color), located by the source map. Delegates the
 *  reference SET computation to the shared `findReferences` query — the bridge
 *  never recomputes adjacency itself. Returns LSP `Location`s in this document. */
export function references(analysis: Analysis, position: Position): Location[] {
  const offset = analysis.doc.offsetAt(position);
  const hit = elementAt(analysis.sourceMap, offset);
  if (!hit || hit.kind !== "clip" || !analysis.state) return [];
  const clip = findClip(analysis.state, hit.id);
  if (!clip) return [];
  // SHARED query: clips using this source. (The resource is the natural "symbol".)
  const refs = findReferences(analysis.state, { kind: "source", resource: clip.resource });
  if (refs.kind !== "source") return [];
  const out: Location[] = [];
  for (const site of refs.clips) {
    const span = analysis.sourceMap.clips.get(site.uuid);
    if (!span) continue;
    out.push({
      uri: analysis.doc.uri,
      range: {
        start: analysis.doc.positionAt(span.start),
        end: analysis.doc.positionAt(span.end),
      },
    });
  }
  return out;
}

// ─── Definition ────────────────────────────────────────────────────────────────
/** Go-to-definition for the clip under the cursor: the producer that defines its
 *  identity (the `shotcut:uuid` property), the closest thing to a "declaration"
 *  for a clip in `.mlt`. */
export function definition(analysis: Analysis, position: Position): Location | null {
  const offset = analysis.doc.offsetAt(position);
  const hit = elementAt(analysis.sourceMap, offset);
  if (!hit || hit.kind !== "clip") return null;
  const span = analysis.sourceMap.clipUuidProp.get(hit.id) ?? analysis.sourceMap.clips.get(hit.id);
  if (!span) return null;
  return {
    uri: analysis.doc.uri,
    range: {
      start: analysis.doc.positionAt(span.start),
      end: analysis.doc.positionAt(span.end),
    },
  };
}

// ─── small helpers ──────────────────────────────────────────────────────────
function markdown(value: string): Hover {
  return { contents: { kind: "markdown", value } };
}

function fadeTarget(clip: string, direction: "in" | "out"): ResolveTarget {
  return { scope: "fade", clip, direction };
}

/** An MLT property is animated iff its string form carries an `=` (the keyframe
 *  syntax). Mirrors `src/ir/keyframes.isAnimated` without importing it for this
 *  single predicate — a static value resolves to a constant the filter summary
 *  already shows, so hover only resolves the animated ones. */
function isAnimatedValue(value: Filter["properties"][string]): boolean {
  return typeof value === "string" && value.includes("=");
}

/** Format one resolved parameter for a hover line: its scalar value + the
 *  scope that produced it (the SHARED resolver's path tail). */
function formatResolve(label: string, r: ResolveResult): string {
  if (r.notFound) return `- \`${label}\`: ${r.notFound}`;
  const scalar = r.scalar != null ? r.scalar : r.value ? "(non-scalar)" : "—";
  const producer = r.path.find((h) => h.produced)?.scope;
  const via = producer ? ` _(via ${producer})_` : "";
  const live = r.live ? "" : " _(playhead off clip)_";
  return `- \`${label}\`: ${scalar}${via}${live}`;
}

/** The timeline start frame of a clip — delegated to the SHARED `startOf`
 *  primitive (the same one `findReferences`/`resolveValueAtFrame` use), so a
 *  hover's resolve frame agrees with the reference set and the resolver by
 *  construction. The bridge never re-derives positions. */
function startFrameOf(state: Timeline, id: string): number {
  const loc = locateClipTrack(state, id);
  if (!loc) return 0;
  const itemIndex = loc.track.items.findIndex((it) => it.kind === "clip" && it.id === id);
  if (itemIndex < 0) return 0;
  return startOf(loc.track.items, itemIndex);
}
