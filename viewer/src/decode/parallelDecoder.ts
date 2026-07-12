import type { MediaResourceLedger } from "../test-bridge/resourceLedger";
// The PARALLEL DECODE POOL (DESIGN-LIVE-PREVIEW §5 "worker pool", §6 Tier 2a,
// §8.3, §8.5, §9 step 5). Ported from OpenReel's `parallel-frame-decoder.ts`
// (worker pool, least-busy scheduling, in-flight cap, zero-copy transfer) FUSED
// with OpenCut's per-media GENERATION COUNTER (`video-cache/service.ts:40-46`) —
// the stale-seek cancel that makes scrubbing not lag.
//
// This supersedes the single-worker `decoder.ts` for the live decode path. It
// owns N copies of the SAME Vite-bundled `decode-worker.ts` (one mediabunny
// demux+CanvasSink per clip per worker), so decode parallelizes across cores while
// the main thread keeps the 16ms paint budget for compositing.
//
// ── THE DISCIPLINES (each load-bearing) ──────────────────────────────────────
//  • POOL SIZE = `min(hardwareConcurrency, 4)` module workers (§5). Each runs the
//    byte-identical decode worker; Vite bundles mediabunny INTO each worker chunk
//    (no CDN — Hard boundary #3).
//  • PER-CLIP RESOURCE AFFINITY: a clip is opened on ONE worker and all its decodes
//    route there, so the demuxer/CanvasSink (created once per clip, §5) is reused
//    instead of re-created per worker. Spreading clips across workers parallelizes
//    DIFFERENT clips; same-clip seeks stay on that clip's worker.
//  • IN-FLIGHT CAP BY COUNT (§8.5): the WebCodecs decoder has a hard in-flight
//    limit and HANGS SILENTLY past it. Each worker caps concurrent decodes
//    (`MAX_INFLIGHT_PER_WORKER`); overflow queues. The cap is by COUNT, not bytes —
//    this is the decoder pipeline, distinct from the FrameCache's byte bound.
//  • GENERATION-COUNTER STALE-SEEK CANCEL (the scrub-lag killer): every `decodeAt`
//    stamps the clip's current generation; a `bumpGeneration(uuid)` on a fresh seek
//    makes all older in-flight/queued decodes for that clip resolve to `null`
//    immediately (their bitmaps, when they arrive, are `close()`d, never cached) so
//    the pool isn't clogged decoding frames the playhead already left.
//  • ZERO-COPY: the worker transfers the `ImageBitmap` (§5); the resolver owns it.
import type { DecodeResponse, OpenResponse, WorkerResponse } from "./protocol";

/** A decoded frame + its actual presentation timestamp (seconds). */
export interface DecodedFrame {
  bitmap: ImageBitmap;
  timestamp: number;
}

/** Per-worker bookkeeping. */
interface PoolWorker {
  worker: Worker;
  index: number;
  /** requestId → its pending resolver (open or decode). */
  pending: Map<string, (resp: DecodeResponse | OpenResponse) => void>;
  /** Clips opened on THIS worker (resource affinity), uuid → open promise. */
  clips: Map<string, ClipState>;
  ready: Promise<void>;
}

/** A clip's per-worker open state (one fetch+open shared by concurrent decodes). */
interface ClipState {
  opened: Promise<boolean>;
  width: number;
  height: number;
}

export interface ParallelDecoderStats {
  workerCount: number;
  /** Decodes that returned a real frame. */
  decodes: number;
  /** Decodes discarded because a fresher seek bumped the generation (§ cancel). */
  staleDropped: number;
  /** Sum of decode wall-times (ms) over `decodes`, for an average. */
  totalDecodeMs: number;
  averageDecodeMs: number;
  /** Currently in-flight decode messages across all workers. */
  inFlight: number;
  /** Decode requests waiting for an in-flight slot. */
  queued: number;
}

let nextRequestId = 0;

/** Max concurrent decode messages per worker (§8.5 hard decoder in-flight limit). */
const MAX_INFLIGHT_PER_WORKER = 2;

export class ParallelDecoder {
  private workers: PoolWorker[] = [];
  /** uuid → the worker that owns that clip's resources (affinity). */
  private clipWorker = new Map<string, PoolWorker>();
  /** uuid → monotonic generation; a seek bumps it to cancel older decodes. */
  private generations = new Map<string, number>();
  /** Round-robin cursor for assigning a NEW clip to the least-loaded worker. */
  private decodes = 0;
  private staleDropped = 0;
  private totalDecodeMs = 0;
  private readonly ledger?: MediaResourceLedger;

