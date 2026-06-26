import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VEAN_FIXTURES } from "../corpus/vean-fixtures";
import { fromMlt } from "../src/ir/parse";
import { toMlt } from "../src/ir/serialize";

// The corpus golden — DETERMINISM is a hard requirement, and the committed
// `vean-*.mlt` corpus files are the known-good serializer output. This guards two
// things at once:
//
//   1. The same IR serializes to BYTE-IDENTICAL XML every time (determinism).
//   2. The committed corpus file on disk still equals that deterministic output
//      (the corpus hasn't silently drifted from the serializer).
//
// If a serializer change is intentional, re-bless with `bun corpus/build-vean.ts`
// and this test goes green again on the new bytes. If it's accidental, this is
// where it's caught — before the round-trip / render gates spend a melt run.
const CORPUS = join(import.meta.dirname, "..", "corpus");

describe("corpus golden — vean emissions are deterministic + committed in sync", () => {
  for (const [name, make] of Object.entries(VEAN_FIXTURES)) {
    describe(name, () => {
      it("serializes byte-identically on repeat (no hidden state)", () => {
        expect(toMlt(make())).toBe(toMlt(make()));
      });

      it("the committed .mlt equals the fixture's deterministic serialization", () => {
        const onDisk = readFileSync(join(CORPUS, name), "utf8");
        expect(toMlt(make())).toBe(onDisk);
      });

      it("round-trips byte-identically through parse → serialize", () => {
        const emitted = toMlt(make());
        // vean's own output is the strong contract: parse then re-serialize must
        // reproduce it exactly (not just reach a stable fixpoint).
        expect(toMlt(fromMlt(emitted))).toBe(emitted);
      });
    });
  }
});
