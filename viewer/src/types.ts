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

/** A filter on a clip, as the core IR serializes it to the timeline JSON. The
 *  viewer reads a SUBSET: fade sentinels (`vean.fadeIn`/`vean.fadeOut`), the
 *  `brightness`/`level` and `volume`/`gain` fade/static filters, and the
 *  animation-string escape hatch — enough for the Tier-1 compositor's exact-row
 *  §7 mapping (opacity, fades). Unknown filters are flagged `approximate` and fall
 *  back to a `melt` still (§6.3, §7). */
export interface ClipFilter {
  service: string;
  properties: Record<string, string | number | boolean>;
  shotcutName?: string;
}

export interface ClipItem {
  kind: "clip";
  id: string;
  resource: string;
  /** MLT load key (`mlt_service`). `"color"` marks a solid-fill quad (resource is
   *  a hex/named color, NOT a decodable file) — §7 "color clip → solid-fill quad".
   *  Omitted → a footage file the decoder demuxes. */
  service?: string;
  in: number;
  out: number;
  length?: number;
  /** Audio gain multiplier (1 = unity), compiled to a `volume`/`gain` filter. */
  gain?: number;
  /** Filters on this clip (fades, color ops, the animation-string escape hatch).
   *  Present in the timeline JSON; the Tier-1 compositor resolves the exact-row
   *  subset (§7) and flags the rest `approximate`. */
  filters?: ClipFilter[];
  label?: string;
  /** Remotion-composition identity — present iff this clip names a composition.
   *  Mirrors `Clip.composition` in src/ir/types.ts; round-trips through the
   *  `vean:composition` / `vean:compositionProps` producer properties. Two consumers
   *  read it: the live `@remotion/player` overlay renders the named composition with
   *  these props (so the preview is the SAME comp the producer bakes, not a hardcoded
   *  stand-in — S7), and a baked alpha .mov overlay is FOOTAGE-composited by the WebGL
   *  compositor (the legacy path). */
  composition?: { id: string; props?: Record<string, unknown> };
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
  /** The author of the edit a next undo would revert, or null when the undo stack
   *  is empty. The GUI labels/guards its undo with this so a human never silently
   *  reverts an agent's edit (the agent-scoped undo boundary). Mirrors
   *  `src/preview/session.ts`. */
  nextUndoAuthor?: string | null;
  /** The author of the edit a next redo would re-apply, or null when empty. */
  nextRedoAuthor?: string | null;
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

/** Is this clip a Remotion OVERLAY — a baked alpha .mov carrying `composition`
 *  metadata? A clip is a Remotion overlay iff it has that metadata. UNLIKE the legacy
 *  `isGraphicClip` (the @remotion/player live-player path), a Remotion overlay is
 *  FOOTAGE-composited: its alpha .mov is decoded + drawn by the WebGL compositor, so
 *  it must NEVER route to the hardcoded LowerThird OverlayPlayer nor be excluded from
 *  the footage compositor. Mirrors `Clip.composition` in src/ir/types.ts. */
export function isRemotionOverlay(item: Item): boolean {
  return item.kind === "clip" && !!item.composition;
}
