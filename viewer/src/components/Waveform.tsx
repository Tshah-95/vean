// A real audio waveform for a clip, drawn from /api/peaks (ffmpeg-extracted min/max
// buckets). Fills its (positioned) parent as a background layer. Peaks are fetched
// once per clip and cached. When the source has no audio / can't be probed, we draw a
// flat neutral baseline — NEVER a fabricated wave.
import { useEffect, useState } from "react";
import { fetchPeaks } from "../api";
import type { PeaksResponse } from "../types";

const cache = new Map<string, PeaksResponse | null>();

export function Waveform({
  clipId,
  route,
  color = "var(--vean-track-audio)",
}: {
  clipId: string;
  route?: string;
  color?: string;
}) {
  const key = `${clipId}|${route ?? ""}`;
  const [peaks, setPeaks] = useState<PeaksResponse | null | undefined>(cache.get(key));

  useEffect(() => {
    if (cache.has(key)) {
      setPeaks(cache.get(key));
      return;
    }
    let cancelled = false;
    fetchPeaks({ clipId }, route)
      .then((r) => {
        if (cancelled) return;
        cache.set(key, r);
        setPeaks(r);
      })
      .catch(() => {
        if (cancelled) return;
        cache.set(key, null); // remember the miss so we don't refetch
        setPeaks(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key, clipId, route]);

  // Not loaded yet, or the source has no peaks → a flat neutral baseline (honest absence).
  if (!peaks || peaks.bins === 0 || peaks.peaks.length < 2) {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: "center",
          pointerEvents: "none",
        }}
      >
        <div style={{ width: "100%", height: 1, background: "color-mix(in srgb, var(--vean-fg-1) 12%, transparent)" }} />
      </div>
    );
  }

  const n = peaks.bins;
  const H = 100;
  const mid = H / 2;
  // A filled envelope: forward along the max edge, back along the min edge.
  let d = "";
  for (let i = 0; i < n; i++) {
    const max = peaks.peaks[i * 2 + 1] ?? 0;
    d += `${i === 0 ? "M" : "L"}${i},${(mid - max * mid).toFixed(2)} `;
  }
  for (let i = n - 1; i >= 0; i--) {
    const min = peaks.peaks[i * 2] ?? 0;
    d += `L${i},${(mid - min * mid).toFixed(2)} `;
  }
  d += "Z";

  return (
    <svg
      viewBox={`0 0 ${Math.max(1, n - 1)} ${H}`}
      preserveAspectRatio="none"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none", opacity: 0.55 }}
      aria-hidden
    >
      <path d={d} fill={color} />
    </svg>
  );
}
