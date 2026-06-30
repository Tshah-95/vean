// The dials-catalog ACCESSOR — the pure read API over the static `./catalog` the
// dial-range diagnostic and a future UI use. No subprocess, no I/O: it only
// indexes the committed `DIAL_CATALOG` constant (Hard boundary #3). The diagnostic
// asks "is value V in range for dial D of service S?"; this module answers from the
// typed schema alone.
import { DIAL_CATALOG } from "./catalog";
import type { Dial, DialService } from "./types";

/** The catalog, exposed read-only for callers that want to enumerate services
 *  (a UI, a `vean dials list`). Same object the diagnostic indexes. */
export const catalog = DIAL_CATALOG;

/** The dial schema for a service by its MLT identifier (the `mlt_service` /
 *  filter `service` value), or `undefined` when the service is not catalogued.
 *  An un-catalogued service is NOT an error — the dial check simply skips it (the
 *  catalog is a curated subset, and a value on an unknown knob has no bound to
 *  violate), preserving the zero-false-positive bar. */
export function getService(serviceId: string): DialService | undefined {
  return DIAL_CATALOG[serviceId];
}

/** One dial's schema within a service, by both identifiers, or `undefined` when
 *  either the service or the dial is not catalogued. */
export function getDial(serviceId: string, dialId: string): Dial | undefined {
  const svc = DIAL_CATALOG[serviceId];
  if (!svc) return undefined;
  return svc.dials.find((d) => d.identifier === dialId);
}

// ─── Range checking ───────────────────────────────────────────────────────────
/** The verdict of bounds-checking ONE scalar against a dial. `ok` = within bounds
 *  (or no applicable bound); otherwise `bound` names which side was exceeded and
 *  `limit` is the violated value, ready for a precise diagnostic message. */
export type RangeVerdict =
  | { ok: true }
  | { ok: false; bound: "min" | "max"; limit: number; value: number };

/** Check a single numeric `value` against a dial's `[min,max]`. A dial with an
 *  ABSENT bound on a side imposes no limit there — so a one-sided dial only fires
 *  on the side it bounds, and a fully-unbounded dial never fires (the catalog's
 *  zero-false-positive contract: absent bound = "no limit", never `0`). A
 *  non-numeric value (a string/color/rect dial) is not range-checked here — the
 *  caller resolves only `float`/`integer` dials to a scalar before calling. */
export function checkScalar(dial: Dial, value: number): RangeVerdict {
  if (!Number.isFinite(value)) return { ok: true };
  if (dial.min != null && value < dial.min) {
    return { ok: false, bound: "min", limit: dial.min, value };
  }
  if (dial.max != null && value > dial.max) {
    return { ok: false, bound: "max", limit: dial.max, value };
  }
  return { ok: true };
}

/** True iff a dial is a numeric scalar the range check applies to. `string`,
 *  `color`, `rect`, `geometry`, and `properties` dials are not scalar-bounded
 *  (their structure/units aren't a single number); `boolean` is 0/1 and its own
 *  check, so it's excluded from the float/integer range path too. */
export function isScalarDial(dial: Dial): boolean {
  return dial.kind === "float" || dial.kind === "integer";
}
