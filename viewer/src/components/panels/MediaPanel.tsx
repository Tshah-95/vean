// Media panel — PROJECT-FIRST. The resting view is the media actually IN this
// project (the unique sources placed on the timeline), as rich tiles: video/graphic
// tiles show their first frame and PLAY on hover (streamed over the same /api/media
// transport the monitor uses); audio shows as dense rows. The full disk catalog is
// reachable on demand — type a query and Find (media.find) — never dumped wholesale.
// Scan / add-root (catalog setup) stay tucked at the bottom.
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchTimeline, mediaUrl, runAction } from "../../api";
import { type Fps, isGraphicClip, type Timeline } from "../../types";
import { Btn, C, Note, fieldStyle, mono, rowStyle } from "./ui";

interface MediaAsset {
  id: string;
  path: string;
  relativePath: string;
  kind: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
}

/** One unique source used by the timeline: its path + kind + total placed time. */
interface ProjectSource {
  path: string;
  name: string;
  kind: "video" | "audio" | "graphic";
  /** Total frames of this source placed across the timeline. */
  frames: number;
}

function fmtBytes(n: number | null): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`;
}

function fmtSeconds(frames: number, fps: Fps): string {
  const s = frames / (fps[0] / fps[1]);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}` : `${s.toFixed(1)}s`;
}

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

const kindColor: Record<string, string> = {
  video: "#6f86a8",
  audio: "#57b98a",
  graphic: "#a98fd6",
  image: "#e0b15e",
  unknown: "#6b7280",
};

/** Collect the unique real sources placed on the timeline (color generators are
 *  synthesized, not media — skipped). */
function projectSources(timeline: Timeline): { sources: ProjectSource[]; fps: Fps } {
  const byPath = new Map<string, ProjectSource>();
  for (const [kind, tracks] of [
    ["video", timeline.tracks.video],
    ["audio", timeline.tracks.audio],
  ] as const) {
    for (const tr of tracks) {
      for (const it of tr.items) {
        if (it.kind !== "clip" || it.service === "color") continue;
        const frames = it.out - it.in + 1;
        const prev = byPath.get(it.resource);
        if (prev) {
          prev.frames += frames;
        } else {
          byPath.set(it.resource, {
            path: it.resource,
            name: it.label ? it.label.split(":")[0] : basename(it.resource),
            kind: isGraphicClip(it) ? "graphic" : kind,
            frames,
          });
        }
      }
    }
  }
  // Visual sources first (tiles), then audio (rows); stable by name within each.
  const sources = [...byPath.values()].sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "audio" ? 1 : -1,
  );
  return { sources, fps: timeline.profile.fps };
}

