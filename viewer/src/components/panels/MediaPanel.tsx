import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
// Media panel — the PROJECT BIN (Premiere's project panel, vean-shaped). The
// resting view is every asset imported into this project's media roots (the
// sequestered per-project folders), grouped by folder, as TILES (hover-to-play,
// streamed over /api/media) or a dense LIST — a persisted toggle. A gold dot marks
// assets already placed on the timeline. Click loads the SOURCE monitor (pick a
// span there); drag places it on a timeline track (or a gutter → new track).
// Search (media.find) queries the catalog on demand; scan/add-root sit at the
// bottom (setup, not the everyday flow).
import { LayoutGrid, List } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  MEDIA_DRAG_MIME,
  type MediaDragPayload,
  type SourceMedia,
  useSource,
} from "../../SourceProvider";
import { fetchTimeline, mediaUrl, runAction } from "../../api";
import type { Fps } from "../../types";
import { Note, SectionEyebrow, rowClass } from "./ui";

interface MediaAsset {
  id: string;
  path: string;
  relativePath: string;
  kind: string;
  sizeBytes: number | null;
  mtimeMs: number | null;
}

type ViewMode = "tiles" | "list";
const VIEW_KEY = "vean.mediaView";

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

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

/** Folder group for an asset: its relativePath's first segment, else by kind. */
function groupOf(a: MediaAsset): string {
  const rel = a.relativePath.replace(/\\/g, "/");
  if (rel.includes("/")) return rel.split("/")[0] ?? "";
  return a.kind === "audio" ? "audio" : "footage";
}

function sourceKind(kind: string): SourceMedia["kind"] {
  return kind === "audio" ? "audio" : "video";
}

/** Kind dot — the track-hue family, from the token layer. */
const kindDotClass: Record<string, string> = {
  video: "bg-track-video",
  audio: "bg-track-audio",
  graphic: "bg-track-graphic",
  image: "bg-amber",
  unknown: "bg-fg-3",
};

/** A hover-to-play bin tile. Click → source monitor; drag → timeline. */
function BinTile({
  asset,
  route,
  fps,
  placed,
  onSelect,
}: {
  asset: MediaAsset;
  route?: string;
  fps: Fps;
  placed: boolean;
  onSelect: () => void;
}) {
  const fpsWhole = Math.max(1, Math.round(fps[0] / fps[1]));
  const name = basename(asset.relativePath || asset.path);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: pointer affordance; the list view is keyboard-reachable
    <div
      title={`${asset.path}\nclick → source monitor · drag → timeline`}
      onClick={onSelect}
      draggable
      onDragStart={(e) => {
        const v = (e.currentTarget as HTMLElement).querySelector("video");
        if (!v || !Number.isFinite(v.duration) || v.duration <= 0) {
          e.preventDefault();
          return;
        }
        const durF = Math.max(1, Math.round(v.duration * fpsWhole));
        const payload: MediaDragPayload = {
          path: asset.path,
          name,
          kind: sourceKind(asset.kind),
          in: 0,
          out: durF - 1,
        };
        e.dataTransfer.setData(MEDIA_DRAG_MIME, JSON.stringify(payload));
        e.dataTransfer.effectAllowed = "copy";
      }}
      className="flex min-w-0 cursor-pointer flex-col gap-1"
    >
      <div className="relative aspect-video overflow-hidden rounded-md border border-border bg-inset">
        <video
          src={mediaUrl(asset.path, route)}
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
          className="block h-full w-full object-cover"
        />
        {placed ? (
          <span
            title="placed on the timeline"
            className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
          />
        ) : null}
      </div>
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="flex-1 truncate text-[11px] text-foreground">{name}</span>
        <span className="shrink-0 font-mono text-[10px] text-fg-3">
          {fmtBytes(asset.sizeBytes)}
        </span>
      </div>
    </div>
  );
}

