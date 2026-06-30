#!/usr/bin/env bun
// `bun run dials:generate` — regenerate the static dials catalog from `melt
// -query` + the override table, writing `src/ir/dials/catalog.ts`. This is the
// ONLY entry point that runs melt for the dials module; the pure engine reads the
// committed catalog with no subprocess (Hard boundary #3). Re-run after an MLT
// upgrade or an override-table change, then commit the regenerated catalog.
import { resolve } from "node:path";
import { generateCatalog, renderCatalogModule } from "@/ir/dials/generate";

const out = resolve(import.meta.dir, "../src/ir/dials/catalog.ts");
const catalog = generateCatalog();
const module = renderCatalogModule(catalog);
await Bun.write(out, module);

const services = Object.keys(catalog);
const dials = services.reduce((n, s) => n + (catalog[s]?.dials.length ?? 0), 0);
console.log(`dials:generate → ${out}`);
console.log(`  ${services.length} services, ${dials} dials: ${services.join(", ")}`);
