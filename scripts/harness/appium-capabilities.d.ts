declare global {
  namespace WebdriverIO {
    interface Capabilities {
      "appium:automationName"?: "Mac2";
      "appium:bundleId"?: string;
      "appium:appPath"?: string;
      "appium:systemPort"?: number;
      "appium:showServerLogs"?: boolean;
      "appium:serverStartupTimeout"?: number;
      "appium:noReset"?: boolean;
      "appium:skipAppKill"?: boolean;
      "appium:environment"?: Record<string, string>;
    }
  }
}

export {};
