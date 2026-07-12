export type OwnedListener = { pid: number; address: string; port: number };
export type WebdriverProbe = {
  port: number;
  statusProtocolAccepted: boolean;
  sessionProtocolAccepted: boolean;
};

export function parseOwnedListeners(pid: number, output: string): OwnedListener[] {
  return output
    .split("\n")
    .filter((line) => line.startsWith("n"))
    .flatMap((line) => {
      const match = line.match(/:(\d+)(?:\s|$)/);
      return match ? [{ pid, address: line.slice(1), port: Number(match[1]) }] : [];
    });
}

export function isWebdriverProtocolResponse(contentType: string | null, body: string): boolean {
  if (!contentType?.toLowerCase().includes("json")) return false;
  try {
    const parsed = JSON.parse(body) as unknown;
    return Boolean(parsed && typeof parsed === "object" && "value" in parsed);
  } catch {
    return false;
  }
}

export function evaluateProductionListeners(
  listeners: OwnedListener[],
  probes: WebdriverProbe[],
  requestedWebdriverPort: number,
): {
  automationListeners: OwnedListener[];
  allOwnedListenersRejectAutomation: boolean;
} {
  const byPort = new Map(probes.map((probe) => [probe.port, probe]));
  const automationListeners = listeners.filter((listener) => {
    const probe = byPort.get(listener.port);
    return (
      listener.port === requestedWebdriverPort ||
      listener.port === 4445 ||
      probe?.statusProtocolAccepted === true ||
      probe?.sessionProtocolAccepted === true
    );
  });
  return {
    automationListeners,
    allOwnedListenersRejectAutomation:
      listeners.every((listener) => byPort.has(listener.port)) && automationListeners.length === 0,
  };
}
