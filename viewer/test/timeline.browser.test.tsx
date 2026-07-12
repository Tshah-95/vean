import axe from "axe-core";
import { useMemo, useState } from "react";
import { describe, expect, test, vi } from "vitest";
import { cleanup } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { ClockProvider } from "../src/ClockProvider";
import { PreviewProvider } from "../src/PreviewProvider";
import type { EditAuthorOpts } from "../src/api";
import { TimelineStrip } from "../src/components/TimelineStrip";
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

function Harness({ calls, forceConflict = false }: { calls: Call[]; forceConflict?: boolean }) {
  const [selectedId, select] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [author, setAuthor] = useState<string | null>(null);
  const [lastEvent, setLastEvent] = useState<TimelineEditor["lastEvent"]>(null);
  const editor = useMemo<TimelineEditor>(() => {
    const commit: TimelineEditor["commit"] = async (invocation, opts) => {
      if (
        !new Set(["move", "trimIn", "trimOut", "roll", "slip", "slide", "split"]).has(invocation.op)
      ) {
        throw new Error(`unregistered fixture action: ${invocation.op}`);
      }
      calls.push({ kind: "commit", invocation, opts });
      const next = revision + 1;
      setRevision(forceConflict ? next + 1 : next);
      setAuthor(forceConflict ? "agent:concurrent" : (opts?.author ?? "human"));
      setLastEvent({ kind: "commit", revision: next, dirty: true });
      return result(timeline, next, opts?.author ?? "human");
    };
    const undo: TimelineEditor["undo"] = async (opts) => {
      calls.push({ kind: "undo", opts });
      if (author && (opts?.author ?? "human") !== author) return null;
      const next = revision + 1;
      setRevision(next);
      setAuthor(null);
      setLastEvent({ kind: "undo", revision: next, dirty: true });
      return result(timeline, next, null);
    };
    const redo: TimelineEditor["redo"] = async (opts) => {
      calls.push({ kind: "redo", opts });
      const next = revision + 1;
      setRevision(next);
      setLastEvent({ kind: "redo", revision: next, dirty: true });
      return result(timeline, next, author);
    };
    return {
      timeline,
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
      lastError: null,
      busy: false,
      nextUndoAuthor: author,
      lastEvent,
    };
  }, [author, calls, forceConflict, lastEvent, revision, selectedId]);

  return (
    <ClockProvider>
      <PreviewProvider>
        <TimelineStrip editor={editor} />
      </PreviewProvider>
    </ClockProvider>
  );
}

async function renderHarness(calls: Call[], forceConflict = false) {
  return page.render(<Harness calls={calls} forceConflict={forceConflict} />);
}

describe("approved timeline-a11y-v1 contract", () => {
  test("component-semantic-listbox-roving-selection", async () => {
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

  test("component-keyboard-target-step-action-parity", async () => {
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
        scenarioId: "component-pointer-keyboard-action-parity",
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
    expect(calls.every((call) => call.opts?.author === "human")).toBe(true);
  });

  test("component-repeat-burst-coalescing", async () => {
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
  });

  test("component-body-edge-modifiers-use-the-pointer-edit-algebra", async () => {
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
    await runEdit("{Alt>}{ArrowRight}{/Alt}");
    await runEdit("{Control>}{ArrowRight}{/Control}");
    await runEdit("{Tab}{Alt>}{ArrowRight}{/Alt}");
    await runEdit("{Tab}{Tab}{Control>}{ArrowRight}{/Control}");
    expect(calls.map((call) => call.invocation)).toEqual([
      { op: "slip", args: { uuid: ALPHA_ID, delta: -1 } },
      { op: "slide", args: { uuid: ALPHA_ID, delta: 1 } },
      { op: "trimIn", args: { uuid: ALPHA_ID, delta: 1, rippleAllTracks: true } },
      {
        op: "roll",
        args: {
          track: { trackId: "playlist0" },
          leftUuid: ALPHA_ID,
          rightUuid: "clip-b",
          delta: 1,
        },
      },
    ]);
  });

  test("component-compatible-track-navigation", async () => {
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

  test("component-escape-cancel-conflict-protection", async () => {
    const calls: Call[] = [];
    await renderHarness(calls, true);
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
  });

  test("component-strictmode-listener-cleanup", async () => {
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

  test("component-toolbar-announces-save-undo-redo-and-dirty-state", async () => {
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

  test("component-axe-structural-semantics", async () => {
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