export function MediaPanel({ project, route }: { project?: string; route?: string }) {
  const { select } = useSource();
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [placedPaths, setPlacedPaths] = useState<Set<string>>(new Set());
  const [fps, setFps] = useState<Fps>([30, 1]);
  const [view, setView] = useState<ViewMode>(
    () => (localStorage.getItem(VIEW_KEY) as ViewMode) || "tiles",
  );
  const [results, setResults] = useState<MediaAsset[] | null>(null); // null = no search
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newRoot, setNewRoot] = useState("");

  const setViewPersist = (v: ViewMode) => {
    setView(v);
    localStorage.setItem(VIEW_KEY, v);
  };

  // The bin: everything in the project's media roots.
  const loadBin = useCallback(async () => {
    try {
      const out = await runAction<MediaAsset[]>("media.list", {}, project);
      setAssets(Array.isArray(out) ? out : []);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  }, [project]);
  useEffect(() => {
    void loadBin();
  }, [loadBin]);

  // Which bin assets are already placed on the timeline (the gold dot).
  useEffect(() => {
    let cancelled = false;
    fetchTimeline(route)
      .then((res) => {
        if (cancelled) return;
        setFps(res.timeline.profile.fps);
        const placed = new Set<string>();
        for (const tr of [...res.timeline.tracks.video, ...res.timeline.tracks.audio]) {
          for (const it of tr.items) {
            if (it.kind === "clip" && it.service !== "color") placed.add(it.resource);
          }
        }
        setPlacedPaths(placed);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [route]);

  const groups = useMemo(() => {
    const byGroup = new Map<string, MediaAsset[]>();
    for (const a of assets) {
      const g = groupOf(a);
      const arr = byGroup.get(g) ?? [];
      arr.push(a);
      byGroup.set(g, arr);
    }
    for (const arr of byGroup.values())
      arr.sort((x, y) => (x.relativePath || x.path).localeCompare(y.relativePath || y.path));
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [assets]);

  const find = useCallback(async () => {
    const q = query.trim();
    if (!q) {
      setResults(null);
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
      // Scan EVERY root (the action scans one per call).
      const roots = await runAction<Array<{ id: string }>>("media.root.list", {}, project);
      for (const r of roots ?? []) await runAction("media.scan", { rootId: r.id }, project);
      await loadBin();
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
      await scan();
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
      setBusy(false);
    }
  };

  const selectAsset = (a: MediaAsset) =>
    select({ path: a.path, name: basename(a.relativePath || a.path), kind: sourceKind(a.kind) });

  const Row = (a: MediaAsset, i: number) => (
    // biome-ignore lint/a11y/useKeyWithClickEvents: pointer affordance
    <div
      key={a.id}
      className={cn(rowClass(i), "cursor-pointer")}
      title={`${a.path}\nclick → source monitor`}
      onClick={() => selectAsset(a)}
    >
      <span
        className={cn("size-2 shrink-0 rounded-sm", kindDotClass[a.kind] ?? kindDotClass.unknown)}
      />
      <span className="flex-1 truncate">{basename(a.relativePath || a.path)}</span>
      {placedPaths.has(a.path) ? (
        <span
          title="placed on the timeline"
          className="size-1.5 shrink-0 rounded-full bg-primary"
        />
      ) : null}
      <span className="shrink-0 font-mono text-[10px] text-fg-3">{fmtBytes(a.sizeBytes)}</span>
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {/* Search + view toggle. */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
        className="flex items-center gap-1.5 border-b border-border px-2.5 py-2"
      >
        <Input
          aria-label="Find media"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find media…"
        />
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(v) => v && setViewPersist(v as ViewMode)}
        >
          <ToggleGroupItem value="tiles" aria-label="Tile view" title="Tile view">
            <LayoutGrid size={13} strokeWidth={1.75} />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label="List view" title="List view">
            <List size={13} strokeWidth={1.75} />
          </ToggleGroupItem>
        </ToggleGroup>
      </form>
      {err && <Note kind="error">{err}</Note>}

      <div className="flex-1 overflow-auto">
        {results ? (
          <>
            <SectionEyebrow>
              RESULTS · {results.length}
              <button
                type="button"
                onClick={() => setResults(null)}
                className="ml-auto cursor-pointer text-[10px] text-fg-3 hover:text-foreground"
                title="Back to the bin"
              >
                ✕
              </button>
            </SectionEyebrow>
            {results.length === 0 && !busy ? <Note kind="dim">No matches.</Note> : null}
            {results.map(Row)}
          </>
        ) : assets.length === 0 ? (
          <Note kind="dim">Bin is empty. Add a media root below, then Scan.</Note>
        ) : (
          groups.map(([group, arr]) => (
            <div key={group}>
              <SectionEyebrow>
                {group.toUpperCase()} · {arr.length}
              </SectionEyebrow>
              {view === "tiles" ? (
                <>
                  <div className="grid grid-cols-2 gap-2 px-2.5 pb-2 pt-1.5">
                    {arr
                      .filter((a) => a.kind !== "audio")
                      .map((a) => (
                        <BinTile
                          key={a.id}
                          asset={a}
                          route={route}
                          fps={fps}
                          placed={placedPaths.has(a.path)}
                          onSelect={() => selectAsset(a)}
                        />
                      ))}
                  </div>
                  {arr.filter((a) => a.kind === "audio").map(Row)}
                </>
              ) : (
                arr.map(Row)
              )}
            </div>
          ))
        )}
      </div>

      {/* Catalog setup — tucked away. */}
      <div className="flex gap-1.5 border-t border-border px-2.5 py-2">
        <Input
          aria-label="Media root path"
          value={newRoot}
          onChange={(e) => setNewRoot(e.target.value)}
          placeholder="/path/to/media"
        />
        <Button size="sm" variant="outline" onClick={addRoot} disabled={busy || !newRoot.trim()}>
          Add root
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={scan}
          disabled={busy}
          title="Rescan all media roots"
        >
          Scan
        </Button>
      </div>
    </div>
  );
}
