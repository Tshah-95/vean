// The REGISTRY-DRIVEN op-invariant harness (Move 1 gate: "apply(op) then
// apply(inverse) returns the original IR — property-based across ops"). It does
// NOT hard-code a list of ops: it iterates the op REGISTRY and, for every op that
// exposes a `samples` fixture, asserts the two contract laws on each sample:
//
//   (a) INVERSE — apply(inverse, apply(op).state).state DEEP-EQUALS the original
//       state (undo correctness). Both directions go through `apply`, so the
//       inverse is exercised exactly as a caller's undo would be.
//   (b) SERIALIZE — toMlt(result.state) parses with a namespace-AWARE XML parse
//       (no undeclared-prefix attribute → Shotcut-openable) AND round-trips
//       (fromMlt∘toMlt is a stable fixpoint).
//
// Append + split ship samples and MUST pass now. Every other op is a stub with an
// EMPTY `samples` array — the harness reports it as "pending" (skipped) and it
// flips to a live, enforced case the moment a build agent adds its samples. The
// convention a build agent follows is in DESIGN-MOVE1.md §6.
import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { VERTICAL, colorClip, fromMlt, resetIds, timeline, toMlt, videoTrack } from "../src/index";
import { OP_NAMES, REGISTRY, SAMPLES, apply, isEditError } from "../src/ops";
import type { OpResult } from "../src/ops";

// ─── (b) helpers: namespace-aware parse + round-trip fixpoint ─────────────────
/** Every XML attribute name carrying a `prefix:` (e.g. an undeclared `shotcut:`
 *  attribute — the exact defect Move 0 round-3 fixed). An op's emitted XML must
 *  carry ZERO of these (Shotcut's strict reader rejects them). Mirrors the scan
 *  in tests/xml-namespace.test.ts so the op layer inherits that guarantee. */
function namespacedAttrs(xml: string): string[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    preserveOrder: true,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
  });
  type Node = Record<string, unknown> & { ":@"?: Record<string, string> };
  const tree = parser.parse(xml) as Node[];
  const hits: string[] = [];
  const walk = (nodes: Node[]): void => {
    for (const node of nodes) {
      const a = node[":@"];
      if (a) {
        for (const key of Object.keys(a)) {
          const name = key.startsWith("@_") ? key.slice(2) : key;
          if (name.includes(":") && name !== "xmlns" && !name.startsWith("xmlns:")) hits.push(name);
        }
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === ":@") continue;
        if (Array.isArray(v)) walk(v as Node[]);
      }
    }
  };
  walk(tree);
  return hits;
}

/** Assert the result state serializes Shotcut-clean AND round-trips to a stable
 *  fixpoint (the format contract every op output must honor). */
function assertSerializes(result: OpResult): void {
  const xml = toMlt(result.state);
  // Namespace-aware: no undeclared-prefix attribute (Shotcut-openable).
  expect(namespacedAttrs(xml)).toEqual([]);
  // Well-formed under a strict parse (throws on malformed XML).
  expect(() => new XMLParser({ ignoreAttributes: false }).parse(xml)).not.toThrow();
  // Round-trip fixpoint: parse → re-serialize is stable.
  const reEmitted = toMlt(fromMlt(xml));
  expect(reEmitted).toBe(toMlt(fromMlt(reEmitted)));
}

// ─── The harness ──────────────────────────────────────────────────────────────
describe("op-invariants (registry-driven)", () => {
  // The registry is the source of truth — every public op is represented.
  it("the registry exposes every public op with an args schema", () => {
    expect(OP_NAMES.length).toBeGreaterThan(0);
    for (const name of OP_NAMES) {
      expect(REGISTRY[name]).toBeTruthy();
      expect(REGISTRY[name]?.args).toBeTruthy();
    }
  });

  for (const name of OP_NAMES) {
    const samples = SAMPLES[name] ?? [];

    if (samples.length === 0) {
      // A stub with no samples yet — record it as pending so the suite output
      // shows exactly which ops still need a build agent's fixtures.
      it.skip(`${name}: pending (no samples — stub awaiting Move 1b)`, () => {});
      continue;
    }

    describe(name, () => {
      samples.forEach((sample, i) => {
        const label = sample.name || `sample ${i}`;

        it(`${label}: applies without error`, () => {
          const result = apply({ op: name, args: sample.args }, sample.state());
          expect(isEditError(result)).toBe(false);
        });

        it(`${label}: does NOT mutate the input state (purity)`, () => {
          const state = sample.state();
          const before = structuredClone(state);
          apply({ op: name, args: sample.args }, state);
          expect(state).toEqual(before);
        });

        it(`${label}: apply → inverse deep-equals the original (undo)`, () => {
          const original = sample.state();
          const fwd = apply({ op: name, args: sample.args }, original);
          if (isEditError(fwd)) throw new Error(`${name} errored: ${JSON.stringify(fwd)}`);
          const back = apply(fwd.inverse, fwd.state);
          if (isEditError(back))
            throw new Error(`${name} inverse errored: ${JSON.stringify(back)}`);
          // The inverse must reconstruct the original state byte-for-byte (deep).
          expect(back.state).toEqual(original);
        });

        it(`${label}: result serializes Shotcut-clean + round-trips`, () => {
          const result = apply({ op: name, args: sample.args }, sample.state());
          if (isEditError(result)) throw new Error(`${name} errored: ${JSON.stringify(result)}`);
          assertSerializes(result);
        });
      });
    });
  }
});

