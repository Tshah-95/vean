#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  contentSecurityPolicy,
  createNonceConsumer,
  isAllowedViewerNavigation,
} from "../src/preview/security";
import { createPreviewHandler } from "../src/preview/server";
import {
  controlIsMutated,
  scanSecret,
  writeControlFailure,
  writeVerifiedEvidence,
} from "./harness/evidence";

const repo = resolve(import.meta.dirname, "..");
const control = "nc-production-webview-policy";
if (process.env.VEAN_HARNESS_PHASE === "negative-control") {
  if (!controlIsMutated(repo, control)) throw new Error(`${control} was not mutated`);
  writeControlFailure("SENSITIVITY_PRODUCTION_WEBVIEW_POLICY", control);
}

const token = crypto.randomUUID();
const authority = { host: "", origin: "", token, consumeNonce: createNonceConsumer() };
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: createPreviewHandler({
    repo,
    port: 0,
    dev: false,
    policyProfile: "release",
    mutationAuthority: authority,
  }),
});
const port = server.port ?? 0;
const origin = `http://127.0.0.1:${port}`;
authority.host = `127.0.0.1:${port}`;
authority.origin = origin;
const response = await fetch(`${origin}/api/health`);
const unauthorized = await fetch(`${origin}/api/action`, {
  method: "POST",
  headers: { host: authority.host, origin, "content-type": "application/json" },
  body: "{}",
});
server.stop(true);
const responseHeaders: Record<string, string> = {};
response.headers.forEach((value, key) => {
  responseHeaders[key] = value;
});
const tauriConfigPath = join(repo, "app/src-tauri/tauri.conf.json");
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
const releaseCsp = contentSecurityPolicy("release");
const candidate = {
  ok:
    response.headers.get("content-security-policy") === releaseCsp &&
    !releaseCsp.includes("'unsafe-eval'") &&
    tauriConfig.app?.security?.csp !== null &&
    unauthorized.status === 403 &&
    isAllowedViewerNavigation(`${origin}/`, origin) &&
    !isAllowedViewerNavigation("https://example.com", origin),
  scope: "release-mode bound server and Tauri source configuration candidate",
  releaseCsp,
  responseHeaders,
  mutationWithoutAuthorityStatus: unauthorized.status,
  tauriCspNonNull: tauriConfig.app?.security?.csp !== null,
  navigation: {
    exactLoopback: isAllowedViewerNavigation(`${origin}/`, origin),
    external: isAllowedViewerNavigation("https://example.com", origin),
    localhostAlias: isAllowedViewerNavigation("http://localhost:39872", origin),
    dnsRebinding: isAllowedViewerNavigation("http://127.0.0.1.attacker.invalid:39872", origin),
  },
};
if (!candidate.ok) throw new Error(`webview policy candidate failed: ${JSON.stringify(candidate)}`);
const evidenceBase = process.env.VEAN_HARNESS_EVIDENCE_PATH
  ? dirname(process.env.VEAN_HARNESS_EVIDENCE_PATH)
  : join(repo, ".vean/harness/standalone");
const invocationId = (process.env.VEAN_HARNESS_CLAIM_RUN_ID ?? crypto.randomUUID()).replace(
  /[^A-Za-z0-9_.-]/g,
  "_",
);
const candidateDir = join(evidenceBase, "claim-production-webview-policy-artifacts", invocationId);
const candidatePath = join(candidateDir, "policy-candidate.json");
mkdirSync(candidateDir, { recursive: true });
writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
if (scanSecret(candidateDir, token).length > 0)
  throw new Error("authority leaked into policy artifacts");
writeVerifiedEvidence({
  repo,
  claimId: "claim-production-webview-policy",
  oracleCommand: "bun run verify:webview-policy --profile release",
  expectedPredicate:
    "release-mode bound-server headers and Tauri source configuration enforce the approved navigation/resource/eval/cross-origin matrix and csp:null cannot satisfy the claim",
  controlId: control,
  fixturePath: candidatePath,
  commandPath: join(repo, "scripts/verify-webview-policy.ts"),
  implementationPaths: [
    join(repo, "scripts/verify-webview-policy.ts"),
    join(repo, "src/preview/security.ts"),
  ],
  generatedPaths: [candidatePath],
  artifactPaths: [tauriConfigPath],
  result: candidate,
});
if (!process.env.VEAN_HARNESS_EVIDENCE_PATH) console.log(JSON.stringify(candidate));
