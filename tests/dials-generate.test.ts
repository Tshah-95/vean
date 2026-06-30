// The dials GENERATOR golden — the YAML reader + field interpretation that turns
// `melt -query` output into typed dials. These are PURE-string tests over a
// representative fixture (NO melt subprocess), so they run in vitest and lock the
// parser's behavior on melt's exact grammar: the flat header, the parameters list,
// one-sided ranges, enum `values:`, block-scalar descriptions, the leaked
// `(*DEPRECATED*)` identifier, and the override merge. A future MLT upgrade that
// shifts the format, or a parser refactor, trips these before a bad catalog ships.
import { describe, expect, it } from "vitest";
import { buildDial, normalizeIdentifier, parseMeltQuery } from "../src/ir/dials/generate";

// A trimmed but faithful slice of real `melt -query "filter=brightness"` output:
// a header, a deprecated param whose marker LEAKED into its identifier, a
// one-sided-min param, a fully-bounded animatable param, and a block-scalar
// description that must be skipped without swallowing the next param.
const BRIGHTNESS_YAML = `---
schema_version: 7.0
type: filter
identifier: brightness
title: Brightness
tags:
  - Video
description: Adjust the brightness and opacity of the image.
parameters:
  - identifier: "end (*DEPRECATED*)"
    title: End level
    type: float
    minimum: 0.0
    maximum: 15.0
    default: 1.0
  - identifier: level
    title: Level
    type: float
    minimum: 0.0
    maximum: 15.0
    mutable: yes
    animation: yes
  - identifier: alpha
    title: Alpha factor
    description: "When this is less than zero, the alpha factor follows the level property."
    type: float
    minimum: -1
    mutable: yes
    animation: yes
  - identifier: rgb_only
    title: RGB Only
    description: |
                 When enabled, the filter will only operate on RGB.
                 A second line that MUST be skipped.
    type: boolean
    default: 0
`;

const QTBLEND_VALUES_YAML = `---
type: transition
identifier: qtblend
title: Composite and transform
parameters:
  - identifier: compositing
    title: Composition mode
    type: integer
    default: 0
    values:
      - 0 (source over)
      - 1 (destination over)
      - 2 (clear)
`;

describe("parseMeltQuery — melt's -query YAML subset", () => {
  it("reads the flat header", () => {
    const { header } = parseMeltQuery(BRIGHTNESS_YAML);
    expect(header.identifier).toBe("brightness");
    expect(header.title).toBe("Brightness");
    expect(header.schema_version).toBe("7.0");
  });

  it("reads every parameter in order, skipping block-scalar descriptions", () => {
    const { params } = parseMeltQuery(BRIGHTNESS_YAML);
    const ids = params.map((p) => p.fields.identifier);
    expect(ids).toEqual(["end (*DEPRECATED*)", "level", "alpha", "rgb_only"]);
    // The block-scalar `description: |` body did NOT leak into rgb_only's fields
    // nor swallow rgb_only itself — the param after the block is intact.
    const rgb = params.find((p) => p.fields.identifier === "rgb_only");
    expect(rgb?.fields.type).toBe("boolean");
    expect(rgb?.fields.default).toBe("0");
  });

  it("captures published min/max and the animation flag", () => {
    const { params } = parseMeltQuery(BRIGHTNESS_YAML);
    const level = params.find((p) => p.fields.identifier === "level");
    expect(level?.fields.minimum).toBe("0.0");
    expect(level?.fields.maximum).toBe("15.0");
    expect(level?.fields.animation).toBe("yes");
    // alpha is one-sided (min only).
    const alpha = params.find((p) => p.fields.identifier === "alpha");
    expect(alpha?.fields.minimum).toBe("-1");
    expect(alpha?.fields.maximum).toBeUndefined();
  });

  it("captures an enum values: list", () => {
    const { params } = parseMeltQuery(QTBLEND_VALUES_YAML);
    const comp = params.find((p) => p.fields.identifier === "compositing");
    expect(comp?.values).toEqual(["0 (source over)", "1 (destination over)", "2 (clear)"]);
  });
});

describe("normalizeIdentifier — cleans melt's leaked markers, keeps wildcards", () => {
  it("strips a leaked (*DEPRECATED*) suffix to the bare property name", () => {
    expect(normalizeIdentifier("end (*DEPRECATED*)")).toBe("end");
    expect(normalizeIdentifier("gain (*DEPRECATED*)")).toBe("gain");
  });

  it("leaves a legitimate wildcard (`producer.*`) identifier intact", () => {
    expect(normalizeIdentifier("producer.*")).toBe("producer.*");
    expect(normalizeIdentifier("transition.*")).toBe("transition.*");
  });

  it("leaves a plain identifier untouched", () => {
    expect(normalizeIdentifier("level")).toBe("level");
  });
});

describe("buildDial — typing + the override merge", () => {
  it("builds a bounded animatable float from melt's fields (source=melt)", () => {
    const { params } = parseMeltQuery(BRIGHTNESS_YAML);
    const level = params.find((p) => p.fields.identifier === "level");
    const dial = buildDial(level as never, undefined);
    expect(dial).toMatchObject({
      identifier: "level",
      kind: "float",
      min: 0,
      max: 15,
      animation: true,
      source: "melt",
    });
  });

  it("an override COMPLETES a one-sided melt range and stamps source=override", () => {
    const { params } = parseMeltQuery(BRIGHTNESS_YAML);
    const alpha = params.find((p) => p.fields.identifier === "alpha");
    const dial = buildDial(alpha as never, { max: 1, unit: "ratio" });
    expect(dial.min).toBe(-1); // melt-published floor preserved
    expect(dial.max).toBe(1); // override ceiling
    expect(dial.unit).toBe("ratio");
    expect(dial.source).toBe("override");
  });

  it("flags a deprecated param and cleans its leaked identifier", () => {
    const { params } = parseMeltQuery(BRIGHTNESS_YAML);
    const end = params.find((p) => p.fields.identifier === "end (*DEPRECATED*)");
    const dial = buildDial(end as never, undefined);
    expect(dial.identifier).toBe("end");
    expect(dial.deprecated).toBe(true);
  });

  it("an override `clearMax` drops a melt sentinel bound", () => {
    const { params } = parseMeltQuery(BRIGHTNESS_YAML);
    const level = params.find((p) => p.fields.identifier === "level");
    const dial = buildDial(level as never, { clearMax: true });
    expect(dial.max).toBeUndefined();
    expect(dial.min).toBe(0); // untouched
  });
});