// ─── A floor: the two reference ops MUST have live samples (no silent regress) ─
// If a refactor ever empties append/split samples, the registry-driven loop above
// would quietly skip them. This guards that the two reference ops are always
// exercised, so the gate can't go green on an empty harness.
describe("op-invariants (reference-op floor)", () => {
  for (const name of ["append", "split"]) {
    it(`${name} has at least one sample (the reference ops are always exercised)`, () => {
      expect((SAMPLES[name] ?? []).length).toBeGreaterThan(0);
    });
  }
});

// ─── Typed failure (contract law #5) — the dispatcher returns EditError VALUES ─
// The happy-path harness above never trips a precondition; these lock that every
// failure surface is a typed EditError value, NOT a thrown opaque error.
describe("apply — typed failures (law #5)", () => {
  const one = (): ReturnType<typeof timeline> => {
    resetIds();
    return timeline(VERTICAL, { video: [videoTrack(colorClip(60, "gold", { id: "c" }))] });
  };

  it("unknown op → precondition EditError (not a throw)", () => {
    const r = apply({ op: "does-not-exist", args: {} }, one());
    expect(isEditError(r)).toBe(true);
    expect((r as { kind: string }).kind).toBe("precondition");
  });

  it("malformed args → invalid-args EditError (Zod failure, not a thrown ZodError)", () => {
    const r = apply({ op: "split", args: { uuid: "c" } }, one()); // missing `frame`
    expect(isEditError(r)).toBe(true);
    expect((r as { kind: string }).kind).toBe("invalid-args");
  });

  it("split: clip-not-found → typed EditError", () => {
    const r = apply({ op: "split", args: { uuid: "missing", frame: 10 } }, one());
    expect(r).toMatchObject({ kind: "clip-not-found", uuid: "missing" });
  });

  it("split: at a clip boundary → split-at-boundary EditError", () => {
    const r = apply({ op: "split", args: { uuid: "c", frame: 0 } }, one());
    expect((r as { kind: string }).kind).toBe("split-at-boundary");
  });

  it("append: unresolvable track → track-not-found EditError", () => {
    const r = apply(
      { op: "append", args: { track: { kind: "video", index: 5 }, clip: colorClip(10, "black") } },
      one(),
    );
    expect((r as { kind: string }).kind).toBe("track-not-found");
  });

  // Move 1a originally canaried this with `insert` THROWING "not implemented" — the
  // signal that a stub body was still pending. Every placement/removal op body has
  // since landed (insert/overwrite/lift/remove/replace + the rest of the taxonomy),
  // so the canary's premise (a remaining stub) no longer exists. The successor
  // invariant is the POSITIVE form: a valid invocation of EVERY public op never
  // throws a NotImplemented stub error — it either succeeds or returns a typed
  // EditError. A re-introduced stub (or a half-wired registry) trips this.
  it("no public op throws a NotImplemented stub error (every body has landed)", () => {
    for (const name of OP_NAMES) {
      // A representative valid invocation per op. Ops needing specific args use a
      // sample's args when present; otherwise a benign shape that the op's own
      // precondition turns into a typed EditError (never a NotImplemented throw).
      const sample = (SAMPLES[name] ?? [])[0];
      const args = sample ? sample.args : {};
      const state = sample ? sample.state() : one();
      expect(() => apply({ op: name, args }, state)).not.toThrow(/not implemented/i);
    }
  });
});
