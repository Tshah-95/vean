export type TauriIdentityObservation = {
  expectedBinaryPath: string;
  expectedBinaryHash: string;
  observedBinaryPath?: string;
  observedBinaryHash?: string;
  expectedBundleId: string;
  observedBundleId?: string;
  expectedWebdriverPort: number;
  observedWebdriverPort?: number;
  webdriverListenerPid?: number;
  appPid?: number;
  expectedPreviewPort: number;
  observedPreviewPort?: number;
  previewListenerPid?: number;
  sidecarPid?: number;
  expectedFinalUrl: string;
  observedFinalUrl?: string;
};

export function evaluateTauriIdentity(input: TauriIdentityObservation): Record<string, boolean> {
  return {
    exactBinary:
      input.observedBinaryPath === input.expectedBinaryPath &&
      input.observedBinaryHash === input.expectedBinaryHash,
    exactBundle:
      (input.observedBundleId?.length ?? 0) > 0 &&
      input.observedBundleId === input.expectedBundleId,
    webdriverListenerOwned:
      input.observedWebdriverPort === input.expectedWebdriverPort &&
      input.webdriverListenerPid === input.appPid,
    previewListenerOwned:
      input.observedPreviewPort === input.expectedPreviewPort &&
      input.previewListenerPid === input.sidecarPid &&
      input.sidecarPid !== input.appPid,
    exactFinalUrl: input.observedFinalUrl === input.expectedFinalUrl,
  };
}
