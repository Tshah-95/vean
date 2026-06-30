// import-with-provenance — bring a clip that was generated/captured ELSEWHERE
// onto the timeline and PIN its typed origin (`Provenance`) to the clip, so the
// provenance survives EXPORT. This is the import half of roadmap T7 and the
// decided generative posture (vean-next-roadmap §2/§7 #2):
//
//   import-with-provenance NOW; NO in-core generation. vean never calls a model;
//   you bring a clip a model produced and we record where it came from in the
//   typed IR. The later, opt-in `generate.*` job/network adapter (designed but
//   NOT built — see artifacts/research/generative-adapter-design.md) is what would
//   *produce* such a clip; it stays OUTSIDE the no-network core, behind a job.
//
// THE DIFFERENTIATOR vs Palmier: their `.palmier`→NLE-XML export is LOSSY — all AI
// metadata (prompt/model/refs) dies on export. vean models provenance as a first-
// class IR field (H2: `clip.provenance`, NOT `extraProps`) that round-trips through
// serialize/parse as `vean:provenance.*` producer properties, so it SURVIVES export
// and a later agent (or a UI's "regenerate in place") can read prompt/model/refs off
// the very `.mlt` it edits — even after a round-trip through another tool that just
// preserves unknown `<property>` children.
//
// This module reuses the existing import/add-footage plumbing exactly: it builds a
// footage clip via the `src/ir/builder` `clip()` (which already accepts `provenance`
// from H2) and appends it with the pure `append` op — so undo, consequences, and the
// ordered inverse come for FREE and the edit algebra stays pure. It adds NO new op
// kind, NO new serializer branch, and (like `timelineBuild.addFootage`) forces the
// label away from any `graphic`-prefix so the preview proxy keeps the clip as footage.
import { z } from "zod";
import { clip as buildClip, uuid } from "../ir/builder";
import type { Provenance, ProvenanceSource, Timeline } from "../ir/types";
import { provenanceSchema } from "../ir/types";
import { apply } from "../ops";
import type { Consequences, EditError, OpInvocation } from "../ops/types";
import { isEditError } from "../ops/types";
import { type ResolvedProject, resolveProject } from "../project/context";
import type { ActionContext, ActionDefinition } from "./types";

// ─── Local registry helpers ────────────────────────────────────────────────────
// `action`, `trackAddrInput`, and `projectFor` are module-private in `./registry`.
// This stream owns ONLY this file (it must not edit the shared registry beyond a
// single flagged registration line), so it re-declares the identical helpers here.
// They are intentionally byte-for-byte the registry's: `action` is the identity
// pass-through for type inference, `trackAddrInput` mirrors the registry union, and
// `projectFor` reproduces the same cwd/env resolution + fallback.

/** Identity pass-through that pins an action's input/output generics (mirrors
 *  `./registry` `action`). */
function action<I, O>(definition: ActionDefinition<I, O>): ActionDefinition<I, O> {
  return definition;
}

/** A track address: a stable track id or a (kind, index) pair (mirrors `./registry`). */
const trackAddrInput = z.union([
  z.object({ trackId: z.string().min(1) }),
  z.object({ kind: z.enum(["video", "audio"]), index: z.number().int().nonnegative() }),
]);

/** Resolve the project for this invocation, falling back to an explicit root over
 *  the context cwd (mirrors `./registry` `projectFor`). */
function projectFor(ctx: ActionContext, repo?: string): ResolvedProject {
  const root = repo ?? ctx.project?.rootPath ?? ctx.cwd;
  return (
    resolveProject({ project: root, cwd: ctx.cwd, env: ctx.env }) ?? {
      rootPath: root,
      source: "explicit",
      stateDbPath: "",
    }
  );
}

/** Render an op `EditError` to a human-readable detail string (mirrors `./registry`
 *  `editErrorMsg`). Only some arms carry `detail`, so the others map from `kind`. */
function editErrorMsg(e: EditError): string {
  if ("detail" in e && e.detail) return e.detail;
  if (e.kind === "clip-not-found") return `clip not found: ${e.uuid}`;
  if (e.kind === "track-not-found") return `track not found: ${e.track}`;
  return e.kind;
}

