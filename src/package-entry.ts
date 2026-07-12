// This is the only compiled-product entry. The mode is fixed before the CLI
// module graph evaluates and cannot be selected by process environment.
globalThis.__VEAN_PACKAGE_MODE__ = true;
await import("./cli");
export {};
