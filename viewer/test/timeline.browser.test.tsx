import axe from "axe-core";
import { useEffect, useMemo, useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { cleanup } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { ClockProvider, useClockInstance } from "../src/ClockProvider";
import { PreviewProvider } from "../src/PreviewProvider";
import type { EditAuthorOpts } from "../src/api";
import { TimelineStrip } from "../src/components/TimelineStrip";
import { type Gesture, buildInvocation } from "../src/timelineGestures";
import type { OpInvocation, SessionEditResult, Timeline } from "../src/types";
import type { TimelineEditor } from "../src/useTimelineEditor";

const ALPHA_ID = "{7c1a0e2a-0001-4abc-9d00-000000000001}";

const timeline: Timeline = {
  title: "Keyboard fixture",
  profile: {
    description: "HD 30 fps",
    width: 1280,
    height: 720,
    fps: [30, 1],
    displayAspectNum: 16,
    displayAspectDen: 9,
  },
  tracks: {
    video: [
      {
        kind: "video",
        id: "playlist0",
        name: "V1",
        items: [
          {
            kind: "clip",
            id: ALPHA_ID,
            resource: "/fixture/alpha.mov",
            label: "Alpha",
            in: 10,
            out: 39,
            length: 100,
          },
          {
            kind: "clip",
            id: "clip-b",
            resource: "/fixture/beta.mov",
            label: "Beta",
            in: 20,
            out: 49,
            length: 100,
          },
        ],
      },
      {
        kind: "video",
        id: "v2",
        name: "V2",
        items: [
          { kind: "blank", length: 8 },
          {
            kind: "clip",
            id: "clip-c",
            resource: "/fixture/gamma.mov",
            label: "Gamma",
            in: 5,
            out: 24,
            length: 100,
          },
          { kind: "blank", length: 22 },
          {
            kind: "clip",
            id: "clip-d",
            resource: "/fixture/delta.mov",
            label: "Delta",
            in: 0,
            out: 9,
            length: 100,
          },
        ],
      },
    ],
    audio: [
      {
        kind: "audio",
        id: "a1",
        name: "A1",
        items: [
          {
            kind: "clip",
            id: "clip-audio",
            resource: "/fixture/dialogue.wav",
            label: "Dialogue",
            in: 0,
            out: 59,
            length: 100,
          },
        ],
      },
    ],
  },
  transitions: [],
};

type Call = {
  kind: "commit" | "undo" | "redo" | "save";
  invocation?: OpInvocation;
  opts?: EditAuthorOpts;
};

function result(ir: Timeline, revision: number, author: string | null): SessionEditResult {
  return {
    ok: true,
    ir,
    consequences: { durationDelta: 0, ripple: [], warnings: [] },
    diagnostics: [],
    health: { errors: 0, warnings: 0, clean: true },
    canUndo: revision > 0,
    canRedo: false,
    dirty: revision > 0,
    nextUndoAuthor: author,
    nextRedoAuthor: null,
    revision,
  };
}

function Harness({
  calls,
  forceConflict = false,
  allowRemoval = false,
  failCommits = false,
  commitDelayMs = 0,
}: {
  calls: Call[];
  forceConflict?: boolean;
  allowRemoval?: boolean;
  failCommits?: boolean;
  commitDelayMs?: number;
}) {
  const [workingTimeline, setWorkingTimeline] = useState(timeline);
  const [selectedId, select] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [author, setAuthor] = useState<string | null>(null);
  const [redoAuthor, setRedoAuthor] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<TimelineEditor["lastEvent"]>(null);
  const [lastError, setLastError] = useState<TimelineEditor["lastError"]>(null);
  const editor = useMemo<TimelineEditor>(() => {
    const commit: TimelineEditor["commit"] = async (invocation, opts) => {
      if (
        !new Set(["move", "trimIn", "trimOut", "roll", "slip", "slide", "split"]).has(invocation.op)
      ) {
        throw new Error(`unregistered fixture action: ${invocation.op}`);
      }
      calls.push({ kind: "commit", invocation, opts });
      if (commitDelayMs > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, commitDelayMs));
      }
      if (failCommits) {
        setLastError({ kind: "fixture-edit-rejected", detail: "canonical edit refused" });
        return null;
      }
      const next = revision + 1;
      setRevision(forceConflict ? next + 1 : next);
      setAuthor(forceConflict ? "agent:concurrent" : (opts?.author ?? "human"));
      setRedoAuthor(null);
      setLastEvent({ kind: "commit", revision: next, dirty: true });
      return result(timeline, next, opts?.author ?? "human");
    };
    const undo: TimelineEditor["undo"] = async (opts) => {
      calls.push({ kind: "undo", opts });
      if (author && (opts?.author ?? "human") !== author) return null;
      const owner = author;
      const next = revision + 1;
      setRevision(next);
      setAuthor(null);
      setRedoAuthor(owner);
      setLastEvent({ kind: "undo", revision: next, dirty: true });
      return { ...result(timeline, next, null), nextRedoAuthor: owner };
    };
    const redo: TimelineEditor["redo"] = async (opts) => {
      calls.push({ kind: "redo", opts });
      if (redoAuthor && (opts?.author ?? "human") !== redoAuthor) return null;
      const next = revision + 1;
      setRevision(next);
      setAuthor(redoAuthor);
      setRedoAuthor(null);
      setLastEvent({ kind: "redo", revision: next, dirty: true });
      return result(timeline, next, redoAuthor);
    };
    return {
      timeline: workingTimeline,
      revision,
      totalFrames: 60,
      route: "timeline:fixture",
      selectedId,
      select,
      diagnosticsByClip: new Map(),
      commit,
      undo,
      redo,
      save: async () => {
        calls.push({ kind: "save" });
        setLastEvent({ kind: "save", revision, dirty: false });
        return true;
      },
      canUndo: revision > 0,
      canRedo: lastEvent?.kind === "undo",
      dirty: revision > 0,
      justSaved: false,
      lastError,
      busy: false,
      nextUndoAuthor: author,
      nextRedoAuthor: redoAuthor,
      lastEvent,
    };
  }, [
    author,
    calls,
    commitDelayMs,
    failCommits,
    forceConflict,
    lastError,
    lastEvent,
    redoAuthor,
    revision,
    selectedId,
    workingTimeline,
  ]);

  return (
    <>
      <ClockProvider>
        <TimelineClockConfiguration />
        <PreviewProvider>
          <TimelineStrip editor={editor} />
        </PreviewProvider>
      </ClockProvider>
      {allowRemoval ? (
        <button
          type="button"
          onClick={() =>
            setWorkingTimeline({
              ...workingTimeline,
              tracks: { video: [], audio: [] },
            })
          }
        >
          Remove all fixture clips
        </button>
      ) : null}
    </>
  );
}

