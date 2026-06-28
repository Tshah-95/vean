import type { z } from "zod";
import type { SchemaSummary } from "../actions/schema-summary";
import { summarizeSchema } from "../actions/schema-summary";
import { OP_NAMES, REGISTRY } from "./index";

export type OpCategory = "placement" | "trim" | "transition" | "audio" | "filter" | "track";

export type OpExample = {
  name: string;
  prompt: string;
  args: unknown;
  notes?: string;
};

export type OpDescriptor = {
  op: string;
  title: string;
  category: OpCategory;
  summary: string;
  description: string;
  aliases: string[];
  input: z.ZodTypeAny;
  inputSummary: SchemaSummary;
  examples: OpExample[];
  consequences: string[];
  inverse: string;
  hazards: string[];
};

export type OpSearchResult = {
  kind: "op";
  canonicalOp: string;
  title: string;
  aliases: string[];
  describeCommand: string;
  rank: number;
  score: number;
  reason: string;
};

type BaseDescriptor = Omit<OpDescriptor, "input" | "inputSummary">;

const exampleClip = {
  kind: "clip",
  id: "new-clip",
  resource: "/media/example.mp4",
  in: 0,
  out: 29,
  length: 120,
  filters: [],
};

const descriptors: BaseDescriptor[] = [
  op("append", "Append Clip", "placement", "Place a clip at the end of a track.", [], {
    inverse: "_dropAppended",
    prompt: "append this clip",
    args: { track: { kind: "video", index: 0 }, clip: exampleClip },
  }),
  op("split", "Split Clip", "trim", "Cut one clip at a timeline frame.", [], {
    inverse: "_unsplit",
    prompt: "cut clip-3 at frame 120",
    args: { uuid: "clip-3", frame: 120 },
  }),
  op("insert", "Insert Clip", "placement", "Insert a clip at a position.", [], {
    inverse: "_uninsert",
    prompt: "insert this b-roll at frame 90",
    args: { track: { kind: "video", index: 0 }, clip: exampleClip, position: 90 },
  }),
  op("overwrite", "Overwrite Range", "placement", "Replace covered material with a clip.", [], {
    inverse: "_restoreRegion",
    prompt: "overwrite this section with b-roll",
    args: { track: { kind: "video", index: 0 }, clip: exampleClip, position: 90 },
  }),
  op(
    "lift",
    "Lift Clip",
    "placement",
    "Delete a clip but preserve timing with a blank.",
    ["delete-gap", "remove-no-ripple"],
    {
      inverse: "_unlift",
      prompt: "delete clip-3 but leave a gap",
      args: { uuid: "clip-3" },
    },
  ),
  op(
    "remove",
    "Ripple Delete Clip",
    "placement",
    "Ripple-delete a clip and close the gap.",
    ["ripple-delete", "delete-ripple"],
    {
      inverse: "_reinsert",
      prompt: "ripple delete clip-3",
      args: { uuid: "clip-3" },
    },
  ),
  op("replace", "Replace Clip", "placement", "Swap a clip producer while keeping timing.", [], {
    inverse: "replace",
    prompt: "replace this shot but keep timing",
    args: { uuid: "clip-3", clip: exampleClip },
  }),
  op(
    "trimIn",
    "Trim In",
    "trim",
    "Move a clip's in point; positive delta trims the head.",
    ["trim-in"],
    {
      inverse: "trimIn",
      prompt: "trim the head of clip-3 by 12 frames",
      args: { uuid: "clip-3", delta: 12 },
    },
  ),
  op(
    "trimOut",
    "Trim Out",
    "trim",
    "Move a clip's out point; positive delta shortens the tail.",
    ["trim-out"],
    {
      inverse: "trimOut",
      prompt: "trim the tail shorter by 10 frames",
      args: { uuid: "clip-3", delta: 10 },
    },
  ),
  op("move", "Move Clip", "placement", "Relocate a clip to a track and position.", [], {
    inverse: "move",
    prompt: "move clip-3 to the second video track",
    args: { uuid: "clip-3", toTrack: { kind: "video", index: 1 }, toPosition: 120 },
  }),
  op("dissolve", "Dissolve", "transition", "Create a same-track crossfade.", ["crossfade"], {
    inverse: "_removeDissolve",
    prompt: "crossfade these adjacent clips",
    args: {
      track: { kind: "video", index: 0 },
      leftUuid: "clip-1",
      rightUuid: "clip-2",
      frames: 12,
    },
  }),
  op("fadeIn", "Fade In", "transition", "Set or remove a clip fade-in length.", [], {
    inverse: "fadeIn",
    prompt: "fade clip-3 in over 15 frames",
    args: { uuid: "clip-3", frames: 15 },
  }),
  op("fadeOut", "Fade Out", "transition", "Set or remove a clip fade-out length.", [], {
    inverse: "fadeOut",
    prompt: "fade clip-3 out over 15 frames",
    args: { uuid: "clip-3", frames: 15 },
  }),
  op("gain", "Set Gain", "audio", "Set audio gain in decibels.", ["volume", "set-gain"], {
    inverse: "_setGain",
    prompt: "duck clip-5 audio by 6 dB",
    args: { uuid: "clip-5", db: -6 },
    description: "Use this when changing clip loudness; the input is dB, not a linear multiplier.",
  }),
  op("addFilter", "Add Filter", "filter", "Attach an ordered filter to a clip producer.", [], {
    inverse: "removeFilter",
    prompt: "add a brightness filter",
    args: { uuid: "clip-3", filter: { service: "brightness", properties: {} } },
  }),
  op("removeFilter", "Remove Filter", "filter", "Detach a filter by index.", [], {
    inverse: "addFilter",
    prompt: "remove the first filter from clip-3",
    args: { uuid: "clip-3", index: 0 },
  }),
  op("addTrack", "Add Track", "track", "Add a video or audio track.", [], {
    inverse: "removeTrack",
    prompt: "add an audio track",
    args: { kind: "audio" },
  }),
  op("removeTrack", "Remove Track", "track", "Remove a track and capture inverse state.", [], {
    inverse: "_restoreTrack",
    prompt: "remove the second video track",
    args: { track: { kind: "video", index: 1 } },
  }),
];

