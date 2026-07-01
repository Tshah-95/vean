# no-project-comps

The **empty fallback** for the `@project-comp` Vite alias.

When the preview server launches Vite for a specific project it points
`@project-comp` at that project's `remotion/src/compositions` dir (via the
`VEAN_PROJECT_COMPS_DIR` env var), so the viewer discovers the project's own
Remotion comps live (see `viewer/vite.config.ts` + `viewer/src/remotion/registry.ts`).

When there is no project (a bare `bun run viewer:dev`), the alias points here
instead — a real directory with **no `*.tsx`** — so the `@project-comp/*.tsx` glob
resolves to nothing rather than erroring on an unresolvable alias.

Do not add compositions here; add them to a project's `remotion/src/compositions/`.
