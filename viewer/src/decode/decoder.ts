// The main-thread DECODER CLIENT for the live in-browser footage decode path
// (DESIGN-LIVE-PREVIEW §5, §9 step 3).
//
// This is the main-thread half of the mediabunny decode pipeline: it owns the
// worker, fetches each clip's short-GOP H.264 proxy ONCE, and exposes one async
// call — `decodeAt(clipId, resource, sourceSeconds)` → `ImageBitmap | null` — that
// the Tier-1 `renderFrame` compositor will pull a footage layer from. (This step
// stands up + proves the decode layer; the compositor that consumes it is §9
// step 4.)
//
// WHY a worker via Vite's `new Worker(new URL(...), { type: "module" })`: that is
// the idiomatic Vite worker import — Vite bundles `decode-worker.ts` (and the
// `mediabunny` it imports) into a SEPARATE chunk, served from the same origin, no
// CDN (§5 offline-first caveat, Hard boundary #3). The heavy decode library never
// lands on the main bundle, and decode runs off the paint thread (§5).
//
// PER-CLIP RESOURCE CACHE (§5): keyed by the clip's stable producer UUID. The proxy
// blob is fetched once and the worker creates the demuxer/sink once; subsequent
// seeks reuse them. Identity is the UUID (not timeline position), so the cache
// survives ripple/trim edits that only move the clip.
//
// IN-FLIGHT BOUND BY COUNT (§8.3, §8.5): the WebCodecs decoder has a hard in-flight
// limit and hangs SILENTLY past it. We serialize through one worker with a small
// concurrency cap and a latest-wins queue, so a scrub burst never floods the
// decoder. (The full worker POOL + decode-ahead LRU is Tier 2a / §9 step 5; this
// is the correct, bounded single-worker foundation.)
import type { DecodeResponse, OpenResponse, WorkerRequest, WorkerResponse } from "./protocol";

/** URL for the per-source short-GOP H.264 proxy of `resource` on `route` — the
 *  bytes mediabunny demuxes. The server builds it once (cached) and streams it
 *  Range-capable; the same allowlist as `/api/media` authorizes it. */
export function sourceProxyUrl(resource: string, route?: string): string {
  const qs = new URLSearchParams({ path: resource });
  if (route) qs.set("route", route);
  return `/api/source-proxy?${qs.toString()}`;
}

/** A decoded frame plus its actual presentation timestamp (seconds). */
export interface DecodedFrame {
  bitmap: ImageBitmap;
  timestamp: number;
}

interface Pending {
  resolve: (resp: DecodeResponse | OpenResponse) => void;
}

/** Per-clip state on the main thread: the in-flight `open` promise (so concurrent
 *  decode requests for a not-yet-opened clip await ONE fetch+open, never N). */
interface ClipState {
  /** Resolves once the worker has the clip's resources (or rejects on failure). */
  opened: Promise<boolean>;
  /** The output box the sink was opened with (so a box change forces a re-open). */
  width: number;
  height: number;
  /** Exact fetched URL. Prevents a direct-fixture proof from reusing a source-proxy open. */
  sourceUrl: string;
}

let nextRequestId = 0;

export class Decoder {
  private worker: Worker;
  private pending = new Map<string, Pending>();
  private clips = new Map<string, ClipState>();
  /** Concurrency cap on in-flight decode messages (§8.5 hard decoder limit). */
  private readonly maxInFlight = 2;
  private inFlight = 0;
  private queue: Array<() => void> = [];
  private ready: Promise<void>;

