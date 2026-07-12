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
import { useClockInstance } from "../../ClockProvider";
import {
  type ProjectEntry,
  type WhereAmI,
  fetchProjects,
  fetchTimeline,
  fetchWhereAmI,
  renderStill,
} from "../../api";
import { type TimelineDiff, diffTimelines } from "../timelineDiff";
import { Btn, C, Note, PanelHead, mono } from "./ui";

/** A row in the "label: value" identity block. */
function Field({ k, v, mono: monoVal }: { k: string; v: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", gap: 8, fontSize: 11, padding: "2px 0" }}>
      <span style={{ color: C.muted, flexShrink: 0, width: 78 }}>{k}</span>
      <span
        style={{
          color: C.text,
          fontFamily: monoVal ? mono : undefined,
          wordBreak: "break-all",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {v}
      </span>
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
      const [a, b] = await Promise.all([
        renderStill(frame, baseRoute),
        renderStill(frame, otherRoute),
      ]);
      const bust = Date.now();
      setStills({ base: `${a.stillUrl}?t=${bust}`, other: `${b.stillUrl}?t=${bust}` });
    } catch (e) {
      setErr(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [baseRoute, otherRoute, getFrame]);

  const art = {
    width: "100%",
    borderRadius: 4,
    border: `1px solid ${C.border}`,
    display: "block",
  } as const;

  return (
    <div style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: 8, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.text, flex: 1, minWidth: 0 }}>
          {other.title}
        </span>
        <Btn
          onClick={() => void doDiff()}
          disabled={busy !== null}
          title="Structural diff vs the loaded session"
        >
          {busy === "diff" ? "Diffing…" : "Diff"}
        </Btn>
        <Btn
          onClick={() => void doStill()}
          disabled={busy !== null}
          title="Render a still at the playhead on both"
        >
          {busy === "still" ? "Rendering…" : "Still"}
        </Btn>
      </div>
      <div
        style={{
          fontSize: 10,
          color: C.dim,
          fontFamily: mono,
          wordBreak: "break-all",
          marginBottom: 6,
        }}
      >
        {other.rootPath}
      </div>
      {err && <Note kind="error">{err}</Note>}

      {diff && (
        <div style={{ marginBottom: stills ? 10 : 0 }}>
          {diff.identical ? (
            <Note kind="dim">No structural difference from {baseTitle}.</Note>
          ) : (
            <>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>
                Δ duration {diff.durationDelta >= 0 ? "+" : ""}
                {diff.durationDelta}f · Δ clips {diff.clipDelta >= 0 ? "+" : ""}
                {diff.clipDelta}
              </div>
              {diff.clips.slice(0, 20).map((c) => (
                <div key={c.id} style={{ display: "flex", gap: 6, fontSize: 10, padding: "1px 0" }}>
                  <span
                    style={{
                      color:
                        c.kind === "added" ? "#7fd18f" : c.kind === "removed" ? C.danger : C.accent,
                      width: 52,
                      flexShrink: 0,
                    }}
                  >
                    {c.kind}
                  </span>
                  <span style={{ color: C.muted, fontFamily: mono, wordBreak: "break-word" }}>
                    {c.detail}
                  </span>
                </div>
              ))}
              {diff.clips.length > 20 && (
                <div style={{ fontSize: 10, color: C.dim, marginTop: 2 }}>
                  +{diff.clips.length - 20} more…
                </div>
              )}
            </>
          )}
        </div>
      )}

      {stills && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
          <div>
            <div style={{ fontSize: 10, color: C.dim, marginBottom: 3 }}>{baseTitle} (this)</div>
            <img src={stills.base} alt={`${baseTitle} still`} style={art} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: C.dim, marginBottom: 3 }}>{other.title}</div>
            <img src={stills.other} alt={`${other.title} still`} style={art} />
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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <PanelHead title="Sessions">
        <Btn onClick={() => void load()}>Refresh</Btn>
      </PanelHead>
      {err && <Note kind="error">{err}</Note>}
      <div style={{ flex: 1, overflow: "auto", padding: 10 }}>
        {/* This worktree's identity — the "which version am I?" block. */}
        {me ? (
          <div
            style={{
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: "8px 10px",
              marginBottom: 12,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 12, fontWeight: 650, color: C.accent, fontFamily: mono }}>
                {me.slug}
              </span>
              <span
                style={{
                  fontSize: 10,
                  color: me.isPrimary ? "#7fd18f" : C.muted,
                  border: `1px solid ${C.border}`,
                  borderRadius: 4,
                  padding: "1px 5px",
                }}
              >
                {me.isPrimary ? "primary" : "worktree"}
              </span>
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
                Note: the on-PATH `vean` resolves to a different checkout (
                {me.veanBinResolvesTo ?? "unknown"}); inside a worktree use `bun run`.
              </Note>
            )}
          </div>
        ) : (
          <Note kind="dim">Worktree identity unavailable.</Note>
        )}

        <div style={{ fontSize: 11, fontWeight: 650, color: C.muted, margin: "4px 0 8px" }}>
          Other sessions · {others.length}
        </div>
        {others.length === 0 && (
          <Note kind="dim">No other project sessions to compare against.</Note>
        )}
        {others.map((s) =>
          openId === s.id ? (
            <div key={s.id}>
              <Btn onClick={() => setOpenId(null)}>‹ Close {s.title}</Btn>
              <div style={{ height: 8 }} />
              <CompareCard
                other={s}
                baseRoute={route}
                baseTitle={baseTitle}
                getFrame={() => clock.getSnapshot().currentFrame}
              />
            </div>
          ) : (
            <div
              key={s.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 8px",
                marginBottom: 6,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 12,
                    color: C.text,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.title}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: C.dim,
                    fontFamily: mono,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {s.rootPath}
                </div>
              </div>
              <Btn
                onClick={() => setOpenId(s.id)}
                disabled={!s.timelinePath}
                title={s.timelinePath ? "Diff + still vs this session" : "no timeline:main"}
              >
                Compare
              </Btn>
            </div>
          ),
        )}
      </div>
    </div>
  );
}
