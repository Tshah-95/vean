/** Typed product error returned by the source-proxy endpoint. The source path is
 * retained so the preview can tell the user which layer failed instead of silently
 * omitting it or showing an anonymous decode error. */
export class SourceProxyApiError extends Error {
  constructor(
    readonly code: string,
    readonly sourcePath: string,
    detail: string,
    readonly status: number,
  ) {
    super(detail);
    this.name = "SourceProxyApiError";
  }
}

type SourceProxyErrorBody = {
  ok?: false;
  kind?: string;
  code?: string;
  sourcePath?: string;
  detail?: string;
};

function sourceFromUrl(url: string): string {
  try {
    return new URL(url, window.location.origin).searchParams.get("path") ?? "unknown source";
  } catch {
    return "unknown source";
  }
}

/** Fetch proxy bytes while preserving the server's typed error envelope. */
export async function fetchSourceProxyBlob(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (response.ok) return response.blob();
  let body: SourceProxyErrorBody = {};
  try {
    body = (await response.json()) as SourceProxyErrorBody;
  } catch {
    // A non-JSON reverse-proxy error still becomes an attributed product error.
  }
  throw new SourceProxyApiError(
    body.code ?? "SOURCE_PROXY_REQUEST_FAILED",
    body.sourcePath ?? sourceFromUrl(url),
    body.detail ?? `Source proxy request failed with HTTP ${response.status}`,
    response.status,
  );
}
