// addFilter / removeFilter — attach / detach a filter on a clip's producer,
// ORDER-preserving (melt applies filters in list order, so the index is
// load-bearing). Both verbs live here (they share the ordered-list mechanics)
// and register separately ("addFilter" / "removeFilter").
//
// Shotcut semantics (`filtercommands.cpp` + producer.attach/detach): attach a
// filter at an index (appended past the end) or detach the one at an index. In
// vean's IR the producer's filter list is `Clip.filters: Filter[]` — addFilter
// splices the new filter in at the (clamped) index; removeFilter drops the one
// at `index`.
//
// Fade sentinels (`vean.fadeIn` / `vean.fadeOut`) live in this same list but are
// OWNED by the fade ops. These filter ops operate POSITIONALLY (they index the
// raw list, sentinels included) so the inverse can restore the exact prior order
// byte-for-byte; when an op touches a sentinel we add a non-fatal WARNING so the
// consequence log flags that the canonical surface for fades is fadeIn/fadeOut.
//
// Inverse: addFilter ↔ removeFilter. addFilter inserts at a resolved index → its
// inverse is removeFilter at THAT index. removeFilter captures the dropped filter
// + its index → its inverse is addFilter of that filter at that index. Both are
// public registry ops, so no internal restore op is needed.
import type { Clip, Filter, Timeline, Track } from "../ir/types";
import { cloneTimeline, findClip, isFadeIn, isFadeOut } from "./primitives";
import {
  type AddFilterArgs,
  type EditError,
  type Op,
  type OpResult,
  type RemoveFilterArgs,
  type Warning,
  addFilterArgs,
  editError,
  noConsequences,
  removeFilterArgs,
} from "./types";

/** Normalize the Zod-parsed filter arg into a concrete IR `Filter` (properties
 *  defaulted to `{}`, shotcutName carried only when present). */
function toFilter(f: AddFilterArgs["filter"]): Filter {
  const out: Filter = { service: f.service, properties: { ...f.properties } };
  if (f.shotcutName != null) out.shotcutName = f.shotcutName;
  return out;
}

/** A warning iff the targeted filter is a fade sentinel (fades have their own
 *  ops; the filter ops still operate on it positionally for round-trip exactness). */
function sentinelWarning(f: Filter | undefined): Warning[] {
  if (f && (isFadeIn(f) || isFadeOut(f))) {
    return [
      {
        code: "filter-targets-fade-sentinel",
        detail: `filter at the target index is a fade sentinel ("${f.service}"); the canonical surface for fades is the fadeIn/fadeOut ops`,
      },
    ];
  }
  return [];
}

export const addFilter: Op<AddFilterArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  const filters = loc.clip.filters;
  // Clamp the insertion index to [0, len] (appended when omitted or past the end),
  // mirroring producer.attach's "append if beyond the list" behaviour.
  const at =
    args.index == null ? filters.length : Math.min(Math.max(args.index, 0), filters.length);
  const filter = toFilter(args.filter);

  const next = cloneTimeline(state);
  const target = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items[loc.itemIndex] as Clip;
  target.filters = [...target.filters.slice(0, at), filter, ...target.filters.slice(at)];

  const c = noConsequences();
  // A filter attach changes no frames and no entries — report it as a zero-length
  // trim of the clip so the consequence log still names the affected content.
  c.clipsTrimmed.push({ uuid: loc.clip.id, inDelta: 0, outDelta: 0, playtimeDelta: 0 });

  return {
    state: next,
    consequences: c,
    // The inverse removes exactly what we inserted, at the index it landed.
    inverse: { op: "removeFilter", args: { uuid: args.uuid, index: at } },
  };
};

export const removeFilter: Op<RemoveFilterArgs> = (state, args): OpResult | EditError => {
  const loc = findClip(state, args.uuid);
  if (!loc) return editError({ kind: "clip-not-found", uuid: args.uuid });

  const filters = loc.clip.filters;
  if (args.index < 0 || args.index >= filters.length) {
    return editError({
      kind: "frame-out-of-range",
      frame: args.index,
      bound: filters.length,
      detail:
        `removeFilter: index ${args.index} is out of range for clip "${args.uuid}" ` +
        `(${filters.length} filter${filters.length === 1 ? "" : "s"})`,
    });
  }

  // Capture the exact filter (and its index) for the inverse BEFORE mutating.
  const removed: Filter = structuredClone(filters[args.index] as Filter);

  const next = cloneTimeline(state);
  const target = (next.tracks[loc.trackKind][loc.trackIndex] as Track).items[loc.itemIndex] as Clip;
  target.filters = [
    ...target.filters.slice(0, args.index),
    ...target.filters.slice(args.index + 1),
  ];

  const c = noConsequences();
  c.clipsTrimmed.push({ uuid: loc.clip.id, inDelta: 0, outDelta: 0, playtimeDelta: 0 });
  c.warnings.push(...sentinelWarning(removed));

  return {
    state: next,
    consequences: c,
    // Re-attach the captured filter at the captured index (exact restore).
    inverse: {
      op: "addFilter",
      args: {
        uuid: args.uuid,
        filter: {
          service: removed.service,
          properties: removed.properties,
          ...(removed.shotcutName != null ? { shotcutName: removed.shotcutName } : {}),
        },
        index: args.index,
      },
    },
  };
};

export { addFilterArgs, removeFilterArgs };

// ─── samples (registry-driven invariant harness) ──────────────────────────────
import { clip, colorClip, filter, resetIds, timeline, videoTrack } from "../ir/builder";
import { VERTICAL } from "../ir/profile";
import type { OpSample } from "./types";

export const samplesAddFilter: OpSample<AddFilterArgs>[] = [
  {
    name: "append a sepia filter to a clip with no filters",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [videoTrack(clip("/abs/scene.mp4", { id: "shot", dur: 60 }))],
      });
    },
    // No index → appended; inverse removeFilter at the resolved tail index.
    args: { uuid: "shot", filter: { service: "sepia", properties: { u: 75, v: 150 } } },
  },
  {
    name: "insert a filter at index 0 ahead of an existing escape-hatch filter",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/scene.mp4", {
              id: "shot2",
              dur: 60,
              filters: [filter("oldfilm", { delta: 1 })],
            }),
          ),
        ],
      });
    },
    args: { uuid: "shot2", index: 0, filter: { service: "grain", properties: { noise: 40 } } },
  },
];

export const samplesRemoveFilter: OpSample<RemoveFilterArgs>[] = [
  {
    name: "remove the only filter on a clip",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            clip("/abs/scene.mp4", {
              id: "shot3",
              dur: 60,
              filters: [filter("sepia", { u: 75, v: 150 })],
            }),
          ),
        ],
      });
    },
    args: { uuid: "shot3", index: 0 },
  },
  {
    name: "remove the middle filter of three (order-preserving inverse)",
    state: (): Timeline => {
      resetIds();
      return timeline(VERTICAL, {
        video: [
          videoTrack(
            colorClip(60, "gold", {
              id: "shot4",
              filters: [
                filter("sepia", { u: 75, v: 150 }),
                filter("oldfilm", { delta: 1 }),
                filter("grain", { noise: 40 }),
              ],
            }),
          ),
        ],
      });
    },
    args: { uuid: "shot4", index: 1 },
  },
];
