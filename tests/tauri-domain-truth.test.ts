import { describe, expect, it } from "vitest";
import { evaluateSplitPersistence } from "../scripts/harness/tauri-domain-truth";
import type { Timeline } from "../src/ir/types";

const originalUuid = "{7c1a0e2a-0001-4abc-9d00-000000000001}";
const addedUuid = "added-uuid";
const timeline = {
  tracks: {
    audio: [],
    video: [
      {
        id: "playlist0",
        items: [
          { kind: "clip", id: addedUuid, in: 0, out: 39, length: 40 },
          { kind: "clip", id: originalUuid, in: 0, out: 79, length: 80 },
        ],
      },
    ],
  },
} as unknown as Timeline;
const canonical = {
  actionId: "split",
  input: { uuid: originalUuid, frame: 40 },
  envelope: {
    ok: true,
    value: {
      ok: true,
      revision: 1,
      ir: timeline,
      consequences: {
        clipsAdded: [{ uuid: addedUuid, track: "playlist0", position: 0, playtime: 40 }],
        clipsTrimmed: [{ uuid: originalUuid, inDelta: 0, outDelta: 0, playtimeDelta: -40 }],
      },
    },
  },
  parsed: timeline,
  originalUuid,
  splitFrame: 40,
  timelinePath: "/tmp/timeline.mlt",
  savePath: "/tmp/timeline.mlt",
  beforeHash: "before",
  afterHash: "after",
};

describe("native split persistence truth", () => {
  it("accepts exact action, consequence, action IR, and parsed saved IR", () => {
    expect(Object.values(evaluateSplitPersistence(canonical)).every(Boolean)).toBe(true);
  });

  it("rejects a foreign added UUID in the parsed document", () => {
    const parsed = structuredClone(timeline);
    const head = parsed.tracks.video[0]?.items[0];
    if (head?.kind === "clip") head.id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    expect(evaluateSplitPersistence({ ...canonical, parsed }).exactParsedSplit).toBe(false);
  });

  it("rejects the right IDs with wrong split lengths", () => {
    const parsed = structuredClone(timeline);
    const head = parsed.tracks.video[0]?.items[0];
    if (head?.kind === "clip") head.length = 39;
    expect(evaluateSplitPersistence({ ...canonical, parsed }).exactParsedSplit).toBe(false);
  });

  it("rejects action IR that differs from the externally parsed save", () => {
    const parsed = structuredClone(timeline);
    parsed.title = "foreign";
    expect(evaluateSplitPersistence({ ...canonical, parsed }).actionIrMatchesPersistedIr).toBe(
      false,
    );
  });
});
