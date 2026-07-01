// The viewer's COMPOSITION REGISTRY — the live-preview mirror of the Remotion
// workspace's `registerRoot`/`<Composition>` registry (`remotion/src/Root.tsx`).
//
// WHY THIS EXISTS (the bug it closes)
//   The live `@remotion/player` overlay (`OverlayPlayer.tsx`) resolves the ACTUAL
//   composition a graphic clip names (its IR `composition.id`) to a React component,
//   so live preview renders the same comp the producer bakes to ProRes — the "two
//   compositing paths of ONE composition" the Remotion seam promises. A clip names its
//   composition via the IR `composition` field (`{ id, props }`), round-tripped through
//   the `vean:composition` / `vean:compositionProps` producer properties.
//
// DYNAMIC (P0 — live-comp-preview): the registry is no longer a hand-maintained const.
//   Every comp in the sibling workspace's `compositions/` dir is discovered at
//   build/dev time by an EAGER Vite glob, so `resolveComposition` stays SYNCHRONOUS
//   (async/lazy loading is P1). Adding a comp is enough — drop `remotion/src/
//   compositions/<Id>.tsx` and it resolves by id, with HMR (Vite watches the glob), and
//   NO edit here. `@remotion-comp` is the vite.config alias to `remotion/src/
//   compositions`; remotion/react are DEDUPED there (a second copy breaks the Player's
//   frame context — see vite.config.ts). The module → `{component, defaults}` mapping
//   is the pure `./resolve` helper (unit-tested without the glob).
import { type CompModule, idFromPath, pickComposition } from "./resolve";

/** A registered composition: the React component the `<Player>` mounts plus the
 *  default props it renders with when a graphic clip names this id but carries no
 *  (or partial) props. Mirrors a `<Composition>` entry in `remotion/src/Root.tsx`. */
export interface RegisteredComposition {
  component: React.ComponentType<Record<string, unknown>>;
  defaults: Record<string, unknown>;
}

// Eager so the map is built synchronously at module load (resolveComposition stays
// sync; OverlayPlayer resolves in a useMemo). A project has a handful of comps, so the
// upfront cost is negligible; per-comp lazy loading is a P1 optimization.
const workspaceModules = import.meta.glob<CompModule>("@remotion-comp/*.tsx", { eager: true });
// PER-PROJECT comps: the ACTIVE project's OWN `remotion/src/compositions` dir, aliased
// to `@project-comp` (the preview server sets VEAN_PROJECT_COMPS_DIR when it launches
// Vite for a project; an empty dir otherwise). So `vean open retire` discovers retire's
// ChatRetire alongside the shared workspace comps — no registry edit, no copy into the
// shared dir. A project comp SHADOWS a workspace comp of the same id (registered LAST),
// so a project can override a shared comp with its own.
const projectModules = import.meta.glob<CompModule>("@project-comp/*.tsx", { eager: true });

/** The id → composition map, discovered from the globs. Keys are the comp filenames
 *  (== the `<Composition id=…>` ids the producer stamps), so a clip authored against
 *  the producer resolves the same component in live preview — no drift, no dual list. */
export const COMPOSITIONS: Record<string, RegisteredComposition> = {};
for (const [path, mod] of [
  ...Object.entries(workspaceModules),
  ...Object.entries(projectModules),
]) {
  const id = idFromPath(path);
  const picked = pickComposition(id, mod);
  if (picked) {
    COMPOSITIONS[id] = {
      component: picked.component as React.ComponentType<Record<string, unknown>>,
      defaults: picked.defaults,
    };
  }
}

/** The fallback composition id — used when a graphic clip carries no `composition`
 *  metadata (the legacy label-/cache-path-only overlays that predate the IR field).
 *  These previewed as `LowerThird` historically, so keep that behaviour for them. */
export const DEFAULT_COMPOSITION_ID = "LowerThird";

// Headless bridge: the ids the dynamic registry discovered from the glob. Lets the
// `verify:live-comp` drive gate assert a NEW comp (e.g. `Title`) was picked up WITHOUT
// a registration edit here — the P0 proof. Browser-only (the glob never runs elsewhere).
if (typeof window !== "undefined") {
  (window as unknown as { __veanCompositions?: () => string[] }).__veanCompositions = () =>
    Object.keys(COMPOSITIONS);
}

/** Resolve a composition by id to its component + default props. Falls back to the
 *  default composition when the id is unknown or absent, so the live player NEVER
 *  fails to mount a graphic clip (an unknown id previews as the default rather than
 *  a blank/❌ frame). Returns the resolved id alongside, so the caller/bridge can
 *  report which composition actually rendered. */
export function resolveComposition(id: string | undefined): {
  id: string;
  component: React.ComponentType<Record<string, unknown>>;
  defaults: Record<string, unknown>;
} {
  // Prefer the requested id, then the default, then ANY registered comp — so the live
  // player never fails to mount even if `LowerThird` was renamed/removed (the default
  // is an assumption, not an invariant). Only throw if the glob found NOTHING.
  const resolvedId =
    (id && COMPOSITIONS[id] && id) ||
    (COMPOSITIONS[DEFAULT_COMPOSITION_ID] && DEFAULT_COMPOSITION_ID) ||
    Object.keys(COMPOSITIONS)[0];
  const entry = resolvedId ? COMPOSITIONS[resolvedId] : undefined;
  if (!resolvedId || !entry) {
    throw new Error(`no compositions registered — the glob found none (cannot resolve "${id ?? "?"}")`);
  }
  return { id: resolvedId, component: entry.component, defaults: entry.defaults };
}
