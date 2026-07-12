import type { RuntimeMode } from "./layout-schema";

declare const __VEAN_PACKAGE_MODE__: boolean | undefined;

/** Fixed to `package` by `bun build --define`; source executions remain dev. */
export function compiledRuntimeMode(): RuntimeMode {
  return typeof __VEAN_PACKAGE_MODE__ !== "undefined" && __VEAN_PACKAGE_MODE__
    ? "package"
    : "development";
}
