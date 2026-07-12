import type { RuntimeMode } from "./layout-schema";

declare global {
  var __VEAN_PACKAGE_MODE__: boolean | undefined;
}

/** Fixed to `package` by `bun build --define`; source executions remain dev. */
export function compiledRuntimeMode(): RuntimeMode {
  return globalThis.__VEAN_PACKAGE_MODE__ === true ? "package" : "development";
}
