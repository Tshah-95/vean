import { isDeepStrictEqual } from "node:util";
import type { Timeline } from "../../src/ir/types";

type SplitActionEvidence = {
  actionId?: string;
  input?: { uuid?: string; frame?: number };
  envelope?: {
    ok?: boolean;
    value?: {
      ok?: boolean;
      revision?: number;
      ir?: Timeline;
      consequences?: {
        clipsAdded?: Array<{ uuid?: string; track?: string; position?: number; playtime?: number }>;
        clipsTrimmed?: Array<{
          uuid?: string;
          inDelta?: number;
          outDelta?: number;
          playtimeDelta?: number;
        }>;
      };
    };
  };
  parsed: Timeline;
  originalUuid: string;
  splitFrame: number;
  timelinePath: string;
  savePath?: string;
  beforeHash: string;
  afterHash: string;
};

export function evaluateSplitPersistence(input: SplitActionEvidence): Record<string, boolean> {
  const value = input.envelope?.value;
  const added = value?.consequences?.clipsAdded ?? [];
  const trimmed = value?.consequences?.clipsTrimmed ?? [];
  const addedUuid = added[0]?.uuid;
  const track = input.parsed.tracks.video[0];
  const items = track?.items ?? [];
  const head = items[0];
  const tail = items[1];
  return {
    exactAction:
      input.actionId === "split" &&
      input.input?.uuid === input.originalUuid &&
      input.input.frame === input.splitFrame,
    exactConsequences:
      added.length === 1 &&
      typeof addedUuid === "string" &&
      added[0]?.track === "playlist0" &&
      added[0]?.position === 0 &&
      added[0]?.playtime === input.splitFrame &&
      trimmed.length === 1 &&
      trimmed[0]?.uuid === input.originalUuid &&
      trimmed[0]?.inDelta === 0 &&
      trimmed[0]?.outDelta === 0 &&
      trimmed[0]?.playtimeDelta === -input.splitFrame,
    exactParsedSplit:
      input.parsed.tracks.video.length === 1 &&
      input.parsed.tracks.audio.length === 0 &&
      track?.id === "playlist0" &&
      items.length === 2 &&
      head?.kind === "clip" &&
      head.id === addedUuid &&
      head.in === 0 &&
      head.out === input.splitFrame - 1 &&
      head.length === input.splitFrame &&
      tail?.kind === "clip" &&
      tail.id === input.originalUuid &&
      tail.in === 0 &&
      tail.out === 119 - input.splitFrame &&
      tail.length === 120 - input.splitFrame,
    actionIrMatchesPersistedIr:
      value?.ir !== undefined && isDeepStrictEqual(value.ir, input.parsed),
    exactSave:
      input.beforeHash !== input.afterHash &&
      input.savePath === input.timelinePath &&
      input.envelope?.ok === true &&
      value?.ok === true &&
      value.revision === 1,
  };
}