  // Per-worker in-flight + overflow queue (the §8.5 cap). Keyed by worker index.
  private inFlight: number[] = [];
  private queues: Array<Array<() => void>> = [];

  constructor(
    poolSize = Math.min(4, navigator.hardwareConcurrency || 4),
    ledger?: MediaResourceLedger,
  ) {
    this.ledger = ledger;
    const n = Math.max(1, poolSize);
    for (let i = 0; i < n; i++) {
      this.workers.push(this.createWorker(i));
      this.inFlight.push(0);
      this.queues.push([]);
    }
  }

  private createWorker(index: number): PoolWorker {
    // Vite bundles this worker + its mediabunny import into a same-origin module
    // chunk. No CDN, no network (§5, Hard boundary #3). Each pool member is an
    // independent instance of the SAME worker module.
    const worker = new Worker(new URL("./decode-worker.ts", import.meta.url), {
      type: "module",
    });
    this.ledger?.open("decoder-worker", String(index));
    const w: PoolWorker = {
      worker,
      index,
      pending: new Map(),
      clips: new Map(),
      ready: Promise.resolve(),
    };
    w.ready = new Promise<void>((resolveReady) => {
      const onMessage = (event: MessageEvent<WorkerResponse>) => {
        const msg = event.data;
        if (msg.type === "ready") {
          resolveReady();
          return;
        }
        const resolve = w.pending.get(msg.requestId);
        if (resolve) {
          w.pending.delete(msg.requestId);
          resolve(msg);
        }
      };
      worker.addEventListener("message", onMessage);
      worker.postMessage({ type: "init" });
    });
    return w;
  }

  /** Send a request that expects one matching response (open/decode). */
  private request<T extends DecodeResponse | OpenResponse>(
    w: PoolWorker,
    req: { requestId: string } & Record<string, unknown>,
    transfer?: Transferable[],
  ): Promise<T> {
    return new Promise<T>((resolve) => {
      w.pending.set(req.requestId, resolve as (r: DecodeResponse | OpenResponse) => void);
      w.worker.postMessage(req, transfer ?? []);
    });
  }

  /** Pick the worker owning `uuid`, or assign the least-loaded one for a new clip
   *  (resource affinity — same-clip seeks reuse one demuxer/sink, §5). */
  private workerForClip(uuid: string): PoolWorker {
    const existing = this.clipWorker.get(uuid);
    if (existing) return existing;
    // Least pending-requests worker (least-busy assignment, OpenReel
    // `getLeastBusyWorker`). Ties broken by lowest index for determinism.
    let best = this.workers[0];
    for (const w of this.workers) {
      if (w.pending.size < best.pending.size) best = w;
    }
    this.clipWorker.set(uuid, best);
    return best;
  }

  /** Ensure the clip's proxy is fetched + opened on its worker exactly once. A box
   *  change (compositor target size) re-opens at the new size. */
  private ensureOpen(
    w: PoolWorker,
    uuid: string,
    proxyUrl: string,
    width: number,
    height: number,
  ): Promise<boolean> {
    const existing = w.clips.get(uuid);
    if (existing && existing.width === width && existing.height === height) {
      return existing.opened;
    }
    if (existing) w.worker.postMessage({ type: "close", clipId: uuid });
    const opened = (async () => {
      await w.ready;
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error(`source-proxy ${res.status}`);
      const blob = await res.blob();
      const requestId = `open-${nextRequestId++}`;
      const resp = await this.request<OpenResponse>(w, {
        type: "open",
        requestId,
        clipId: uuid,
        blob,
        width,
        height,
      });
      if (!resp.ok) throw new Error(resp.error ?? "open failed");
      return true;
    })();
    w.clips.set(uuid, { opened, width, height });
    opened.catch(() => {
      // A failed open must not poison the cache — drop it so a retry can re-open
      // (e.g. the proxy was still encoding on the first touch).
      if (w.clips.get(uuid)?.opened === opened) w.clips.delete(uuid);
    });
    return opened;
  }

