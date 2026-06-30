// The decode-worker WIRE PROTOCOL (DESIGN-LIVE-PREVIEW §5). Shared by the main-
// thread client (`decoder.ts`) and the Vite worker (`decode-worker.ts`) so both
// sides type the same messages. Kept in its own module (no mediabunny import) so
// importing it on the main thread never pulls the decode library onto the main
// bundle — the heavy `mediabunny` import lives ONLY in the worker, which Vite
// bundles separately.

/** Open a clip's decode resources from an already-fetched proxy blob. Sent once
 *  per clip (keyed by the clip's stable producer UUID); the worker creates the
 *  mediabunny `Input` + `CanvasSink` once and reuses them across every seek —
 *  re-creating the demuxer per frame is the classic perf trap (§5). */
export interface OpenRequest {
  type: "open";
  requestId: string;
  /** The clip's stable producer UUID — the decode/seek identity. NOT the timeline
   *  index, so the resources survive ripple/trim edits that only move the clip. */
  clipId: string;
  /** The short-GOP H.264 proxy bytes (fetched once on the main thread from
   *  `/api/source-proxy`). Transferred zero-copy. */
  blob: Blob;
  /** Output canvas box (the proxy is decoded/scaled into this; fit: contain). */
  width: number;
  height: number;
}

export interface OpenResponse {
  type: "opened";
  requestId: string;
  clipId: string;
  ok: boolean;
  /** The track's natural display dimensions, for diagnostics. */
  trackWidth?: number;
  trackHeight?: number;
  error?: string;
}

/** Decode the frame whose start timestamp ≤ `time` seconds (mediabunny
 *  `getCanvas` semantics — the last frame in presentation order at-or-before the
 *  requested time). The clip's resources must already be `open`ed. */
export interface DecodeRequest {
  type: "decode";
  requestId: string;
  clipId: string;
  /** Source time in SECONDS. The caller derives this from the integer source frame
   *  via the exact rational `sourceFrame * fps[1] / fps[0]` (never a float fps) —
   *  the conversion happens at this decode boundary only (§4 step 1). */
  time: number;
}

export interface DecodeResponse {
  type: "decoded";
  requestId: string;
  clipId: string;
  /** The decoded frame as a transferable `ImageBitmap`, or null if no frame exists
   *  at the requested time (before the track's first ts, or a decode failure). The
   *  receiver OWNS this bitmap and MUST `close()` it on evict/replace (§8.3). */
  bitmap: ImageBitmap | null;
  /** The actual presentation timestamp (seconds) of the returned frame. */
  timestamp?: number;
  time: number;
  error?: string;
}

/** Release one clip's resources (the worker disposes the `Input`). Sent on cache
 *  eviction of a clip. */
export interface CloseRequest {
  type: "close";
  clipId: string;
}

export interface ReadyResponse {
  type: "ready";
  workerId: number;
}

export type WorkerRequest = OpenRequest | DecodeRequest | CloseRequest | { type: "init" };
export type WorkerResponse = OpenResponse | DecodeResponse | ReadyResponse;
