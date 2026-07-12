import { describe, expect, it } from "vitest";
import {
  type BrowserMutationObservation,
  evaluateBrowserMutation,
} from "../scripts/harness/browser-domain-truth";

const uri = "/tmp/fixture/current.mlt";
const input = {
  uuid: "clip-1",
  toTrack: { trackId: "playlist0" },
  toPosition: 1,
  ripple: false,
  rippleAllTracks: false,
};

function baseline(): BrowserMutationObservation {
  return {
    currentDocumentUri: uri,
    expectedActionId: "move",
    expectedInput: input,
    actionRequest: { op: "move", args: input, route: uri },
    actionResponse: {
      ok: true,
      consequences: { clipsMoved: [{ uuid: "clip-1" }] },
      diagnostics: [],
      health: { errors: 0, warnings: 0 },
      dirty: true,
    },
    saveResponse: { ok: true, path: uri },
    beforeMltHash: "before",
    afterMltHash: "after",
    parsedPlacement: { track: "playlist0", position: 1, uuid: "clip-1" },
    expectedPlacement: { track: "playlist0", position: 1, uuid: "clip-1" },
    dom: {
      clipName: "solid teal, V1, timeline frames 1 to 120, source 0 to 119",
      dirtyBeforeSave: true,
      dirtyAfterSave: false,
    },
    cleanup: { developerCanaryUnchanged: true, sourceCorpusUnchanged: true },
  };
}

describe("browser editor domain truth", () => {
  it("accepts a complete action -> current document -> reparsed IR chain", () => {
    expect(evaluateBrowserMutation(baseline())).toEqual({ ok: true, issues: [] });
  });

  it("rejects a visible/DOM decoy that never persisted", () => {
    const value = baseline();
    value.afterMltHash = value.beforeMltHash;
    expect(evaluateBrowserMutation(value)).toEqual({
      ok: false,
      issues: [
        {
          code: "E_BROWSER_DOCUMENT_PERSISTENCE",
          detail: "visible state changed without changing the persisted current .mlt",
        },
      ],
    });
  });

  it("rejects an expected edit persisted to a different timeline", () => {
    const value = baseline();
    value.saveResponse.path = "/tmp/fixture/decoy.mlt";
    expect(evaluateBrowserMutation(value).issues.map((issue) => issue.code)).toEqual([
      "E_BROWSER_CURRENT_URI",
    ]);
  });
});