  constructor() {
    // Vite bundles this worker + its mediabunny import into a same-origin module
    // chunk. No CDN, no network (§5, Hard boundary #3).
    this.worker = new Worker(new URL("./decode-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.type === "ready") return; // handled by the init promise below
      const p = this.pending.get(msg.requestId);
      if (p) {
        this.pending.delete(msg.requestId);
        p.resolve(msg);
      }
    };
    this.ready = new Promise<void>((resolveReady) => {
      const onReady = (event: MessageEvent<WorkerResponse>) => {
        if (event.data.type === "ready") {
          this.worker.removeEventListener("message", onReady);
          resolveReady();
        }
      };
      this.worker.addEventListener("message", onReady);
      this.post({ type: "init" });
    });
  }

  private post(req: WorkerRequest, transfer?: Transferable[]): void {
    this.worker.postMessage(req, transfer ?? []);
  }

  /** Send a request that expects a single matching response (open/decode). */
  private request<T extends DecodeResponse | OpenResponse>(
    req: Extract<WorkerRequest, { requestId: string }>,
    transfer?: Transferable[],
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      this.pending.set(req.requestId, { resolve: resolve as Pending["resolve"] });
      this.post(req, transfer);
    });
  }

  /** Ensure the clip's proxy is fetched + opened in the worker exactly once. A box
   *  change (the compositor target size) re-opens with the new dimensions. */
  private ensureOpen(
    clipId: string,
    resource: string,
    width: number,
    height: number,
    route?: string,
  ): Promise<boolean> {
    return this.ensureOpenUrl(clipId, sourceProxyUrl(resource, route), width, height);
  }

  /** Open an already-derived proxy URL through the same worker/Mediabunny
   * `CanvasSink({ alpha: true })` path used by product decoding. This is exposed
   * only through the existing decode proof bridge so H07 can distinguish the
   * product decoder from WKWebView's `<video>` compositing behavior. */
  private ensureOpenUrl(
    clipId: string,
    sourceUrl: string,
    width: number,
    height: number,
  ): Promise<boolean> {
    const existing = this.clips.get(clipId);
    if (
      existing &&
      existing.width === width &&
      existing.height === height &&
      existing.sourceUrl === sourceUrl
    ) {
      return existing.opened;
    }
    if (existing) {
      // Box changed → drop + re-open at the new size.
      this.post({ type: "close", clipId });
    }
    const opened = (async () => {
      await this.ready;
      // Fetch the short-GOP H.264 proxy bytes ONCE (the server transcodes on first
      // touch, then serves from cache). Range not needed — mediabunny's BlobSource
      // reads the whole blob; the proxy is small (≤960px short-GOP).
      const res = await fetch(sourceUrl);
      if (!res.ok) throw new Error(`source-proxy ${res.status}`);
      const blob = await res.blob();
      const requestId = `open-${nextRequestId++}`;
      const resp = await this.request<OpenResponse>({
        type: "open",
        requestId,
        clipId,
        blob,
        width,
        height,
      });
      if (!resp.ok) throw new Error(resp.error ?? "open failed");
      return true;
    })();
    this.clips.set(clipId, { opened, width, height, sourceUrl });
    // A rejected open should not poison the cache forever — drop it so a later
    // attempt can retry (e.g. the proxy was still encoding on the first touch).
    opened.catch(() => {
      if (this.clips.get(clipId)?.opened === opened) this.clips.delete(clipId);
    });
    return opened;
  }

  /** Acquire an in-flight slot (§8.5 cap), running `fn` when one frees up. */
  private withSlot<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.inFlight++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.inFlight--;
            const next = this.queue.shift();
            if (next) next();
          });
      };
      if (this.inFlight < this.maxInFlight) run();
      else this.queue.push(run);
    });
  }

  /**
   * Decode the footage frame of clip `clipId` (its source `resource`) at
   * `sourceSeconds`. Returns the decoded `ImageBitmap` + its presentation timestamp,
   * or `null` if no frame exists there / decode failed. The CALLER owns the returned
   * bitmap and MUST `close()` it when done (§8.3 — close-on-evict is the dominant
   * failure mode; this client never holds a reference after resolving).
   *
   * `clipId` is the clip's stable producer UUID; `width`/`height` is the compositor
   * output box. Concurrent calls for the same not-yet-opened clip share ONE
   * fetch+open. In-flight decodes are capped (§8.5).
   */
  async decodeAt(
    clipId: string,
    resource: string,
    sourceSeconds: number,
    width: number,
    height: number,
    route?: string,
  ): Promise<DecodedFrame | null> {
    const opened = await this.ensureOpen(clipId, resource, width, height, route);
    if (!opened) return null;
    return this.decodeOpened(clipId, sourceSeconds);
  }

  /** Decode exact pre-derived proxy bytes without invoking the source transcode
   * endpoint. The worker, Mediabunny demux/decode, CanvasSink alpha merge, bitmap
   * ownership, and in-flight bounds remain identical to `decodeAt`. */
  async decodeProxyUrlAt(
    clipId: string,
    sourceUrl: string,
    sourceSeconds: number,
    width: number,
    height: number,
  ): Promise<DecodedFrame | null> {
    const opened = await this.ensureOpenUrl(clipId, sourceUrl, width, height);
    if (!opened) return null;
    return this.decodeOpened(clipId, sourceSeconds);
  }

  private decodeOpened(clipId: string, sourceSeconds: number): Promise<DecodedFrame | null> {
    return this.withSlot(async () => {
      const requestId = `decode-${nextRequestId++}`;
      const resp = await this.request<DecodeResponse>({
        type: "decode",
        requestId,
        clipId,
        time: sourceSeconds,
      });
      if (!resp.bitmap) return null;
      return { bitmap: resp.bitmap, timestamp: resp.timestamp ?? sourceSeconds };
    });
  }

  /** Release one clip's worker resources (on cache eviction). */
  close(clipId: string): void {
    this.clips.delete(clipId);
    this.post({ type: "close", clipId });
  }

  /** Tear down the worker (on unmount). */
  dispose(): void {
    for (const clipId of this.clips.keys()) this.post({ type: "close", clipId });
    this.clips.clear();
    this.pending.clear();
    this.worker.terminate();
  }
}
