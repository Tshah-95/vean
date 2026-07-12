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

/** The SCENE-TAKE id for a NESTED comp file `…/compositions/<Scene>/<Take>.tsx` →
 *  `"<Scene>-<Take>"`. This is the takes convention a project's producer registers
 *  (`<Composition id={`${scene.comp}-${take.id}`}>` — see a project's
 *  remotion/src/Root.tsx): scene folders hold take variants (`S03ChatbotFail/B.tsx`
 *  → "S03ChatbotFail-B"), so the live registry discovers every take the producer
 *  registers. Returns null for a path without both segments. */
export function sceneTakeIdFromPath(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/");
  const file = parts.pop();
  const scene = parts.pop();
  if (!file || !scene) return null;
  return `${scene}-${file.replace(/\.[jt]sx?$/, "")}`;
}

/** The scene DIRECTORY name of a nested comp-module path
 *  (`…/compositions/<Scene>/index.ts` → `"<Scene>"`). */
export function sceneDirFromPath(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/");
  parts.pop(); // the file
  return parts.pop() ?? null;
}

/** Extract a scene module's take registry — the `VARIANTS: [{ id, component }]`
 *  export a scene's `index.ts` maintains (the same registry the producer's Root.tsx
 *  flatMaps into `<Composition id={`${scene}-${take.id}`}>`). Entries without a
 *  string id or a real component are skipped; a module without a well-formed
 *  VARIANTS array yields `[]`. */
export function takesFromSceneModule(mod: CompModule): Array<{ id: string; component: unknown }> {
  const variants = mod.VARIANTS;
  if (!Array.isArray(variants)) return [];
  const out: Array<{ id: string; component: unknown }> = [];
  for (const v of variants) {
    if (typeof v !== "object" || v === null) continue;
    const { id, component } = v as { id?: unknown; component?: unknown };
    const isComponent =
      typeof component === "function" ||
      (typeof component === "object" && component !== null && "$$typeof" in component);
    if (typeof id === "string" && id && isComponent) out.push({ id, component });
  }
  return out;
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
  const component =
    mod.default ??
    mod[id] ??
    // Takes shape (nested `<Scene>/<Take>.tsx`, id "<Scene>-<Take>"): the take file
    // names its export `<Scene><Take>` (S03ChatbotFail/B.tsx → S03ChatbotFailB); the
    // placeholder take (P.tsx) exports just `<Scene>` (S03ChatbotFail).
    mod[id.replace(/-/g, "")] ??
    (id.includes("-") ? mod[id.slice(0, id.indexOf("-"))] : undefined);
  // A React component is a function (FC) or an EXOTIC object carrying a React marker
  // (`$$typeof` — memo / forwardRef / lazy). A plain object (`export default { … }`, or
  // a helper `.tsx` mistakenly in the dir) is NOT a component — reject it rather than
  // register a bogus entry that only fails later at Player mount.
  const isComponent =
    typeof component === "function" ||
    (typeof component === "object" && component !== null && "$$typeof" in component);
  if (!isComponent) return null;
  const defaults =
    (mod.defaults as Record<string, unknown> | undefined) ??
    (mod[legacyDefaultsName(id)] as Record<string, unknown> | undefined) ??
    {};
  return { component, defaults };
}