// ─── The pure helper (mirrors `timelineBuild.addFootage`) ──────────────────────
export type ImportWithProvenanceArgs = {
  /** Media-file path of the clip being imported (an ABSOLUTE path so melt resolves
   *  it regardless of cwd; the action layer may store it root-relative). */
  resource: string;
  /** Source-duration in frames. Required — the helper is pure and does not probe;
   *  the action layer auto-probes from the file when the caller omits it. */
  durationFrames: number;
  /** Inclusive source in-point. Default 0. */
  inFrame: number;
  /** The typed origin to PIN to the clip. `source` is required (the only mandatory
   *  provenance field); the rest describe a generative/captured origin so a UI/agent
   *  can regenerate in place. */
  provenance: Provenance;
  /** Target video track id; when omitted, the first/bottom video track (or a fresh
   *  one if the timeline has none and `createTrackIfMissing`). */
  trackId?: string;
  /** Human label for the clip (forced away from a `graphic`-prefix — see below). */
  label?: string;
  createTrackIfMissing: boolean;
};

export type ImportWithProvenanceResult = {
  state: Timeline;
  consequences: Consequences;
  /** The ordered inverse sequence (UNDO order: reverse of apply order). */
  inverse: OpInvocation[];
  /** The id of the video track the clip landed on. */
  trackId: string;
  /** True iff a fresh video track was created. */
  createdTrack: boolean;
  /** The stable id of the imported clip (so a caller can address it for a later
   *  regenerate-in-place). */
  clipId: string;
};

function emptyConsequences(): Consequences {
  return {
    clipsAdded: [],
    clipsRemoved: [],
    clipsMoved: [],
    clipsTrimmed: [],
    blanksCreated: [],
    blanksRemoved: [],
    ripple: [],
    durationDelta: 0,
    warnings: [],
  };
}

function mergeConsequences(acc: Consequences, next: Consequences): void {
  acc.clipsAdded.push(...next.clipsAdded);
  acc.clipsRemoved.push(...next.clipsRemoved);
  acc.clipsMoved.push(...next.clipsMoved);
  acc.clipsTrimmed.push(...next.clipsTrimmed);
  acc.blanksCreated.push(...next.blanksCreated);
  acc.blanksRemoved.push(...next.blanksRemoved);
  acc.ripple.push(...next.ripple);
  acc.durationDelta += next.durationDelta;
  acc.warnings.push(...next.warnings);
}

/**
 * Append an imported footage clip with its typed provenance PINNED, optionally
 * creating the target video track. The provenance flows onto the clip via the
 * `src/ir/builder` `clip()` (H2 wired `provenance` through the builder), and the
 * `append` op preserves it (it `structuredClone`s the whole clip) — so once
 * serialized, the origin round-trips as `vean:provenance.*` producer properties
 * and survives export. Wraps the existing `addTrack` + `append` ops, so the result
 * carries proper consequences + an ordered inverse sequence (UNDO order). Pure:
 * never mutates `state`. Returns an EditError on a typed precondition.
 */
export function importWithProvenance(
  state: Timeline,
  args: ImportWithProvenanceArgs,
): ImportWithProvenanceResult | EditError {
  // Validate the provenance up front so a malformed origin fails loudly here,
  // before any IR is built — the same loud-failure posture as the rest of the IR.
  const provenance = provenanceSchema.parse(args.provenance);

  const aggregate = emptyConsequences();
  const inverseStack: OpInvocation[] = [];
  let work = state;
  let createdTrack = false;

  // Resolve the target video track (footage lands on the FIRST/bottom video track
  // by default; graphics live above it — same rule as `timelineBuild.addFootage`).
  let trackId: string | undefined = args.trackId;
  if (trackId) {
    const exists = work.tracks.video.some((t) => t.id === trackId);
    if (!exists) return { kind: "track-not-found", track: trackId };
  } else if (work.tracks.video.length > 0) {
    trackId = (work.tracks.video[0] as { id: string }).id;
  } else {
    if (!args.createTrackIfMissing) {
      return {
        kind: "precondition",
        detail: "importWithProvenance: no video track and createTrackIfMissing is false",
      };
    }
    const addInv: OpInvocation = { op: "addTrack", args: { kind: "video", name: "V1" } };
    const added = apply(addInv, work);
    if (isEditError(added)) return added;
    work = added.state;
    mergeConsequences(aggregate, added.consequences);
    inverseStack.push(added.inverse);
    createdTrack = true;
    trackId = (work.tracks.video[work.tracks.video.length - 1] as { id: string }).id;
  }

  // A `graphic`-prefixed label would make the preview proxy treat this as a
  // stripped overlay — imported footage must never be labelled that way.
  const label = args.label && !/^graphic\b/i.test(args.label) ? args.label : "footage";

  // Mint a runtime-unique uuid (NOT the deterministic authoring counter, which
  // resets to clip-0 at the start of every one-shot CLI process — two imports
  // would then collide on `clip-0`, making the returned inverse ambiguous).
  // Identity = stable producer uuids (AGENTS.md load-bearing invariant).
  const clipId = uuid();
  const importedClip = buildClip(args.resource, {
    id: clipId,
    in: args.inFrame,
    dur: args.durationFrames,
    label,
    // The differentiator: the typed origin rides ON the clip, into the IR, through
    // serialize, and survives export as `vean:provenance.*` producer properties.
    provenance,
  });
  const appendInv: OpInvocation = {
    op: "append",
    args: { track: { trackId }, clip: importedClip },
  };
  const appended = apply(appendInv, work);
  if (isEditError(appended)) return appended;
  work = appended.state;
  mergeConsequences(aggregate, appended.consequences);
  inverseStack.push(appended.inverse);

  return {
    state: work,
    consequences: aggregate,
    inverse: [...inverseStack].reverse(),
    trackId,
    createdTrack,
    clipId,
  };
}

