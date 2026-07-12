import { describe, expect, it } from "vitest";
import {
  evaluateProductionListeners,
  isWebdriverProtocolResponse,
  parseOwnedListeners,
} from "../scripts/harness/tauri-instrumentation-policy";

describe("production Tauri listener policy", () => {
  const listener = (port: number) => ({ pid: 903, address: `127.0.0.1:${port}`, port });
  const rejected = (port: number) => ({
    port,
    statusProtocolAccepted: false,
    sessionProtocolAccepted: false,
  });

  it("parses every TCP listener owned by one process", () => {
    expect(parseOwnedListeners(901, "p901\nf10\nn127.0.0.1:41002\nf11\nn*:4445\n")).toEqual([
      { pid: 901, address: "127.0.0.1:41002", port: 41002 },
      { pid: 901, address: "*:4445", port: 4445 },
    ]);
  });

  it("distinguishes WebDriver JSON from an ordinary preview response", () => {
    expect(isWebdriverProtocolResponse("application/json", '{"value":{"ready":true}}')).toBe(true);
    expect(isWebdriverProtocolResponse("text/html", "<html>viewer</html>")).toBe(false);
    expect(isWebdriverProtocolResponse("application/json", '{"status":"ok"}')).toBe(false);
  });

  it("allows owned preview listeners only after both WebDriver probes reject", () => {
    expect(evaluateProductionListeners([listener(41002)], [rejected(41002)], 41001)).toEqual({
      automationListeners: [],
      allOwnedListenersRejectAutomation: true,
    });
  });

  it.each([4445, 41001])(
    "rejects a known automation port %i even if its probe is silent",
    (port) => {
      const result = evaluateProductionListeners([listener(port)], [rejected(port)], 41001);
      expect(result.allOwnedListenersRejectAutomation).toBe(false);
      expect(result.automationListeners).toEqual([listener(port)]);
    },
  );

  it("rejects an alternate app-owned port that speaks WebDriver", () => {
    const probe = { ...rejected(5555), sessionProtocolAccepted: true };
    expect(evaluateProductionListeners([listener(5555)], [probe], 41001)).toEqual({
      automationListeners: [listener(5555)],
      allOwnedListenersRejectAutomation: false,
    });
  });

  it("fails closed when an owned listener was not probed", () => {
    expect(
      evaluateProductionListeners([listener(5555)], [], 41001).allOwnedListenersRejectAutomation,
    ).toBe(false);
  });
});
