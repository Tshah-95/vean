// The dials module barrel — the typed dial catalog (knob schemas for MLT
// filters/transitions, generated from `melt -query` + curated overrides) and its
// pure read/range-check API. The generator (`./generate`, a subprocess tool) is
// intentionally NOT re-exported here: the pure engine imports only the static
// catalog + lookup, never the melt-running generator (Hard boundary #3).
export type {
  Dial,
  DialCatalog,
  DialKind,
  DialOption,
  DialService,
  DialUnit,
  ServiceKind,
} from "./types";
export {
  dial,
  dialCatalog,
  dialService,
} from "./types";
export { DIAL_CATALOG } from "./catalog";
export {
  type RangeVerdict,
  catalog,
  checkScalar,
  getDial,
  getService,
  isScalarDial,
} from "./lookup";
