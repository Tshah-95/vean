#!/usr/bin/env bun
// refs — the findReferences CLI ("find all references" from the shell). Given a
// source path, a property name, or a clip uuid, list everything that refers to it.
//
//   bun run refs <file.mlt> <query-json>
//
// where <query-json> is one of the ReferenceQuery shapes (src/query/references):
//   • source:   {"kind":"source","resource":"/abs/clip.mp4"}
//   • property: {"kind":"property","property":"level"}
//   • clip:     {"kind":"clip","clip":"<uuid>","ripple":true}
//
// Prints the located sites: clips using a source, readers/writers of a property
// (with the animated flag), or a clip's adjacency/ripple set (what moves if it
// moves). The Move-1b CLI-phase stub over the finished, pure query (`src/query`);
// Move 2's bridge wraps the same call. A DEBUG/inspection verb, not an agent loop.
import { fromMlt } from "../src/ir/parse";
import { type ReferenceQuery, findReferences } from "../src/query/references";

const USAGE = "usage: bun run refs <file.mlt> <query-json>";

async function main(): Promise<void> {
  const [, , file, queryJson] = process.argv;
  if (!file || !queryJson) {
    console.error(USAGE);
    process.exit(2);
  }
  let query: ReferenceQuery;
  try {
    query = JSON.parse(queryJson) as ReferenceQuery;
  } catch (err) {
    console.error(
      `refs: <query-json> is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
    process.exit(2);
    return;
  }

  const xml = await Bun.file(file).text();
  const state = fromMlt(xml);
  const r = findReferences(state, query);

  if (r.kind === "source") {
    console.log(`refs: clips using source "${r.resource}" — ${r.clips.length} found`);
    for (const c of r.clips) {
      console.log(`  clip ${c.uuid} @ ${c.track}:${c.position} (${c.playtime}f)`);
    }
  } else if (r.kind === "property") {
    console.log(`refs: readers/writers of property "${r.property}" — ${r.sites.length} found`);
    for (const s of r.sites) {
      const owner =
        s.owner.kind === "clip-filter"
          ? `clip ${s.owner.clip} filter ${s.owner.service} (track ${s.owner.track})`
          : `transition #${s.owner.index} (${s.owner.service})`;
      console.log(`  ${owner}  = ${JSON.stringify(s.value)}${s.animated ? "  [animated]" : ""}`);
    }
  } else {
    if (r.notFound) {
      console.error(`refs: ${r.notFound}`);
      process.exit(1);
    }
    console.log(`refs: adjacency/ripple set for clip "${r.clip}" — ${r.affected.length} affected`);
    if (r.site) console.log(`  (clip @ ${r.site.track}:${r.site.position}, ${r.site.playtime}f)`);
    for (const a of r.affected) {
      console.log(`  ${a.relation.padEnd(18)} clip ${a.uuid} @ ${a.track}:${a.position}`);
    }
  }
  process.exit(0);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