/** A hover-to-play tile for a visual source (streams the real file). */
function SourceTile({ src, route, fps }: { src: ProjectSource; route?: string; fps: Fps }) {
  return (
    <div title={src.path} style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
      <div
        style={{
          position: "relative",
          aspectRatio: "16/9",
          borderRadius: 5,
          overflow: "hidden",
          background: "#0a0c0e",
          border: `1px solid ${C.border}`,
        }}
      >
        {/* biome-ignore lint/a11y/useMediaCaption: a silent hover preview, not playback */}
        <video
          src={mediaUrl(src.path, route)}
          muted
          playsInline
          preload="metadata"
          onMouseEnter={(e) => {
            void e.currentTarget.play().catch(() => {});
          }}
          onMouseLeave={(e) => {
            e.currentTarget.pause();
            e.currentTarget.currentTime = 0;
          }}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
        <span
          style={{
            position: "absolute",
            left: 4,
            bottom: 4,
            width: 7,
            height: 7,
            borderRadius: 2,
            background: kindColor[src.kind],
          }}
        />
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
        <span
          style={{
            flex: 1,
            fontSize: 11,
            color: C.text,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {src.name}
        </span>
        <span style={{ fontSize: 10, color: C.dim, fontFamily: mono, flexShrink: 0 }}>
          {fmtSeconds(src.frames, fps)}
        </span>
      </div>
    </div>
  );
}

export function MediaPanel({ project, route }: { project?: string; route?: string }) {
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [results, setResults] = useState<MediaAsset[] | null>(null); // null = no search yet
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newRoot, setNewRoot] = useState("");

  // The project's own media — derived from the timeline document itself.
  useEffect(() => {
    let cancelled = false;
    fetchTimeline(route)
      .then((res) => !cancelled && setTimeline(res.timeline))
      .catch(() => !cancelled && setTimeline(null));
    return () => {
      cancelled = true;
    };
  }, [route]);

  const inProject = useMemo(() => (timeline ? projectSources(timeline) : null), [timeline]);
  const tiles = inProject?.sources.filter((s) => s.kind !== "audio") ?? [];
  const audio = inProject?.sources.filter((s) => s.kind === "audio") ?? [];

  const find = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setResults(null); // empty query → back to the project view, not a full dump
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const out = await runAction<MediaAsset[]>("media.find", { query: q }, project);
      setResults(Array.isArray(out) ? out : []);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [query, project]);

  const scan = async () => {
    setBusy(true);
    setErr(null);
    try {
      await runAction("media.scan", {}, project);
      if (results) await find();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const addRoot = async () => {
    if (!newRoot.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await runAction("media.root.add", { path: newRoot.trim() }, project);
      setNewRoot("");
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Search the disk catalog — results appear ONLY when you ask. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
        style={{ padding: "8px 10px", display: "flex", gap: 6, borderBottom: `1px solid ${C.border}` }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find media on disk…"
          style={fieldStyle}
        />
        <Btn disabled={busy}>Find</Btn>
      </form>
      {err && <Note kind="error">{err}</Note>}

      <div style={{ flex: 1, overflow: "auto" }}>
        {results ? (
          <>
            <div style={sectionEyebrow}>
              CATALOG · {results.length}
              <button type="button" onClick={() => setResults(null)} style={clearBtn} title="Back to project media">
                ✕
              </button>
            </div>
            {results.length === 0 && !busy ? <Note kind="dim">No matches in the catalog.</Note> : null}
            {results.map((m, i) => (
              <div key={m.id} style={rowStyle(i)} title={m.path}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: kindColor[m.kind] ?? kindColor.unknown,
                    flexShrink: 0,
                  }}
                />
                <span
                  style={{
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontFamily: mono,
                  }}
                >
                  {m.relativePath || m.path}
                </span>
                <span style={{ color: C.dim, flexShrink: 0 }}>{fmtBytes(m.sizeBytes)}</span>
              </div>
            ))}
          </>
        ) : (
          <>
            <div style={sectionEyebrow}>IN PROJECT{inProject ? ` · ${inProject.sources.length}` : ""}</div>
            {inProject && inProject.sources.length === 0 ? (
              <Note kind="dim">No media placed on this timeline yet.</Note>
            ) : null}
            {tiles.length > 0 && inProject ? (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  padding: "8px 10px",
                }}
              >
                {tiles.map((s) => (
                  <SourceTile key={s.path} src={s} route={route} fps={inProject.fps} />
                ))}
              </div>
            ) : null}
            {audio.length > 0 && inProject
              ? audio.map((s, i) => (
                  <div key={s.path} style={rowStyle(i)} title={s.path}>
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: kindColor.audio,
                        flexShrink: 0,
                      }}
                    />
                    <span
                      style={{
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.name}
                    </span>
                    <span style={{ color: C.dim, flexShrink: 0, fontFamily: mono, fontSize: 10 }}>
                      {fmtSeconds(s.frames, inProject.fps)}
                    </span>
                  </div>
                ))
              : null}
          </>
        )}
      </div>

      {/* Catalog setup — tucked away; not part of the everyday flow. */}
      <div style={{ padding: "8px 10px", display: "flex", gap: 6, borderTop: `1px solid ${C.border}` }}>
        <input
          value={newRoot}
          onChange={(e) => setNewRoot(e.target.value)}
          placeholder="/path/to/media"
          style={fieldStyle}
        />
        <Btn onClick={addRoot} disabled={busy || !newRoot.trim()}>
          Add root
        </Btn>
        <Btn onClick={scan} disabled={busy} title="Rescan media roots">
          Scan
        </Btn>
      </div>
    </div>
  );
}

const sectionEyebrow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 10px 2px",
  fontSize: 10,
  letterSpacing: "0.14em",
  color: C.dim,
  fontFamily: mono,
};

const clearBtn: React.CSSProperties = {
  marginLeft: "auto",
  border: "none",
  background: "transparent",
  color: C.dim,
  cursor: "pointer",
  fontSize: 10,
  padding: 0,
};
