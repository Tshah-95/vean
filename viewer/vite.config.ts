import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The viewer is a standalone web app (its OWN package.json). It composites a
// footage-proxy <video> under an @remotion/player overlay, both slaved to one
// master clock. The Remotion demo composition lives in the SIBLING `remotion/`
// workspace; we alias into its source so the Player renders the exact same
// component the producer renders to ProRes — one composition, two compositing
// paths (live preview ≠ bit-exact export, the accepted Remotion-seam cost).
export default defineConfig({
  plugins: [react()],
  base: "/",
  resolve: {
    alias: {
      // Reuse the producer's compositions from the sibling workspace by source.
      "@remotion-comp": resolve(__dirname, "..", "remotion", "src", "compositions"),
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
    // The dev server runs on port+1; the vean preview server (port) reverse-
    // proxies non-/api routes to it. Default 5175 = 5174 + 1.
    port: 5175,
    strictPort: false,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
