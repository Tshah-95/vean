import { installMockSyncOverride } from "@wdio/native-utils";
import { describe, expect, it } from "vitest";
import {
  type TauriIdentityObservation,
  evaluateTauriIdentity,
} from "../scripts/harness/tauri-identity";

const canonical: TauriIdentityObservation = {
  expectedBinaryPath: "/tmp/vean.app/Contents/MacOS/vean",
  expectedBinaryHash: "a".repeat(64),
  observedBinaryPath: "/tmp/vean.app/Contents/MacOS/vean",
  observedBinaryHash: "a".repeat(64),
  expectedBundleId: "studio.vean.desktop.harness.sabc123",
  observedBundleId: "studio.vean.desktop.harness.sabc123",
  expectedWebdriverPort: 41001,
  observedWebdriverPort: 41001,
  webdriverListenerPid: 801,
  appPid: 801,
  expectedPreviewPort: 41002,
  observedPreviewPort: 41002,
  previewListenerPid: 802,
  sidecarPid: 802,
  expectedFinalUrl: "http://127.0.0.1:41002/?route=timeline%3Amain",
  observedFinalUrl: "http://127.0.0.1:41002/?route=timeline%3Amain",
};

describe("Tauri evidence identity contract", () => {
  it("pins the tauri-service compatibility export its published 2.4.0 dependency omitted", () => {
    expect(typeof installMockSyncOverride).toBe("function");
  });

  it("accepts independently matching binary, bundle, listeners, and final URL", () => {
    expect(Object.values(evaluateTauriIdentity(canonical)).every(Boolean)).toBe(true);
  });

  for (const [name, patch, predicate] of [
    ["substituted executable", { observedBinaryPath: "/tmp/stale/vean" }, "exactBinary"],
    ["substituted executable bytes", { observedBinaryHash: "b".repeat(64) }, "exactBinary"],
    ["self-reported bundle", { observedBundleId: "studio.vean.desktop" }, "exactBundle"],
    ["foreign WebDriver listener", { webdriverListenerPid: 999 }, "webdriverListenerOwned"],
    ["wrong WebDriver port", { observedWebdriverPort: 4445 }, "webdriverListenerOwned"],
    ["foreign preview listener", { previewListenerPid: 999 }, "previewListenerOwned"],
    ["splash-only URL", { observedFinalUrl: "tauri://localhost/" }, "exactFinalUrl"],
    ["standalone-browser URL", { observedFinalUrl: "http://127.0.0.1:5173/" }, "exactFinalUrl"],
  ] as const) {
    it(`rejects ${name}`, () => {
      expect(evaluateTauriIdentity({ ...canonical, ...patch })[predicate]).toBe(false);
    });
  }
});