  /** Acquire an in-flight slot on worker `w` (§8.5 cap), running `fn` when free. */
  private withSlot<T>(w: PoolWorker, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = () => {
        this.inFlight[w.index]++;
        fn()
          .then(resolve, reject)
          .finally(() => {
            this.inFlight[w.index]--;
            const next = this.queues[w.index].shift();
            if (next) next();
          });
      };
      if (this.inFlight[w.index] < MAX_INFLIGHT_PER_WORKER) run();
      else this.queues[w.index].push(run);
    });
  }

  /** The current generation for a clip (0 if never seeked). */
  private generationOf(uuid: string): number {
    return this.generations.get(uuid) ?? 0;
  }

  /**
   * Bump a clip's generation to CANCEL all older in-flight/queued decodes for it
   * (OpenCut's stale-seek cancel). Call this on a fresh seek/scrub so the pool
   * stops decoding frames the playhead already left. Older decodes still RUN to
   * completion in the worker (mediabunny can't be interrupted mid-frame), but their
   * results are dropped + `close()`d here instead of clogging the cache.
   *
   * Bumping ALL clips (no uuid) is the playhead-moved signal.
   */
  bumpGeneration(uuid?: string): void {
    if (uuid) {
      this.generations.set(uuid, this.generationOf(uuid) + 1);
    } else {
      for (const id of this.clipWorker.keys()) {
        this.generations.set(id, this.generationOf(id) + 1);
      }
    }
  }

  /**
   * Decode clip `uuid`'s footage at `sourceSeconds`, into a `width`×`height` box.
   * Returns the decoded `ImageBitmap` + presentation timestamp, or `null` if no
   * frame exists / decode failed / the request was canceled by a newer generation.
   *
   * The CALLER owns the returned bitmap and MUST `close()` it on evict/replace
   * (§8.3) — typically by handing it to {@link FrameCache.set}. A canceled-stale
   * decode `close()`s its own bitmap here (the caller gets `null`).
   */
  async decodeAt(
    uuid: string,
    proxyUrl: string,
    sourceSeconds: number,
    width: number,
    height: number,
  ): Promise<DecodedFrame | null> {
    const myGeneration = this.generationOf(uuid);
    const w = this.workerForClip(uuid);
    const opened = await this.ensureOpen(w, uuid, proxyUrl, width, height);
    if (!opened) return null;
    // Cancel if a newer seek bumped the generation while we awaited open/queue.
    if (this.generationOf(uuid) !== myGeneration) {
      this.staleDropped++;
      return null;
    }
    return this.withSlot(w, async () => {
      // Re-check at dispatch time: the wait for an in-flight slot may have spanned a
      // seek. Skip the decode entirely if so (don't even ask the worker).
      if (this.generationOf(uuid) !== myGeneration) {
        this.staleDropped++;
        return null;
      }
      const t0 = performance.now();
      const requestId = `decode-${nextRequestId++}`;
      const resp = await this.request<DecodeResponse>(w, {
        type: "decode",
        requestId,
        clipId: uuid,
        time: sourceSeconds,
      });
      if (!resp.bitmap) return null;
      // The decode finished AFTER a fresher seek — discard it (close the bitmap, do
      // not return it). This is the cancel that keeps the cache from filling with
      // frames the playhead already left.
      if (this.generationOf(uuid) !== myGeneration) {
        resp.bitmap.close();
        this.staleDropped++;
        return null;
      }
      this.decodes++;
      this.totalDecodeMs += performance.now() - t0;
      return { bitmap: resp.bitmap, timestamp: resp.timestamp ?? sourceSeconds };
    });
  }

  /** Release one clip's worker resources (on FrameCache eviction of the clip). */
  close(uuid: string): void {
    const w = this.clipWorker.get(uuid);
    if (w) {
      w.clips.delete(uuid);
      w.worker.postMessage({ type: "close", clipId: uuid });
    }
    this.clipWorker.delete(uuid);
    this.generations.delete(uuid);
  }

  getStats(): ParallelDecoderStats {
    let inFlight = 0;
    let queued = 0;
    for (let i = 0; i < this.workers.length; i++) {
      inFlight += this.inFlight[i];
      queued += this.queues[i].length;
    }
    return {
      workerCount: this.workers.length,
      decodes: this.decodes,
      staleDropped: this.staleDropped,
      totalDecodeMs: this.totalDecodeMs,
      averageDecodeMs: this.decodes > 0 ? this.totalDecodeMs / this.decodes : 0,
      inFlight,
      queued,
    };
  }

  /** Tear down the whole pool (on unmount). */
  dispose(): void {
    for (const w of this.workers) {
      for (const uuid of w.clips.keys()) {
        w.worker.postMessage({ type: "close", clipId: uuid });
      }
      w.clips.clear();
      w.pending.clear();
      w.worker.terminate();
      this.ledger?.close("decoder-worker", String(w.index));
    }
    this.workers = [];
    this.clipWorker.clear();
    this.generations.clear();
    this.inFlight = [];
    this.queues = [];
  }
}