// ─── The registered action ─────────────────────────────────────────────────────
// `timeline.importWithProvenance` — the surface over the helper. Resolves the
// timeline target, auto-probes the duration when omitted (reusing the same
// `probeMediaFrames` driver as `addFootage`), appends the clip with provenance, and
// returns the standard envelope (consequences + inverse + touched URIs). Registered
// in `./registry` (commented block — flagged for the lead, see S4 integrationNotes).

/** `ProvenanceSource` as a Zod enum mirror — kept local so the action's input schema
 *  documents the accepted origins inline. Defaults to `generative` because that is
 *  the primary case this action exists for (the import-with-provenance posture). */
const provenanceSourceInput = z
  .enum(["import", "generative", "capture", "remotion"] satisfies [
    ProvenanceSource,
    ...ProvenanceSource[],
  ])
  .default("generative");

/** The provenance INPUT schema (source defaulted; the rest optional). Separate from
 *  the IR's `provenanceSchema` so the action surface documents `generative` as the
 *  default origin while the IR keeps `source` strictly required. */
const provenanceInput = z.object({
  source: provenanceSourceInput,
  model: z.string().optional(),
  prompt: z.string().optional(),
  references: z.array(z.string()).optional(),
  tool: z.string().optional(),
  createdAt: z.string().optional(),
});
export type ProvenanceInput = z.input<typeof provenanceInput>;

/** The action id this surface registers under — also the default `provenance.tool`
 *  value, so an imported clip records which surface produced it. */
export const IMPORT_WITH_PROVENANCE_ACTION_ID = "timeline.importWithProvenance";

/**
 * Normalize a provenance INPUT into a validated `Provenance`: apply the `source`
 * default, stamp the producing `tool` and a `createdAt` (from the injected clock's
 * `nowIso`) when the caller omitted them. PURE and clock-injected, so it is
 * deterministic and unit-testable without touching the filesystem or state DB (the
 * action's `execute` path dynamically loads state modules that need `bun:sqlite`,
 * which is why the stamping logic lives here, separately verifiable).
 */
export function normalizeImportProvenance(input: ProvenanceInput, nowIso: string): Provenance {
  const parsed = provenanceInput.parse(input);
  return provenanceSchema.parse({
    ...parsed,
    createdAt: parsed.createdAt ?? nowIso,
    tool: parsed.tool ?? IMPORT_WITH_PROVENANCE_ACTION_ID,
  });
}

