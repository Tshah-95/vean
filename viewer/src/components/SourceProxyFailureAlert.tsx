export type SourceProxyFailure = {
  code: string;
  sourcePath: string;
  detail: string;
};

/** Visible, machine-addressable failure for a source layer that could not be
 * proxied. Keeping this separate makes the fail-closed UI contract browser-testable
 * without constructing the WebGL/audio/worker graph. */
export function SourceProxyFailureAlert({ failure }: { failure: SourceProxyFailure }) {
  return (
    <div
      role="alert"
      data-testid="source-proxy-failure"
      data-error-code={failure.code}
      data-source-path={failure.sourcePath}
      title={failure.detail}
      style={{
        position: "absolute",
        left: 8,
        bottom: 8,
        maxWidth: "calc(100% - 16px)",
        padding: "6px 8px",
        borderRadius: 4,
        background: "rgba(145, 24, 24, 0.92)",
        color: "#fff",
        fontSize: 11,
      }}
    >
      {failure.code}: {failure.sourcePath}
    </div>
  );
}
