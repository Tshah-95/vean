import type { Options } from "@wdio/types";
import { readContext } from "./e2e/tauri/runtime";

const context = readContext();

export const config: Options.Testrunner = {
  runner: "local",
  specs: ["./e2e/tauri/editor.spec.ts"],
  maxInstances: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        driverProvider: "embedded",
        appBinaryPath: context.binaryPath,
        embeddedPort: context.webdriverPort,
        windowLabel: "main",
        startTimeout: 90_000,
        statusPollTimeout: 5_000,
        captureBackendLogs: true,
        captureFrontendLogs: false,
        env: {
          HOME: process.env.VEAN_H05_HOME as string,
          VEAN_CONFIG_HOME: process.env.VEAN_H05_CONFIG_HOME as string,
          VEAN_REPO: context.repo,
          VEAN_BIN: "bun",
          VEAN_PREVIEW_MODE: "prod",
          VEAN_HARNESS_WDIO: "1",
          VEAN_HARNESS_PREVIEW_PORT: String(context.previewPort),
          VEAN_PROCESS_MARKER: `vean-h05-${context.runId}`,
        },
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: context.binaryPath },
    },
  ],
  logLevel: "info",
  bail: 1,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 1,
  ...(process.env.VEAN_H05_SIMULATE_SESSION_FAILURE === "1"
    ? {
        transformRequest: () => {
          throw new Error("SYNTHETIC_SESSION_CREATION_FAILURE");
        },
      }
    : {}),
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 120_000 },
};