export const importWithProvenanceAction: ActionDefinition = action({
  id: IMPORT_WITH_PROVENANCE_ACTION_ID,
  title: "Import Clip With Provenance",
  description:
    "Import a clip that was generated/captured ELSEWHERE onto a video track and PIN its typed origin (source/model/prompt/references) to the clip. Use this for an AI-generated b-roll clip (or any externally-produced media) so the prompt/model/refs survive EXPORT — unlike a plain add-footage, which records no origin. vean never generates in-core; bring the clip and we record where it came from. Duration is auto-probed when omitted.",
  aliases: ["import-generative", "import-with-provenance", "add-generative"],
  relatedDiscovery: ["timeline.addFootage", "timeline.ops.describe"],
  examples: [
    {
      name: "import an AI-generated establishing shot with full provenance",
      input: {
        resource: "/abs/media/broll/skyline-dusk.mov",
        provenance: {
          source: "generative",
          model: "veo-3.1",
          prompt: "slow aerial push over a city skyline at dusk, no text",
          references: ["/abs/media/refs/brand-mood.png"],
        },
      },
      prompt: "Import this generated b-roll and keep its prompt so I can regenerate it later.",
    },
  ],
  input: z.object({
    uri: z.string().optional(),
    timeline: z.string().optional(),
    resource: z.string().min(1),
    durationFrames: z.number().int().positive().optional(),
    inFrame: z.number().int().nonnegative().default(0),
    track: trackAddrInput.optional(),
    label: z.string().optional(),
    createTrackIfMissing: z.boolean().default(true),
    /** The typed origin to pin. `source` defaults to `generative`; `model`/`prompt`/
     *  `references` describe a generative origin and are what Palmier loses on export. */
    provenance: provenanceInput,
  }),
  output: z.unknown(),
  scopes: ["timeline:write", "fs:read", "fs:write"],
  effect: {
    kind: "update",
    mutates: ["timeline", "filesystem"],
    openWorld: false,
    destructive: false,
    idempotency: "non-idempotent",
    reversibility: "inverse-op",
    dryRun: "supported",
    approval: "ask",
    audit: "full-input",
  },
  surfaces: {
    cli: { command: "timeline import-with-provenance" },
    mcp: { name: "import-with-provenance" },
  },
  async execute(ctx, input) {
    const { parseDoc, serializeDoc } = await import("../bridge/tools/core");
    const { resolveTimelineTarget } = await import("../state/timeline");
    const project = projectFor(ctx);
    const timeline = resolveTimelineTarget(project.rootPath, project, input.timeline ?? input.uri);
    if ("ok" in timeline) return timeline;
    const state = parseDoc(await ctx.documents.read(timeline.uri));

    // Resolve a (kind,index) track address to its id (the helper takes a trackId).
    let trackId: string | undefined;
    if (input.track) {
      if ("trackId" in input.track) trackId = input.track.trackId;
      else {
        const list = state.tracks[input.track.kind];
        const t = list[input.track.index];
        if (!t) {
          return {
            ok: false,
            kind: "track-not-found",
            detail: `no ${input.track.kind} track at index ${input.track.index}`,
            uri: timeline.uri,
          };
        }
        trackId = t.id;
      }
    }

    // Auto-probe the clip length from the file when the caller didn't pass one —
    // the same driver `timeline.addFootage` uses, so the import path stays uniform.
    let durationFrames = input.durationFrames;
    if (durationFrames == null) {
      const { probeMediaFrames } = await import("../driver/melt");
      try {
        durationFrames = await probeMediaFrames(input.resource, state.profile.fps);
      } catch (e) {
        return {
          ok: false,
          kind: "probe-failed",
          detail: `could not auto-probe duration for ${input.resource}: ${
            e instanceof Error ? e.message : String(e)
          }. Pass --duration <frames>.`,
          uri: timeline.uri,
        };
      }
    }

    // Normalize the provenance: apply the `source` default and stamp the producing
    // `tool` + `createdAt` when omitted. The clock is injected (H1 DI) so the
    // timestamp is deterministic under test; the stamping is the pure, separately-
    // tested `normalizeImportProvenance`.
    const provenance = normalizeImportProvenance(input.provenance, ctx.clock.nowIso());

    const result = importWithProvenance(state, {
      resource: input.resource,
      durationFrames,
      inFrame: input.inFrame ?? 0,
      provenance,
      ...(trackId ? { trackId } : {}),
      ...(input.label ? { label: input.label } : {}),
      createTrackIfMissing: input.createTrackIfMissing ?? true,
    });
    if (!("state" in result)) {
      return {
        ok: false,
        kind: result.kind,
        detail: editErrorMsg(result),
        uri: timeline.uri,
      };
    }
    await ctx.documents.write(timeline.uri, serializeDoc(result.state));
    return {
      ok: true,
      consequences: result.consequences,
      inverse: result.inverse,
      trackId: result.trackId,
      createdTrack: result.createdTrack,
      clipId: result.clipId,
      provenance,
      durationFrames,
      uri: timeline.uri,
      resolvedPath: timeline.resolvedPath,
      touchedUris: [timeline.uri],
      project: timeline.project,
    };
  },
});
