import { readMacosContext } from "./e2e/macos/runtime";

const context = readMacosContext();

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./e2e/macos/native-shell.spec.ts"],
  maxInstances: 1,
  hostname: "127.0.0.1",
  port: context.appiumPort,
  path: "/",
  capabilities: [
    {
      platformName: "mac",
      "appium:automationName": "Mac2",
      "appium:bundleId": context.bundleId,
      "appium:appPath": context.bundlePath,
      "appium:systemPort": context.systemPort,
      "appium:showServerLogs": true,
      "appium:serverStartupTimeout": 180_000,
      "appium:noReset": false,
      "appium:skipAppKill": false,
      "appium:environment": context.appEnvironment,
    },
  ],
  logLevel: "info",
  bail: 1,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 240_000,
  connectionRetryCount: 0,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 300_000 },
};
