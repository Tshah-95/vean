// Pure composition-resolution helpers — the glob → registry logic, factored out of
// `registry.ts` so it is unit-testable WITHOUT Vite's `import.meta.glob` transform or a
// React/Remotion runtime. `registry.ts` runs the eager glob and hands each module here.
//
// CONVENTION for a comp file `remotion/src/compositions/<Id>.tsx`:
//   • the COMPOSITION ID is the filename (`LowerThird.tsx` → "LowerThird"), matching the
//     producer's `<Composition id=…>` and the IR `composition.id`.
//   • the COMPONENT is the module's `default` export (preferred), OR — for a
//     pre-convention comp — a named export matching the id (`export const LowerThird`).
//   • the DEFAULT PROPS are the module's `defaults` export (preferred), OR the legacy
//     `<camelCaseId>Defaults` (`lowerThirdDefaults`), OR `{}` when neither exists.
//
// The two fallbacks are what let an existing comp (LowerThird) resolve with no edit
// while new comps use the clean `export default` + `export const defaults` shape.

/** A comp `.tsx` module's exports — shape unknown until resolved by the convention. */
export type CompModule = Record<string, unknown>;

/** The filename (no dir, no extension) of a module path == the composition id.
 *  `".../compositions/LowerThird.tsx"` → `"LowerThird"`. */
export function idFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.[jt]sx?$/, "");
}

/** The legacy `<camelCaseId>Defaults` export name for an id
 *  (`"LowerThird"` → `"lowerThirdDefaults"`), so a pre-convention comp resolves
 *  without an edit. */
export function legacyDefaultsName(id: string): string {
  return `${id.charAt(0).toLowerCase()}${id.slice(1)}Defaults`;
}

/** Resolve a comp module to its `{ component, defaults }` under the convention, or
 *  `null` when the module exposes no component for this id (a helper `.tsx`, not a
 *  composition — skip it rather than register a broken entry). A component is a
 *  function (FC) or an object (`memo`/`forwardRef`); anything else is not one. */
export function pickComposition(
  id: string,
  mod: CompModule,
): { component: unknown; defaults: Record<string, unknown> } | null {
  const component = mod.default ?? mod[id];
  if (component == null || (typeof component !== "function" && typeof component !== "object")) {
    return null;
  }
  const defaults =
    (mod.defaults as Record<string, unknown> | undefined) ??
    (mod[legacyDefaultsName(id)] as Record<string, unknown> | undefined) ??
    {};
  return { component, defaults };
}