function op(
  name: string,
  title: string,
  category: OpCategory,
  summary: string,
  aliases: string[],
  options: {
    inverse: string;
    prompt: string;
    args: unknown;
    description?: string;
  },
): BaseDescriptor {
  return {
    op: name,
    title,
    category,
    summary,
    description: options.description ?? `Use this when you need to ${summary.toLowerCase()}`,
    aliases,
    examples: [{ name: title, prompt: options.prompt, args: options.args }],
    consequences: [summary],
    inverse: options.inverse,
    hazards: [],
  };
}

function hydrate(descriptor: BaseDescriptor): OpDescriptor {
  const input = REGISTRY[descriptor.op]?.args as z.ZodTypeAny | undefined;
  if (!input) throw new Error(`catalog descriptor references unknown op: ${descriptor.op}`);
  return { ...descriptor, input, inputSummary: summarizeSchema(input) };
}

const catalog = descriptors.map(hydrate);
const byOp = new Map(catalog.map((descriptor) => [descriptor.op, descriptor]));
const byAlias = new Map<string, string>();

for (const descriptor of catalog) {
  for (const alias of descriptor.aliases) {
    const existing = byAlias.get(alias);
    if (existing)
      throw new Error(`duplicate op alias "${alias}" for ${existing} and ${descriptor.op}`);
    byAlias.set(alias, descriptor.op);
  }
}

for (const name of OP_NAMES) {
  if (!byOp.has(name)) throw new Error(`missing op catalog descriptor for ${name}`);
}

export function listOpDescriptors(): OpDescriptor[] {
  return OP_NAMES.map((name) => byOp.get(name)).filter((value): value is OpDescriptor => !!value);
}

export function resolveOpName(nameOrAlias: string): { canonicalOp: string; resolvedFrom?: string } {
  if (byOp.has(nameOrAlias)) return { canonicalOp: nameOrAlias };
  const canonicalOp = byAlias.get(nameOrAlias);
  if (canonicalOp) return { canonicalOp, resolvedFrom: nameOrAlias };
  throw new Error(`unknown op: ${nameOrAlias}`);
}

export function describeOp(nameOrAlias: string): {
  descriptor: OpDescriptor;
  canonicalOp: string;
  resolvedFrom?: string;
} {
  const resolved = resolveOpName(nameOrAlias);
  const descriptor = byOp.get(resolved.canonicalOp);
  if (!descriptor) throw new Error(`unknown op: ${nameOrAlias}`);
  return { descriptor, ...resolved };
}

function scoreDescriptor(
  descriptor: OpDescriptor,
  query: string,
): { score: number; reason: string } {
  const q = query.toLowerCase();
  const fields: Array<[string, string, number]> = [
    ["op", descriptor.op, 100],
    ["title", descriptor.title, 70],
    ["summary", descriptor.summary, 45],
    ["description", descriptor.description, 30],
    ["category", descriptor.category, 20],
    ...descriptor.aliases.map((alias) => ["alias", alias, 90] as [string, string, number]),
    ...descriptor.examples.map(
      (example) => ["example", example.prompt, 55] as [string, string, number],
    ),
  ];
  let best = { score: 0, reason: "" };
  for (const [field, value, weight] of fields) {
    const text = value.toLowerCase();
    if (text === q) {
      const score = weight + 20;
      if (score > best.score) best = { score, reason: `${field} exact match` };
    } else if (text.includes(q) || q.split(/\s+/).every((part) => text.includes(part))) {
      if (weight > best.score) best = { score: weight, reason: `${field} match` };
    }
  }
  return best;
}

export function searchOps(query: string): OpSearchResult[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  return listOpDescriptors()
    .map((descriptor) => ({ descriptor, ...scoreDescriptor(descriptor, trimmed) }))
    .filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.descriptor.op.localeCompare(b.descriptor.op))
    .map((result, index) => ({
      kind: "op" as const,
      canonicalOp: result.descriptor.op,
      title: result.descriptor.title,
      aliases: result.descriptor.aliases,
      describeCommand: `vean timeline ops describe ${result.descriptor.op} --json`,
      rank: index + 1,
      score: result.score,
      reason: result.reason,
    }));
}
