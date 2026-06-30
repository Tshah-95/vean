// A tiny DEBUG BRIDGE that exposes the mediabunny decode layer on `window` so the
// §9-step-3 gate ("a real clip decodes a known frame in-browser headlessly") can be
// driven via `agent-browser ... eval` over the `drive` harness — no React wiring,
// no UI surface. The Tier-1 `renderFrame` compositor (§9 step 4) consumes the same
// `Decoder` from inside the component tree; this bridge is the headless proof that
// the decode primitive works against a REAL clip before the compositor stacks on it.
//
// It is intentionally side-effect-only and guarded so it never ships behavior into
// the normal preview path: it only attaches a `window.__veanDecode(...)` function
// that, given a clip's producer UUID + source resource + a source-time, decodes one
// frame through the worker and returns a small JSON-able pixel sample (so the gate
// can assert the frame is non-empty, not a black/blank decode). The returned bitmap
// is `close()`d immediately after sampling (§8.3 — never leak a decoded frame).
import { Decoder, type DecodedFrame } from "./decoder";

/** The shape `window.__veanDecode` resolves to — JSON-serializable so an
 *  `agent-browser eval` can read it directly. */
export interface DecodeProof {
  ok: boolean;
  clipId: string;
  /** Requested source time in seconds. */
  requestedSeconds: number;
  /** The decoded frame's actual presentation timestamp (seconds). */
  timestamp?: number;
  /** Decoded bitmap dimensions. */
  width?: number;
  height?: number;
  /** A few sampled RGBA pixels (center + quadrants), proving real content decoded
   *  rather than a null/blank frame. Each is `[r,g,b,a]`. */
  samples?: Array<[number, number, number, number]>;
  /** Mean luma across the samples (a single number a gate can threshold). */
  meanLuma?: number;
  /** Whether any sampled pixel is non-black (content present). */
  nonBlack?: boolean;
  error?: string;
}

let singleton: Decoder | null = null;
function decoder(): Decoder {
  if (!singleton) singleton = new Decoder();
  return singleton;
}

/** Sample a decoded frame into a JSON-able proof. Draws the bitmap to an
 *  OffscreenCanvas, reads center + 4 quadrant pixels, computes mean luma. */
function sampleFrame(clipId: string, requestedSeconds: number, frame: DecodedFrame): DecodeProof {
  const { bitmap, timestamp } = frame;
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    bitmap.close();
    return { ok: false, clipId, requestedSeconds, error: "no 2d context" };
  }
  ctx.drawImage(bitmap, 0, 0);
  const points: Array<[number, number]> = [
    [Math.floor(w / 2), Math.floor(h / 2)],
    [Math.floor(w / 4), Math.floor(h / 4)],
    [Math.floor((3 * w) / 4), Math.floor(h / 4)],
    [Math.floor(w / 4), Math.floor((3 * h) / 4)],
    [Math.floor((3 * w) / 4), Math.floor((3 * h) / 4)],
  ];
  const samples: Array<[number, number, number, number]> = [];
  let lumaSum = 0;
  for (const [x, y] of points) {
    const d = ctx.getImageData(x, y, 1, 1).data;
    const px: [number, number, number, number] = [d[0], d[1], d[2], d[3]];
    samples.push(px);
    lumaSum += 0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2];
  }
  const meanLuma = lumaSum / points.length;
  const nonBlack = samples.some(([r, g, b]) => r > 4 || g > 4 || b > 4);
  bitmap.close(); // §8.3: sample then immediately release.
  return {
    ok: true,
    clipId,
    requestedSeconds,
    timestamp,
    width: w,
    height: h,
    samples,
    meanLuma,
    nonBlack,
  };
}

/** Install `window.__veanDecode`. Idempotent. */
export function installDecodeBridge(): void {
  const w = window as unknown as {
    __veanDecode?: (
      clipId: string,
      resource: string,
      sourceSeconds: number,
      width: number,
      height: number,
      route?: string,
    ) => Promise<DecodeProof>;
  };
  if (w.__veanDecode) return;
  w.__veanDecode = async (clipId, resource, sourceSeconds, width, height, route) => {
    try {
      const frame = await decoder().decodeAt(clipId, resource, sourceSeconds, width, height, route);
      if (!frame) {
        return { ok: false, clipId, requestedSeconds: sourceSeconds, error: "no frame decoded" };
      }
      return sampleFrame(clipId, sourceSeconds, frame);
    } catch (error) {
      return {
        ok: false,
        clipId,
        requestedSeconds: sourceSeconds,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
