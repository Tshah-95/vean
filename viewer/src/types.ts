// IR-mirror types for the viewer UI. These intentionally mirror a SUBSET of
// vean's `src/ir/types.ts` (the shape the /api/timeline endpoint returns), kept
// local so the viewer is a standalone web app with no import into the core. The
// server is the source of truth; these types describe its JSON.

export type Fps = [number, number];

export interface Profile {
  description: string;
  width: number;
  height: number;
  fps: Fps;
  displayAspectNum: number;
  displayAspectDen: number;
}

export interface ClipItem {
  kind: "clip";
  id: string;
  resource: string;
  in: number;
  out: number;
  length?: number;
  label?: string;
}

export interface BlankItem {
  kind: "blank";
  length: number;
}

export interface DissolveItem {
  kind: "dissolve";
  frames: number;
  luma?: string;
}

export type Item = ClipItem | BlankItem | DissolveItem;

export interface Track {
  kind: "video" | "audio";
  id: string;
  name?: string;
  items: Item[];
  hidden?: boolean;
}

export interface Transition {
  service: string;
  aTrack: number;
  bTrack: number;
  in: number;
  out: number;
}

export interface Timeline {
  profile: Profile;
  tracks: { video: Track[]; audio: Track[] };
  transitions: Transition[];
  title: string;
}

/** /api/timeline response. */
export interface TimelineResponse {
  ok: true;
  resolvedPath: string;
  route: string;
  profile: Profile;
  fps: Fps;
  totalFrames: number;
  timeline: Timeline;
}

/** /api/proxy-render response. */
export interface ProxyResponse {
  ok: true;
  proxyUrl: string;
  fps: Fps;
  totalFrames: number;
  width: number;
  height: number;
  cached: boolean;
}

export interface ApiError {
  ok: false;
  kind: string;
  detail: string;
}

// ─── Edit-loop wire types (mirror src/preview/session.ts + src/diagnostics) ───
// The viewer is the local-app GUI consumer of the ambient diagnostic set: each
// apply/undo/redo returns the new IR, the structured consequences, and the FULL
// current diagnostic set (LSP-style). These mirror the server's SessionEditResult.

export type Severity = "error" | "warning" | "info" | "hint";

export interface DiagnosticLocation {
  clip?: string;
  track?: string;
  transition?: number;
  filter?: number;
  range?: { from: number; to: number };
}

export interface Diagnostic {
  code: string;
  severity: Severity;
  source: string;
  message: string;
  location: DiagnosticLocation;
  fix?: string;
  data?: Record<string, number | string | boolean>;
}

export interface DiagnosticHealth {
  errors: number;
  warnings: number;
  info?: number;
  hint?: number;
  clean?: boolean;
}

/** The structured "what changed" report from the edit algebra (subset used here). */
export interface RippleEffect {
  track: string;
  shift: number;
  from: number;
}
export interface Consequences {
  durationDelta: number;
  ripple: RippleEffect[];
  warnings: Array<{ code: string; detail: string }>;
  // The remaining fields (clipsMoved, clipsTrimmed, …) are present on the wire
  // but the viewer re-renders straight from `ir`, so they are not typed here.
  [key: string]: unknown;
}

/** A successful /api/apply-op | /api/undo | /api/redo response. */
export interface SessionEditResult {
  ok: true;
  ir: Timeline;
  consequences: Consequences;
  diagnostics: Diagnostic[];
  health: DiagnosticHealth;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  /** Monotonic per-session counter, bumped on every op/undo/redo. The live-preview
   *  compositor keys its recomposite on `(currentFrame, revision)` (the HMR
   *  trigger). Mirrors `src/preview/session.ts` SessionEditResult.revision. */
  revision: number;
}

/** A successful /api/save response. */
export interface SaveResult {
  ok: true;
  path: string;
}

/** One op invocation the viewer sends to /api/apply-op. */
export interface OpInvocation {
  op: string;
  args: Record<string, unknown>;
}

/** A track address as the edit algebra accepts it (by stable id). */
export type TrackAddr = { trackId: string } | { kind: "video" | "audio"; index: number };

/** The number of timeline frames a placed item occupies. */
export function itemPlaytime(item: Item): number {
  if (item.kind === "clip") return item.out - item.in + 1;
  if (item.kind === "blank") return item.length;
  return item.frames;
}

/** A clip placed on a track with its computed timeline-frame start. */
export interface PlacedItem {
  item: Item;
  start: number;
  length: number;
}

/** Walk a track's items into placed items with frame-accurate start positions. */
export function placeItems(track: Track): PlacedItem[] {
  const placed: PlacedItem[] = [];
  let cursor = 0;
  for (const item of track.items) {
    const length = itemPlaytime(item);
    placed.push({ item, start: cursor, length });
    cursor += length;
  }
  return placed;
}

/** Is this clip a Remotion graphic overlay? (mirrors src/preview/proxy isGraphicClip) */
export function isGraphicClip(item: Item): boolean {
  if (item.kind !== "clip") return false;
  if (item.label && /^graphic\b/i.test(item.label)) return true;
  return /cache\/remotion\//.test(item.resource.replace(/\\/g, "/"));
}
