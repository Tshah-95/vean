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
