import { describe, expect, it } from "vitest";
import {
  applyPreviewPolicy,
  authorizeMutation,
  contentSecurityPolicy,
  createNonceConsumer,
  isAllowedViewerNavigation,
} from "../src/preview/security";

const origin = "http://127.0.0.1:43127";
const host = "127.0.0.1:43127";
const token = "test-authority-do-not-log";

function authority() {
  return { host, origin, token, consumeNonce: createNonceConsumer() };
}

function mutation(
  auth: ReturnType<typeof authority>,
  headers: Record<string, string>,
  nonce = "nonce_1234567890123456",
  body = "not-json-on-purpose",
) {
  return authorizeMutation(
    new Request(`${origin}/api/action`, {
      method: "POST",
      headers: {
        host,
        origin,
        "content-type": "application/json",
        "x-vean-authority": token,
        "x-vean-nonce": nonce,
        ...headers,
      },
      body,
    }),
    auth,
  );
}

describe("launch-scoped loopback mutation authority", () => {
  it.each([
    ["cross-origin", { origin: "https://attacker.invalid" }],
    ["missing-origin", { origin: "" }],
    ["null-origin", { origin: "null" }],
    ["dns-rebinding-host", { host: "vean.attacker.invalid:43127" }],
    ["form-body", { "content-type": "application/x-www-form-urlencoded" }],
    ["missing-token", { "x-vean-authority": "" }],
    ["wrong-token", { "x-vean-authority": "wrong" }],
  ])("rejects %s without inspecting an invalid body", async (_name, headers) => {
    const result = mutation(authority(), headers);
    expect(result.ok).toBe(false);
  });

  it("rejects a replayed nonce before parsing the body", async () => {
    const auth = authority();
    expect(mutation(auth, {}).ok).toBe(true);
    expect(mutation(auth, {})).toEqual({ ok: false, reason: "nonce" });
  });
});

describe("preview release policy", () => {
  it("uses distinct non-null dev/test/release CSPs without eval in release", () => {
    const dev = contentSecurityPolicy("dev");
    const test = contentSecurityPolicy("test");
    const release = contentSecurityPolicy("release");
    expect(new Set([dev, test, release]).size).toBe(3);
    expect(dev).toContain("'unsafe-eval'");
    // Vite dev injects the react-refresh preamble as an INLINE script; without
    // 'unsafe-inline' in script-src the viewer mounts nothing (blank window).
    expect(dev).toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(release).not.toContain("'unsafe-eval'");
    expect(release).not.toMatch(/script-src [^;]*'unsafe-inline'/);
    expect(release).toContain("form-action 'none'");
    expect(release).toContain("connect-src 'self'");
  });

  it("allows only the exact 127.0.0.1 viewer origin", () => {
    expect(isAllowedViewerNavigation(`${origin}/viewer`, origin)).toBe(true);
    expect(isAllowedViewerNavigation("https://example.com", origin)).toBe(false);
    expect(isAllowedViewerNavigation("http://localhost:43127", origin)).toBe(false);
    expect(isAllowedViewerNavigation("http://127.0.0.1.attacker.invalid:43127", origin)).toBe(
      false,
    );
  });

  it("stamps release policy on every response", async () => {
    const response = applyPreviewPolicy(new Response("ok"), "release");
    expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy("release"));
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
