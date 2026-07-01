// Sessions / worktree panel — the agent-session + git-worktree exploration surface
// (DESIGN-WORKTREE §4.5 / roadmap T10, T9-UI). Because vean's entire edit state is
// text and every worktree is just another checkout of the same project documents,
// the app can show: (1) THIS checkout's identity (slug/branch/primary + its live
// drive session) — the read-only "which version am I looking at?" answer; and
// (2) the known project SESSIONS, each comparable against the one loaded here with a
// structural diff + a side-by-side render-still. Palmier's live-app-+-binary-package
// state has no such story; ours falls out of the file-in/file-out core for free.
//
// Everything here is backed by the existing bridge — `worktree.whereami` and
// `render.still` through POST /api/action, and `/api/projects` + `/api/timeline`
// for the session list and the client-side diff — so no new server endpoint or
// registry action is introduced.
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  fetchProjects,
  fetchTimeline,
  fetchWhereAmI,
  type ProjectEntry,
  renderStill,
  type WhereAmI,
} from "../../api";
import { useClockInstance } from "../../ClockProvider";
import { type TimelineDiff, diffTimelines } from "../timelineDiff";
import { Note, PanelHead } from "./ui";

/** A row in the "label: value" identity block. */
function Field({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2 py-0.5 text-[11px]">
      <span className="w-[78px] shrink-0 text-muted-foreground">{k}</span>
      <span className={cn("truncate break-all text-foreground", mono && "font-mono")}>{v}</span>
    </div>
  );
}

/** The compare workspace for one OTHER session against the one loaded here. Holds
 *  its own diff + still-pair state so opening a second session doesn't clobber it. */
