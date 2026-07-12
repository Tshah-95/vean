import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import { mergeConfig } from "vite";
import { type Plugin, defineConfig } from "vitest/config";
import viewerConfig from "./vite.config";

const port = Number(process.env.VEAN_COMPONENT_PORT ?? 63315);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("VEAN_COMPONENT_PORT must be an unprivileged integer TCP port");
}

const invocationPath = resolve("test-results/component-browser/invocation.json");
const parityPath = resolve("test-results/component-browser/parity.json");
rmSync(invocationPath, { force: true });
rmSync(parityPath, { force: true });

function invocationRecorder(): Plugin {
  return {
    name: "vean-component-invocation-recorder",
    configureServer(server) {
      server.middlewares.use("/__vean_component_invocation", (request, response) => {
        if (
          request.method !== "POST" ||
          request.headers.host !== `127.0.0.1:${port}` ||
          request.headers["content-type"] !== "application/json"
        ) {
          response.statusCode = 403;
          response.end("forbidden");
          return;
        }
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
          if (body.length > 16_384) request.destroy();
        });
        request.on("end", () => {
          const value = JSON.parse(body) as {
            scenarioId?: unknown;
            actionId?: unknown;
            route?: unknown;
            invocation?: { op?: unknown; args?: Record<string, unknown> };
          };
          const args = value.invocation?.args;
          const toTrack = args?.toTrack as { trackId?: unknown } | undefined;
          if (
            value.scenarioId !== "a11y.timeline.document-truth" ||
            value.actionId !== "move" ||
            value.route !== "timeline:fixture" ||
            value.invocation?.op !== "move" ||
            args?.uuid !== "{7c1a0e2a-0001-4abc-9d00-000000000001}" ||
            toTrack?.trackId !== "playlist0" ||
            !Number.isInteger(args?.toPosition) ||
            typeof args?.ripple !== "boolean" ||
            typeof args?.rippleAllTracks !== "boolean"
          ) {
            response.statusCode = 422;
            response.end("invalid invocation envelope");
            return;
          }
          mkdirSync(dirname(invocationPath), { recursive: true });
          writeFileSync(invocationPath, `${body}\n`, { mode: 0o600 });
          response.statusCode = 204;
          response.end();
        });
      });
      server.middlewares.use("/__vean_component_parity", (request, response) => {
        if (
          request.method !== "POST" ||
          request.headers.host !== `127.0.0.1:${port}` ||
          request.headers["content-type"] !== "application/json"
        ) {
          response.statusCode = 403;
          response.end("forbidden");
          return;
        }
        let body = "";
        request.on("data", (chunk) => {
          body += String(chunk);
          if (body.length > 32_768) request.destroy();
        });
        request.on("end", () => {
          const value = JSON.parse(body) as {
            scenarioId?: unknown;
            invocations?: Array<{ op?: unknown; args?: Record<string, unknown> }>;
          };
          const expectedOps = ["move", "slip", "slide", "trimIn", "trimOut", "roll", "move"];
          if (
            value.scenarioId !== "a11y.timeline.pointer-keyboard-parity" ||
            value.invocations?.length !== expectedOps.length ||
            value.invocations.some((invocation, index) => invocation.op !== expectedOps[index]) ||
            value.invocations.some((invocation) => {
              const args = invocation.args;
              return (
                !args ||
                (args.uuid !== undefined &&
                  args.uuid !== "{7c1a0e2a-0001-4abc-9d00-000000000001}") ||
                (args.leftUuid !== undefined &&
                  args.leftUuid !== "{7c1a0e2a-0001-4abc-9d00-000000000001}")
              );
            })
          ) {
            response.statusCode = 422;
            response.end("invalid parity envelope");
            return;
          }
          mkdirSync(dirname(parityPath), { recursive: true });
          writeFileSync(parityPath, `${body}\n`, { mode: 0o600 });
          response.statusCode = 204;
          response.end();
        });
      });
    },
  };
}

export default defineConfig(
  mergeConfig(viewerConfig, {
    plugins: [invocationRecorder()],
    test: {
      include: ["test/**/*.browser.test.tsx"],
      setupFiles: ["./test/setup-browser.ts"],
      fileParallelism: false,
      sequence: { concurrent: false },
      browser: {
        enabled: true,
        provider: playwright(),
        instances: [{ browser: "chromium" }],
        headless: true,
        api: { host: "127.0.0.1", port, strictPort: true },
        viewport: { width: 1440, height: 1000 },
        screenshotFailures: true,
        screenshotDirectory: "test-results/component-browser/screenshots",
        trace: { mode: "retain-on-failure", tracesDir: "test-results/component-browser/traces" },
      },
    },
  }),
);
