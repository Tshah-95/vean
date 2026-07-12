# Packaged runtime contract

The packaged Vean runtime is a closed, immutable resource tree described by
`runtime-layout.json` (`vean.runtime-layout/1`) and an embedded
`runtime-manifest.json`. The project root is the only writable application
root. Package and project roots are separate; package mode has no development
checkout root.

Rust selects package mode with the `package-runtime` Cargo feature. The compiled
Bun core is built with package mode fixed and receives the absolute layout path
through `vean-core preview --no-open --prod --runtime-layout <path>`. A mode
mismatch fails with `E_RUNTIME_MODE_MISMATCH` before a listener or child exists.

Every package resource is classified and hashed. Resolution is component-wise,
rejects traversal, links, non-regular files, external hard links, wrong modes,
and byte/identity changes. Package child environments discard user renderer,
runtime, loader, proxy, download, and package-manager variables and populate
renderer variables only from verified package resources. Development mode keeps
the documented source-checkout overrides.

The package inventory covers the compiled core, viewer, migrations, skills,
renderer closure, Node/Remotion/browser closure, built-in composition, and
compliance payload. New package-reachable path discovery must be explicitly
classified in `tests/runtime-layout-ratchet.test.ts`.

