#!/usr/bin/env bun
// (Re)generate the `vean-*.mlt` corpus files from their IR fixtures. Run after a
// deliberate serializer change to re-bless the committed corpus, then re-run the
// corpus gate (`bun run verify:corpus`) and the golden test (`bun run test`) to
// confirm they still round-trip byte-identically and render faithfully.
//
//   bun corpus/build-vean.ts
//
// The fixtures (corpus/vean-fixtures.ts) are the single source of truth for what
// these files contain; this script only serializes them to disk.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { toMlt } from "../src/ir/serialize";
import { VEAN_FIXTURES } from "./vean-fixtures";

const DIR = import.meta.dirname;
for (const [name, make] of Object.entries(VEAN_FIXTURES)) {
  const xml = toMlt(make());
  const path = join(DIR, name);
  writeFileSync(path, xml);
  console.log(`wrote ${name} (${xml.length} bytes)`);
}