function CompareCard({
  other,
  baseRoute,
  baseTitle,
  getFrame,
}: {
  other: ProjectEntry;
  baseRoute: string | undefined;
  baseTitle: string;
  /** Read the current playhead frame at click time (a still pair is rendered at the
   *  live frame, not a frame captured at mount). */
  getFrame: () => number;
}) {
  const [diff, setDiff] = useState<TimelineDiff | null>(null);
  const [stills, setStills] = useState<{ base: string; other: string } | null>(null);
  const [busy, setBusy] = useState<"diff" | "still" | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const otherRoute = other.timelinePath ?? undefined;

  const doDiff = useCallback(async () => {
    if (!otherRoute) {
      setErr("this session has no resolvable timeline:main");
      return;
    }
    setBusy("diff");
    setErr(null);
    try {
      const [a, b] = await Promise.all([fetchTimeline(baseRoute), fetchTimeline(otherRoute)]);
      setDiff(diffTimelines(a.timeline, b.timeline));
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [baseRoute, otherRoute]);

  const doStill = useCallback(async () => {
    if (!otherRoute) {
      setErr("this session has no resolvable timeline:main");
      return;
    }
    setBusy("still");
    setErr(null);
    try {
      // Render the SAME frame on each side so the compare is apples-to-apples.
      const frame = getFrame();
      const [a, b] = await Promise.all([renderStill(frame, baseRoute), renderStill(frame, otherRoute)]);
      const bust = Date.now();
      setStills({ base: `${a.stillUrl}?t=${bust}`, other: `${b.stillUrl}?t=${bust}` });
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [baseRoute, otherRoute, getFrame]);

  const deltaClass = (kind: string) =>
    kind === "added" ? "text-track-audio" : kind === "removed" ? "text-red" : "text-primary";

  return (
    <div className="mb-2.5 rounded-md border border-border p-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="min-w-0 flex-1 text-xs font-medium text-foreground">{other.title}</span>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void doDiff()}
          disabled={busy !== null}
          title="Structural diff vs the loaded session"
        >
          {busy === "diff" ? "Diffing…" : "Diff"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void doStill()}
          disabled={busy !== null}
          title="Render a still at the playhead on both"
        >
          {busy === "still" ? "Rendering…" : "Still"}
        </Button>
      </div>
      <div className="mb-1.5 break-all font-mono text-[10px] text-fg-3">{other.rootPath}</div>
      {err && <Note kind="error">{err}</Note>}

      {diff && (
        <div className={stills ? "mb-2.5" : undefined}>
          {diff.identical ? (
            <Note kind="dim">No structural difference from {baseTitle}.</Note>
          ) : (
            <>
              <div className="mb-1 text-[11px] text-muted-foreground">
                Δ duration {diff.durationDelta >= 0 ? "+" : ""}
                {diff.durationDelta}f · Δ clips {diff.clipDelta >= 0 ? "+" : ""}
                {diff.clipDelta}
              </div>
              {diff.clips.slice(0, 20).map((c) => (
                <div key={c.id} className="flex gap-1.5 py-px text-[10px]">
                  <span className={cn("w-[52px] shrink-0", deltaClass(c.kind))}>{c.kind}</span>
                  <span className="break-words font-mono text-muted-foreground">{c.detail}</span>
                </div>
              ))}
              {diff.clips.length > 20 && (
                <div className="mt-0.5 text-[10px] text-fg-3">+{diff.clips.length - 20} more…</div>
              )}
            </>
          )}
        </div>
      )}

      {stills && (
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <div className="mb-0.5 text-[10px] text-fg-3">{baseTitle} (this)</div>
            <img src={stills.base} alt={`${baseTitle} still`} className="block w-full rounded border border-border" />
          </div>
          <div>
            <div className="mb-0.5 text-[10px] text-fg-3">{other.title}</div>
            <img src={stills.other} alt={`${other.title} still`} className="block w-full rounded border border-border" />
          </div>
        </div>
      )}
    </div>
  );
}

export function SessionsPanel({
  project,
  route,
  baseTitle,
}: {
  project?: string;
  route?: string;
  /** Display title of the session loaded in this viewer (the diff/still baseline). */
  baseTitle: string;
}) {
  const clock = useClockInstance();
  const [me, setMe] = useState<WhereAmI | null>(null);
  const [sessions, setSessions] = useState<ProjectEntry[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [w, p] = await Promise.all([
        fetchWhereAmI(project).catch(() => null),
        fetchProjects().then((r) => r.projects),
      ]);
      setMe(w);
      setSessions(p);
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load]);

  // The other sessions (everything except the one whose timeline is loaded here).
  const others = sessions.filter((s) => s.rootPath !== me?.worktreePath);

  return (
    <div className="flex h-full flex-col">
      <PanelHead title="Sessions">
        <Button size="sm" variant="outline" onClick={() => void load()}>
          Refresh
        </Button>
      </PanelHead>
      {err && <Note kind="error">{err}</Note>}
      <div className="flex-1 overflow-auto p-2.5">
        {/* This worktree's identity — the "which version am I?" block. */}
        {me ? (
          <div className="mb-3 rounded-md border border-border px-2.5 py-2">
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-xs font-medium text-primary">{me.slug}</span>
              <Badge tone={me.isPrimary ? "ok" : "neutral"}>{me.isPrimary ? "primary" : "worktree"}</Badge>
            </div>
            <Field k="branch" v={me.branch ?? "(detached)"} mono />
            <Field k="path" v={me.worktreePath} mono />
            {me.driveSession ? (
              <Field k="drive" v={`${me.driveSession.status} · ${me.driveSession.url}`} mono />
            ) : (
              <Field k="drive" v="no live session" />
            )}
            {!me.veanBinMatchesCheckout && (
              <Note kind="dim">
                Note: the on-PATH `vean` resolves to a different checkout ({me.veanBinResolvesTo ?? "unknown"});
                inside a worktree use `bun run`.
              </Note>
            )}
          </div>
        ) : (
          <Note kind="dim">Worktree identity unavailable.</Note>
        )}

        <div className="mb-2 mt-1 text-[11px] font-medium text-muted-foreground">
          Other sessions · {others.length}
        </div>
        {others.length === 0 && <Note kind="dim">No other project sessions to compare against.</Note>}
        {others.map((s) =>
          openId === s.id ? (
            <div key={s.id}>
              <Button size="sm" variant="outline" onClick={() => setOpenId(null)}>
                ‹ Close {s.title}
              </Button>
              <div className="h-2" />
              <CompareCard
                other={s}
                baseRoute={route}
                baseTitle={baseTitle}
                getFrame={() => clock.getSnapshot().currentFrame}
              />
            </div>
          ) : (
            <div key={s.id} className="mb-1.5 flex items-center gap-2 rounded-md border border-border px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-foreground">{s.title}</div>
                <div className="truncate font-mono text-[10px] text-fg-3">{s.rootPath}</div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setOpenId(s.id)}
                disabled={!s.timelinePath}
                title={s.timelinePath ? "Diff + still vs this session" : "no timeline:main"}
              >
                Compare
              </Button>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
