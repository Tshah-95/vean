// The viewer's COMPOSITION REGISTRY — the live-preview mirror of the Remotion
// workspace's `registerRoot`/`<Composition>` registry (`remotion/src/Root.tsx`).
//
// WHY THIS EXISTS (the bug it closes)
//   The live `@remotion/player` overlay (`OverlayPlayer.tsx`) used to HARDCODE the
//   `LowerThird` component for EVERY graphic clip, regardless of which composition
//   the clip actually referenced. So a timeline whose overlay is a different comp
//   (or the same comp with different props) previewed as the wrong graphic. The
//   producer path (`vean remotion render <CompositionId> …`) renders the REAL comp
//   by id; the live path must do the same to stay the "two compositing paths of ONE
//   composition" the Remotion seam promises (live preview ≈ export, not a stand-in).
//
//   A clip names its composition via the IR `composition` field (`{ id, props }`),
//   which round-trips through the `vean:composition` / `vean:compositionProps`
//   producer properties (`src/ir/{serialize,parse}.ts`). The viewer reads that off
//   the GRAPHIC clip (App `deriveOverlay`) and resolves the component + its defaults
//   HERE, by id. New compositions are added in ONE place — the same `@remotion-comp`
//   source the producer renders — so the live and export registries never drift.
//
// IDENTICAL SOURCE, ONE COPY
//   The components are imported from the SIBLING `remotion/` workspace via the
//   `@remotion-comp` Vite alias (vite.config.ts) + the `dedupe` of remotion/react —
//   the exact same module the producer renders to ProRes. There is no second
//   implementation to keep in sync; this file is purely the id → component map.
import { LowerThird, lowerThirdDefaults } from "@remotion-comp/LowerThird";

/** A registered composition: the React component the `<Player>` mounts plus the
 *  default props it renders with when a graphic clip names this id but carries no
 *  (or partial) props. Mirrors a `<Composition>` entry in `remotion/src/Root.tsx`. */
export interface RegisteredComposition {
  component: React.ComponentType<Record<string, unknown>>;
  defaults: Record<string, unknown>;
}

/** The id → composition map. Keys MUST match the `<Composition id=…>` ids the
 *  Remotion `Root.tsx` registers (and the `vean:composition` ids the producer
 *  stamps), so a clip authored against the producer resolves the same component
 *  in live preview. Add a composition in BOTH places (here + Root.tsx) — the
 *  producer and the live player are the two compositing paths of one comp. */
export const COMPOSITIONS: Record<string, RegisteredComposition> = {
  LowerThird: {
    component: LowerThird as React.ComponentType<Record<string, unknown>>,
    defaults: lowerThirdDefaults as Record<string, unknown>,
  },
};

/** The fallback composition id — used when a graphic clip carries no `composition`
 *  metadata (the legacy label-/cache-path-only overlays that predate the IR field).
 *  These previewed as `LowerThird` historically, so keep that behaviour for them. */
export const DEFAULT_COMPOSITION_ID = "LowerThird";

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
  const resolvedId = id && COMPOSITIONS[id] ? id : DEFAULT_COMPOSITION_ID;
  const entry = COMPOSITIONS[resolvedId] ?? COMPOSITIONS[DEFAULT_COMPOSITION_ID];
  if (!entry) {
    // Unreachable (the default is always registered) — narrow for the type checker.
    throw new Error(`no composition registered for "${resolvedId}" or the default`);
  }
  return { id: resolvedId, component: entry.component, defaults: entry.defaults };
}