function TimelineClockConfiguration() {
  const clock = useClockInstance();
  useEffect(() => clock.configure([30, 1], 60), [clock]);
  return null;
}

async function renderHarness(
  calls: Call[],
  options: {
    forceConflict?: boolean;
    allowRemoval?: boolean;
    failCommits?: boolean;
    commitDelayMs?: number;
  } = {},
) {
  return page.render(<Harness calls={calls} {...options} />);
}

describe("approved timeline-a11y-v1 contract", () => {
  test("a11y.timeline.structure", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    await expect.element(page.getByRole("region", { name: "Timeline editor" })).toBeVisible();
    await expect
      .element(page.getByRole("toolbar", { name: "Timeline edit controls" }))
      .toBeVisible();
    await expect.element(page.getByRole("listbox", { name: "Timeline clips" })).toBeVisible();
    await expect.element(page.getByRole("group", { name: "Video track V1" })).toBeVisible();
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await expect.element(alpha).toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByRole("option", { name: /Beta, Video track V1/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    await expect.element(page.getByRole("option", { name: /Delta, Video track V2/ })).toHaveFocus();
    expect(calls).toEqual([]);
  });

  test("a11y.timeline.roving-selection", async () => {
    await renderHarness([]);
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')].filter(
      (option) => option.getAttribute("aria-disabled") !== "true",
    );
    expect(options.filter((option) => option.tabIndex === 0)).toHaveLength(1);
    const beta = page.getByRole("option", { name: /Beta, Video track V1/ });
    beta.element().focus();
    await expect.element(beta).toHaveAttribute("aria-selected", "true");
    expect(
      options.filter((option) => option.tabIndex === 0).map((option) => option.dataset.clipId),
    ).toEqual(["clip-b"]);
  });

  test("a11y.timeline.browse-horizontal", async () => {
    await renderHarness([]);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByRole("option", { name: /Beta, Video track V1/ })).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    await expect.element(alpha).toHaveFocus();
  });

  test("a11y.timeline.browse-home-end", async () => {
    await renderHarness([]);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{End}");
    await expect.element(page.getByRole("option", { name: /Beta, Video track V1/ })).toHaveFocus();
    await userEvent.keyboard("{Control>}{End}{/Control}");
    await expect
      .element(page.getByRole("option", { name: /Dialogue, Audio track A1/ }))
      .toHaveFocus();
    await userEvent.keyboard("{Control>}{Home}{/Control}");
    await expect.element(alpha).toHaveFocus();
  });

  test("a11y.timeline.global-shortcuts", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("n");
    await expect
      .element(page.getByRole("button", { name: "Toggle snapping" }))
      .toHaveAttribute("aria-pressed", "false");
    await userEvent.keyboard(" ");
    await expect.element(page.getByRole("status")).toHaveTextContent("Playing");
    await userEvent.keyboard("b");
    await vi.waitFor(() => expect(calls.at(-1)?.invocation?.op).toBe("split"));
    alpha.element().focus();
    await userEvent.keyboard("{Control>}z{/Control}");
    await vi.waitFor(() => expect(calls.some((call) => call.kind === "undo")).toBe(true));
    await userEvent.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
    await vi.waitFor(() => expect(calls.some((call) => call.kind === "redo")).toBe(true));
    await userEvent.keyboard("{Control>}s{/Control}");
    await vi.waitFor(() => expect(calls.some((call) => call.kind === "save")).toBe(true));
  });

  test("a11y.timeline.edit-target-cycle", async () => {
    await renderHarness([]);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(alpha).toHaveAttribute("data-edit-target", "body");
    await userEvent.keyboard("{Tab}");
    await expect.element(alpha).toHaveAttribute("data-edit-target", "head");
    await userEvent.keyboard("{Tab}");
    await expect.element(alpha).toHaveAttribute("data-edit-target", "tail");
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await expect.element(alpha).toHaveAttribute("data-edit-target", "head");
    await userEvent.keyboard("{Enter}");
    await expect.element(alpha).toHaveAttribute("data-edit-mode", "false");
  });

  test("a11y.timeline.document-truth", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{ArrowRight}");
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.invocation).toEqual({
      op: "move",
      args: {
        uuid: ALPHA_ID,
        toTrack: { trackId: "playlist0" },
        toPosition: 1,
        ripple: false,
        rippleAllTracks: false,
      },
    });
    const recorded = await fetch("/__vean_component_invocation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenarioId: "a11y.timeline.document-truth",
        invocation: calls[0]?.invocation,
        actionId: calls[0]?.invocation?.op,
        route: "timeline:fixture",
      }),
    });
    expect(recorded.status).toBe(204);
    await userEvent.keyboard("{Tab}{Shift>}{ArrowRight}{/Shift}");
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.invocation).toEqual({
      op: "trimIn",
      args: { uuid: ALPHA_ID, delta: 10, rippleAllTracks: false },
    });
    await expect.element(alpha).toHaveAttribute("data-edit-target", "head");
    await userEvent.keyboard("{Enter}");
    await expect.element(alpha).toHaveAttribute("data-edit-mode", "false");
    expect(calls.every((call) => call.opts?.author?.startsWith("human:timeline-keyboard:"))).toBe(
      true,
    );
  });

  test("a11y.timeline.commit-cancel-coalesce", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{ArrowRight>3}{/ArrowRight}");
    await vi.waitFor(() => expect(calls.filter((call) => call.kind === "commit")).toHaveLength(1));
    expect(calls[0]?.invocation?.args.toPosition).toBe(3);
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(calls.filter((call) => call.kind === "undo")).toHaveLength(1));
    expect(calls[1]?.opts?.author).toBe(calls[0]?.opts?.author);
    await expect.element(alpha).toHaveAttribute("data-edit-mode", "false");
    await expect.element(alpha).toHaveFocus();

    await cleanup();
    const serializedCalls: Call[] = [];
    await renderHarness(serializedCalls, { commitDelayMs: 60 });
    const serializedAlpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    serializedAlpha.element().focus();
    await userEvent.keyboard("{Enter}{ArrowRight}");
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}{Enter}");
    await vi.waitFor(() =>
      expect(serializedCalls.filter((call) => call.kind === "commit")).toHaveLength(2),
    );
    expect(serializedCalls.slice(0, 2).map((call) => call.invocation?.op)).toEqual([
      "move",
      "slip",
    ]);
    await expect.element(serializedAlpha).toHaveAttribute("data-edit-mode", "false");

    await cleanup();
    const historyRaceCalls: Call[] = [];
    await renderHarness(historyRaceCalls, { commitDelayMs: 60 });
    const historyAlpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    historyAlpha.element().focus();
    await userEvent.keyboard("b");
    await vi.waitFor(() =>
      expect(historyRaceCalls.filter((call) => call.kind === "commit")).toHaveLength(1),
    );
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    historyAlpha.element().focus();
    await userEvent.keyboard("{Enter}{ArrowRight}");
    await userEvent.keyboard("{Control>}z{/Control}");
    await vi.waitFor(() =>
      expect(historyRaceCalls.map((call) => call.kind)).toEqual(["commit", "commit", "undo"]),
    );
    expect(historyRaceCalls[1]?.invocation?.op).toBe("move");
    expect(historyRaceCalls[2]?.opts?.author).toBe(historyRaceCalls[1]?.opts?.author);
    await expect.element(historyAlpha).toHaveAttribute("data-edit-mode", "false");
    await userEvent.keyboard("{Escape}");
    expect(historyRaceCalls.map((call) => call.kind)).toEqual(["commit", "commit", "undo"]);
  });

  test("a11y.timeline.pointer-keyboard-parity", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    const runEdit = async (keys: string) => {
      const before = calls.filter((call) => call.kind === "commit").length;
      alpha.element().focus();
      await userEvent.keyboard(`{Enter}${keys}{Enter}`);
      await vi.waitFor(() =>
        expect(calls.filter((call) => call.kind === "commit")).toHaveLength(before + 1),
      );
      await expect.element(alpha).toHaveAttribute("data-edit-mode", "false");
    };
    await runEdit("{ArrowRight}");
    await runEdit("{Alt>}{ArrowRight}{/Alt}");
    await runEdit("{Control>}{ArrowRight}{/Control}");
    await runEdit("{Tab}{Alt>}{ArrowRight}{/Alt}");
    await runEdit("{Tab}{Tab}{ArrowLeft}");
    await runEdit("{Tab}{Tab}{Control>}{ArrowRight}{/Control}");
    await runEdit("{ArrowDown}");

    const alphaItem = timeline.tracks.video[0]?.items[0];
    const betaItem = timeline.tracks.video[0]?.items[1];
    if (alphaItem?.kind !== "clip" || betaItem?.kind !== "clip") throw new Error("fixture drift");
    const baseGesture = {
      uuid: ALPHA_ID,
      trackId: "playlist0",
      placed: { item: alphaItem, start: 0, length: 30 },
      neighbours: { left: null, right: null },
      ripple: false,
    } satisfies Omit<Gesture, "tool">;
    const pointerInvocations = [
      buildInvocation({ ...baseGesture, tool: "move" }, 1, false, "playlist0"),
      buildInvocation({ ...baseGesture, tool: "slip" }, 1, false, "playlist0"),
      buildInvocation({ ...baseGesture, tool: "slide" }, 1, false, "playlist0"),
      buildInvocation({ ...baseGesture, tool: "trimIn", ripple: true, extendRoom: 0 }, 1, true),
      buildInvocation({ ...baseGesture, tool: "trimOut", extendRoom: 0 }, -1, false),
      buildInvocation(
        {
          ...baseGesture,
          tool: "roll",
          neighbours: {
            left: { item: alphaItem, start: 0, length: 30 },
            right: { item: betaItem, start: 30, length: 30 },
          },
        },
        1,
        false,
      ),
      buildInvocation({ ...baseGesture, tool: "move" }, 0, false, "v2"),
    ];
    const keyboardInvocations = calls.map((call) => call.invocation);
    expect(keyboardInvocations).toEqual(pointerInvocations);
    const parityRecorded = await fetch("/__vean_component_parity", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenarioId: "a11y.timeline.pointer-keyboard-parity",
        invocations: keyboardInvocations,
      }),
    });
    expect(parityRecorded.status).toBe(204);
  });

  test("a11y.timeline.body-operations", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{Alt>}{ArrowRight}{/Alt}{Enter}");
    await vi.waitFor(() => expect(calls.at(-1)?.invocation?.op).toBe("slip"));
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{Control>}{ArrowRight}{/Control}{Enter}");
    await vi.waitFor(() => expect(calls.at(-1)?.invocation?.op).toBe("slide"));
  });

  test("a11y.timeline.edge-operations", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{Tab}{Alt>}{ArrowRight}{/Alt}{Enter}");
    await vi.waitFor(() => expect(calls.at(-1)?.invocation?.op).toBe("trimIn"));
    expect(calls.at(-1)?.invocation?.args.rippleAllTracks).toBe(true);
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{Tab}{Tab}{Control>}{ArrowRight}{/Control}{Enter}");
    await vi.waitFor(() => expect(calls.at(-1)?.invocation?.op).toBe("roll"));
    const before = calls.length;
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{Tab}{Control>}{ArrowRight}{/Control}");
    await expect.element(page.getByRole("status")).toHaveTextContent(/Roll unavailable/);
    expect(calls).toHaveLength(before);
    await userEvent.keyboard("{Enter}");
  });

  test("a11y.timeline.compatible-track-move", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{ArrowDown}");
    await vi.waitFor(() =>
      expect(calls.at(-1)?.invocation).toMatchObject({
        op: "move",
        args: { uuid: ALPHA_ID, toTrack: { trackId: "v2" }, toPosition: 0 },
      }),
    );
    await userEvent.keyboard("{Enter}");
  });

  test("a11y.timeline.snapping-and-bounds", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{ArrowLeft>3}{/ArrowLeft}");
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent(/media, adjacency, or minimum-length boundary/);
    expect(calls).toEqual([]);
    await userEvent.keyboard("{Enter}");
    await expect
      .element(page.getByRole("button", { name: "Toggle snapping" }))
      .toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
    const gamma = page.getByRole("option", { name: /Gamma, Video track V2/ });
    gamma.element().focus();
    await userEvent.keyboard("{Enter}{ArrowRight}{Enter}");
    await vi.waitFor(() =>
      expect(calls.at(-1)?.invocation).toMatchObject({
        op: "move",
        args: { uuid: "clip-c", toPosition: 10 },
      }),
    );
  });

  test("a11y.timeline.browse-vertical", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{Control>}{End}{/Control}");
    await expect
      .element(page.getByRole("option", { name: /Dialogue, Audio track A1/ }))
      .toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    await expect
      .element(page.getByRole("option", { name: /Dialogue, Audio track A1/ }))
      .toHaveFocus();
    expect(calls).toEqual([]);
  });

  test("a11y.timeline.announcements", async () => {
    const calls: Call[] = [];
    await renderHarness(calls, { forceConflict: true });
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{ArrowRight}");
    await vi.waitFor(() => expect(calls.filter((call) => call.kind === "commit")).toHaveLength(1));
    await userEvent.keyboard("{Escape}");
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent(/Cancel refused: the timeline changed outside/);
    expect(calls.filter((call) => call.kind === "undo")).toEqual([]);
    await expect.element(alpha).toHaveAttribute("data-edit-mode", "true");
    await cleanup();

    const failedCalls: Call[] = [];
    await renderHarness(failedCalls, { failCommits: true });
    const failedAlpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    failedAlpha.element().focus();
    await userEvent.keyboard("{Enter}{ArrowRight}{Enter}");
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("fixture-edit-rejected: canonical edit refused");
    await expect.element(failedAlpha).toHaveAttribute("data-edit-mode", "true");
    await expect.element(failedAlpha).toHaveFocus();
  });

  test("a11y.timeline.focus-restoration", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{ArrowRight}");
    await vi.waitFor(() => expect(calls.filter((call) => call.kind === "commit")).toHaveLength(1));
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(calls.filter((call) => call.kind === "undo")).toHaveLength(1));
    await expect.element(alpha).toHaveFocus();
    await expect.element(alpha).toHaveAttribute("data-edit-mode", "false");
    await cleanup();

    await renderHarness([], { allowRemoval: true });
    const removable = page.getByRole("option", { name: /Alpha, Video track V1/ });
    removable.element().focus();
    await page.getByRole("button", { name: "Remove all fixture clips" }).click();
    await expect.element(page.getByRole("region", { name: "Timeline editor" })).toHaveFocus();
  });

  test("component.strict-mode.cleanup", async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const add = vi
      .spyOn(window, "addEventListener")
      .mockImplementation((type, listener, options) => {
        added.push(type);
        return EventTarget.prototype.addEventListener.call(window, type, listener, options);
      });
    const remove = vi
      .spyOn(window, "removeEventListener")
      .mockImplementation((type, listener, options) => {
        removed.push(type);
        return EventTarget.prototype.removeEventListener.call(window, type, listener, options);
      });
    await renderHarness([]);
    await cleanup();
    add.mockRestore();
    remove.mockRestore();
    expect(added.filter((type) => type === "keydown").length).toBeGreaterThan(0);
    expect(removed.filter((type) => type === "keydown")).toHaveLength(
      added.filter((type) => type === "keydown").length,
    );
  });

  test("component.editor.undo-redo-save", async () => {
    const calls: Call[] = [];
    await renderHarness(calls);
    const alpha = page.getByRole("option", { name: /Alpha, Video track V1/ });
    alpha.element().focus();
    await userEvent.keyboard("{Enter}{ArrowRight}{Enter}");
    await vi.waitFor(() => expect(calls.filter((call) => call.kind === "commit")).toHaveLength(1));
    await page.getByRole("button", { name: "Save" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Save complete; timeline is clean");
    await page.getByRole("button", { name: "Undo" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent(/Undo complete; timeline is dirty/);
    await page.getByRole("button", { name: "Redo" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent(/Redo complete; timeline is dirty/);
  });

  test("a11y.timeline.axe", async () => {
    await renderHarness([]);
    await expect
      .element(page.getByRole("option", { name: /Blank gap, 8 frames/ }))
      .toHaveAttribute("aria-disabled", "true");
    const report = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(report.violations).toEqual([]);
    await page.screenshot({ path: "../test-results/component-browser/accessibility.png" });
  });
});
