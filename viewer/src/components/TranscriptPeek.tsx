// A transcript peek for a clip: the spoken words along it, drawn from /api/transcript.
// Makes voice/audio clips legible at a glance instead of anonymous bars. Fetched once
// per clip and cached. A clip with NO transcript (never transcribed) renders nothing —
// the honest absence, never invented text.
import { useEffect, useState } from "react";
import { fetchTranscript } from "../api";
import type { TranscriptWord } from "../types";

const cache = new Map<string, TranscriptWord[]>();

export function TranscriptPeek({ clipId, route }: { clipId: string; route?: string }) {
  const key = `${clipId}|${route ?? ""}`;
  const [words, setWords] = useState<TranscriptWord[] | undefined>(cache.get(key));

  useEffect(() => {
    if (cache.has(key)) {
      setWords(cache.get(key));
      return;
    }
    let cancelled = false;
    fetchTranscript({ clipId }, route)
      .then((r) => {
        if (cancelled) return;
        cache.set(key, r.words);
        setWords(r.words);
      })
      .catch(() => {
        if (cancelled) return;
        cache.set(key, []);
        setWords([]);
      });
    return () => {
      cancelled = true;
    };
  }, [key, clipId, route]);

  if (!words || words.length === 0) return null;
  const text = words.map((w) => w.text).join(" ");

  return (
    <div
      title={text}
      style={{
        position: "absolute",
        top: 2,
        left: 6,
        right: 6,
        fontSize: 9,
        lineHeight: 1.25,
        color: "color-mix(in srgb, var(--vean-fg-1) 75%, transparent)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        pointerEvents: "none",
        zIndex: 2,
      }}
    >
      {text}
    </div>
  );
}
