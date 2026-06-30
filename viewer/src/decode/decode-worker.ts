// The mediabunny DECODE WORKER (DESIGN-LIVE-PREVIEW §5, §9 step 3).
//
// Runs OFF the main thread so decode never steals from the 16ms paint/composite
// budget (§5 "worker pool"). It wraps mediabunny — pure-TS demux + WebCodecs
// hardware decode + frame-accurate random-access seek — behind two messages:
//   • `open`   : create the `Input` + `CanvasSink` for one clip ONCE (per-clip
//                resource cache, keyed by the producer UUID), reused across seeks.
//   • `decode` : `sink.getCanvas(sourceSeconds)` → the frame whose start ts ≤ time,
//                turned into a transferable `ImageBitmap` posted zero-copy.
//
// OFFLINE-FIRST (§5 caveat): mediabunny is a STATIC `import` here, NOT an `esm.sh`
// CDN fallback. Vite's worker build bundles it INTO this worker chunk, so the
// served viewer needs no network — the no-network Hard boundary (#3) holds and
// the worker can never hang waiting on an unreachable CDN. (OpenReel's
// `decode-worker.ts:44-61` keeps the CDN fallback for its hosted, online editor;
// the doc explicitly says to DROP it for vean.)
//
// LICENSING: mediabunny is MPL-2.0 — depended on as a package, never vendored and
// edited. It links no GPL code, never touches `melt`/`libmlt`, and lives entirely
// on the viewer side (Hard boundary #1/#2; doc §2).
//
// LIFETIME (§8.3 — the dominant failure mode): every `getCanvas` reuses one of a
// small POOL of canvases (mediabunny ring buffer, `poolSize`), so the worker's own
// VRAM stays bounded. The `ImageBitmap` we mint per decode is OWNED BY THE MAIN
// THREAD once transferred — the receiver (`decoder.ts` → the frame cache) is
// responsible for `close()`ing it on evict/replace. The worker holds no reference
// to it after `postMessage`.
import {
  ALL_FORMATS,
  BlobSource,
  CanvasSink,
  Input,
  type InputVideoTrack,
  type WrappedCanvas,
} from "mediabunny";
import type {
  DecodeRequest,
  DecodeResponse,
  OpenRequest,
  OpenResponse,
  WorkerRequest,
} from "./protocol";

/** A clip's cached decode resources (created once per producer UUID, §5). */
interface ClipResource {
  input: Input;
  track: InputVideoTrack;
  sink: CanvasSink;
}

const resources = new Map<string, ClipResource>();
const workerId = Math.floor(Math.random() * 1_000_000);

/** Pool size for the per-clip `CanvasSink` ring buffer. Keeps the worker's VRAM
 *  constant across seeks instead of allocating/freeing a canvas per frame (§8.3).
 *  Small — we mint a fresh `ImageBitmap` per decode and hand ownership to the main
 *  thread, so the sink only needs a few in-flight canvases. */
const SINK_POOL_SIZE = 4;

async function openClip(req: OpenRequest): Promise<OpenResponse> {
  const { requestId, clipId, blob, width, height } = req;
  // Idempotent: re-opening a clip already cached is a no-op success (the main
  // thread may race an `open` with an in-flight one; we just keep the first).
  if (resources.has(clipId)) {
    return { type: "opened", requestId, clipId, ok: true };
  }
  try {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
    const track = await input.getPrimaryVideoTrack();
    if (!track) {
      input[Symbol.dispose]?.();
      return { type: "opened", requestId, clipId, ok: false, error: "no video track in proxy" };
    }
    // `fit: contain` preserves the source aspect inside the output box (the
    // compositor letterboxes); `poolSize` bounds VRAM (§8.3). The proxy is already
    // downscaled server-side, so width/height here is the compositor's target box.
    const sink = new CanvasSink(track, {
      width,
      height,
      fit: "contain",
      poolSize: SINK_POOL_SIZE,
    });
    resources.set(clipId, { input, track, sink });
    return {
      type: "opened",
      requestId,
      clipId,
      ok: true,
      trackWidth: track.displayWidth,
      trackHeight: track.displayHeight,
    };
  } catch (error) {
    return {
      type: "opened",
      requestId,
      clipId,
      ok: false,
      error: error instanceof Error ? error.message : "open failed",
    };
  }
}

async function decodeFrame(req: DecodeRequest): Promise<DecodeResponse> {
  const { requestId, clipId, time } = req;
  const res = resources.get(clipId);
  if (!res) {
    return {
      type: "decoded",
      requestId,
      clipId,
      bitmap: null,
      time,
      error: "clip not opened",
    };
  }
  try {
    const wrapped: WrappedCanvas | null = await res.sink.getCanvas(time);
    if (!wrapped?.canvas) {
      return { type: "decoded", requestId, clipId, bitmap: null, time, error: "no frame at time" };
    }
    // Mint a transferable bitmap from the (pooled, soon-reused) canvas. This copy
    // is what crosses to the main thread; the pooled canvas is free to be reused by
    // the next `getCanvas`. The main thread now OWNS this bitmap (§8.3 close-on-evict).
    const bitmap = await createImageBitmap(wrapped.canvas);
    return { type: "decoded", requestId, clipId, bitmap, timestamp: wrapped.timestamp, time };
  } catch (error) {
    return {
      type: "decoded",
      requestId,
      clipId,
      bitmap: null,
      time,
      error: error instanceof Error ? error.message : "decode failed",
    };
  }
}

function closeClip(clipId: string): void {
  const res = resources.get(clipId);
  if (!res) return;
  // Dispose the Input (frees the demuxer + any decoder the sink holds). The
  // sink/track are owned by the Input's lifetime.
  res.input[Symbol.dispose]?.();
  resources.delete(clipId);
}

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  switch (req.type) {
    case "init":
      ctx.postMessage({ type: "ready", workerId });
      break;
    case "open": {
      const resp = await openClip(req);
      ctx.postMessage(resp);
      break;
    }
    case "decode": {
      const resp = await decodeFrame(req);
      // Zero-copy transfer of the decoded bitmap (§5 worker pool).
      if (resp.bitmap) ctx.postMessage(resp, [resp.bitmap]);
      else ctx.postMessage(resp);
      break;
    }
    case "close":
      closeClip(req.clipId);
      break;
  }
};
