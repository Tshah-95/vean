import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The viewer is a standalone web app (its OWN package.json). It composites a
// footage-proxy <video> under an @remotion/player overlay, both slaved to one
// master clock. The Remotion demo composition lives in the SIBLING `remotion/`
// workspace; we alias into its source so the Player renders the exact same
// component the producer renders to ProRes — one composition, two compositing
// paths (live preview ≠ bit-exact export, the accepted Remotion-seam cost).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/",
  resolve: {
    alias: {
      // `@/*` → viewer source (shadcn convention; used by the token layer + shell).
      "@": resolve(__dirname, "src"),
      // Reuse the producer's compositions from the sibling workspace by source.
      "@remotion-comp": resolve(__dirname, "..", "remotion", "src", "compositions"),
      // PER-PROJECT comps: the ACTIVE project's own `remotion/src/compositions` dir,
      // passed by the preview server via VEAN_PROJECT_COMPS_DIR when it launches Vite
      // for a project — so `vean open <project>` renders THAT project's comps live
      // (e.g. retire's ChatRetire), not just the shared workspace's. Absent (a bare
      // `bun run viewer:dev`) it points at a real EMPTY dir, so the project glob
      // resolves to nothing rather than erroring.
      "@project-comp":
        process.env.VEAN_PROJECT_COMPS_DIR ??
        resolve(__dirname, "src", "remotion", "no-project-comps"),
    },
    // The aliased composition lives under the sibling `remotion/` workspace, whose
    // bare `import "remotion"` (and React) would otherwise resolve to THAT
    // workspace's own node_modules — a SECOND copy of remotion/react distinct from
    // the one `@remotion/player` uses here. Two remotion instances ⇒ the Player's
    // frame context and the composition's `useCurrentFrame`/`spring` read DIFFERENT
    // contexts, so the hooks throw and the Player paints its default ⚠️ fallback.
    // Force a single copy of each so the overlay actually renders.
    dedupe: ["remotion", "@remotion/player", "react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    // The vean preview server reverse-proxies non-/api routes to this dev server.
    // When it auto-starts us (the default dev path) it assigns a free ephemeral
    // port via `VEAN_VIEWER_PORT` and we MUST bind exactly that (strictPort) so the
    // proxy finds us. `server.hmr.clientPort` then points the browser's HMR socket
    // straight at this port: the page is served through the proxy on a DIFFERENT
    // port and Vite's ws is not proxied, so the standard "Vite behind a proxy"
    // config is required for edits to live-push. Absent the env (a hand-started
    // `bun run viewer:dev`) we fall back to the historical 5175 (= 5174 + 1).
    ...(process.env.VEAN_VIEWER_PORT
      ? (() => {
          const port = Number(process.env.VEAN_VIEWER_PORT);
          return { port, strictPort: true, hmr: { host: "127.0.0.1", clientPort: port } };
        })()
      : { port: 5175, strictPort: false }),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
