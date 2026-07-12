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
  controlRoot,
  ensureControlPlan,
  scanSecret,
  writeControlFailure,
  writeVerifiedEvidence,
} from "./harness/evidence";

const repo = resolve(import.meta.dirname, "..");
const control = "nc-production-webview-policy";
const controlPlan = ensureControlPlan(repo, control, {
  before: '{"policyProfile":"release","navigationPortOffset":0}\n',
  mutated: '{"policyProfile":"dev","navigationPortOffset":1}\n',
});
const controlConfig = JSON.parse(
  await Bun.file(join(controlRoot(repo, control), "target.txt")).text(),
) as { policyProfile: "dev" | "release"; navigationPortOffset: number };
const negativePhase = process.env.VEAN_HARNESS_PHASE === "negative-control";

const token = crypto.randomUUID();
const authority = { host: "", origin: "", token, consumeNonce: createNonceConsumer() };
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: createPreviewHandler({
    repo,
    port: 0,
    dev: false,
    policyProfile: controlConfig.policyProfile,
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
const tauriBootstrap = readFileSync(join(repo, "app/src-tauri/src/lib.rs"), "utf8");
const rustPolicyTest = Bun.spawnSync(
  [
    "cargo",
    "test",
    "--locked",
    "--manifest-path",
    "app/src-tauri/Cargo.toml",
    "navigation_policy_tests",
  ],
  {
    cwd: repo,
    env: {
      ...process.env,
      TAURI_CONFIG: JSON.stringify({ bundle: { externalBin: [], resources: [] } }),
    },
  },
);
const tauriNavigationPolicyCompiled = rustPolicyTest.exitCode === 0;
const tauriNavigationPolicyRegistered = tauriBootstrap.includes(
  ".plugin(navigation_policy_plugin())",
);
const releaseCsp = contentSecurityPolicy("release");
const declaredNavigationOrigin = `http://127.0.0.1:${port + controlConfig.navigationPortOffset}`;
const infrastructureOk =
  tauriConfig.app?.security?.csp !== null &&
  tauriNavigationPolicyCompiled &&
  tauriNavigationPolicyRegistered &&
  unauthorized.status === 403;
if (!infrastructureOk) {
  throw new Error("webview policy infrastructure/compiled registration proof failed");
}
const policyPredicateMet =
  response.headers.get("content-security-policy") === releaseCsp &&
  !releaseCsp.includes("'unsafe-eval'") &&
  isAllowedViewerNavigation(`${origin}/`, declaredNavigationOrigin) &&
  !isAllowedViewerNavigation("https://example.com", declaredNavigationOrigin);
const candidate = {
  ok: infrastructureOk && policyPredicateMet,
  scope: "release-mode bound server and Tauri source configuration candidate",
  releaseCsp,
  responseHeaders,
  mutationWithoutAuthorityStatus: unauthorized.status,
  tauriCspNonNull: tauriConfig.app?.security?.csp !== null,
  tauriNavigationPolicyCompiled,
  tauriNavigationPolicyRegistered,
  navigation: {
    exactLoopback: isAllowedViewerNavigation(`${origin}/`, declaredNavigationOrigin),
    wrongLoopbackPort: isAllowedViewerNavigation(
      `http://127.0.0.1:${port + 1}`,
      declaredNavigationOrigin,
    ),
    external: isAllowedViewerNavigation("https://example.com", origin),
    localhostAlias: isAllowedViewerNavigation("http://localhost:39872", origin),
    dnsRebinding: isAllowedViewerNavigation("http://127.0.0.1.attacker.invalid:39872", origin),
  },
};
if (!candidate.ok) {
  if (negativePhase) writeControlFailure("SENSITIVITY_PRODUCTION_WEBVIEW_POLICY", control);
  throw new Error(`webview policy candidate failed: ${JSON.stringify(candidate)}`);
}
if (negativePhase) throw new Error("webview policy mutant unexpectedly satisfied the oracle");
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
  artifactPaths: [tauriConfigPath, join(repo, "app/src-tauri/src/lib.rs")],
  result: candidate,
  controlPlan,
});
if (!process.env.VEAN_HARNESS_EVIDENCE_PATH) console.log(JSON.stringify(candidate));
