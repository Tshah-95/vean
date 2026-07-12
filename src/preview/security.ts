import { timingSafeEqual } from "node:crypto";

export type PreviewPolicyProfile = "dev" | "test" | "release";

export type MutationAuthority = {
  host: string;
  origin: string;
  token: string;
  consumeNonce: (nonce: string) => boolean;
};

export type AuthorityFailure = "host" | "origin" | "content-type" | "token" | "nonce";

export const MUTATION_PATHS = new Set([
  "/api/action",
  "/api/apply-op",
  "/api/undo",
  "/api/redo",
  "/api/save",
  "/api/proxy-render",
  "/api/still",
  "/api/render",
]);

function exactSecret(actual: string | null, expected: string): boolean {
  if (actual === null) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function authorityCookie(req: Request): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "vean-authority") return value.join("=") || null;
  }
  return null;
}

/** Validate mutation authority without reading or parsing the request body. */
export function authorizeMutation(
  req: Request,
  authority: MutationAuthority,
): { ok: true } | { ok: false; reason: AuthorityFailure } {
  if (req.headers.get("host") !== authority.host) return { ok: false, reason: "host" };
  if (req.headers.get("origin") !== authority.origin) return { ok: false, reason: "origin" };
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { ok: false, reason: "content-type" };
  const presented = req.headers.get("x-vean-authority") ?? authorityCookie(req);
  if (!exactSecret(presented, authority.token)) {
    return { ok: false, reason: "token" };
  }
  const nonce = req.headers.get("x-vean-nonce");
  if (!nonce || !authority.consumeNonce(nonce)) return { ok: false, reason: "nonce" };
  return { ok: true };
}

export function createNonceConsumer(): (nonce: string) => boolean {
  const seen = new Set<string>();
  return (nonce) => {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || seen.has(nonce)) return false;
    seen.add(nonce);
    return true;
  };
}

const RELEASE_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
].join("; ");

const TEST_CSP = `${RELEASE_CSP}; report-to vean-test`;
const DEV_CSP = [
  "default-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  // 'unsafe-inline' + 'unsafe-eval' are for the Vite dev server only: HMR needs
  // eval, and @vitejs/plugin-react injects its react-refresh preamble as an
  // INLINE module script — blocking it aborts every component module ("can't
  // detect preamble") and the viewer mounts nothing. Release stays inline-free.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' ws: http://127.0.0.1:*",
].join("; ");

export function contentSecurityPolicy(profile: PreviewPolicyProfile): string {
  if (profile === "dev") return DEV_CSP;
  if (profile === "test") return TEST_CSP;
  return RELEASE_CSP;
}

export function applyPreviewPolicy(res: Response, profile: PreviewPolicyProfile): Response {
  res.headers.set("Content-Security-Policy", contentSecurityPolicy(profile));
  res.headers.set("Referrer-Policy", "no-referrer");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return res;
}

export function isAllowedViewerNavigation(rawUrl: string, origin: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.origin === origin && url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
