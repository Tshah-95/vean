/**
 * Exact implementation set hashed into H06 evidence and independently matched
 * against the machine-readable truth manifest.
 */
export const nativeMacosOracleImplementationPaths = [
  "package.json",
  "bun.lock",
  "scripts/verify-macos.ts",
  "scripts/doctor-macos-driver.ts",
  "scripts/harness/macos-driver.ts",
  "scripts/harness/macos-domain-truth.ts",
  "scripts/harness/macos-ledger-monitor.ts",
  "scripts/harness/native-macos-control.ts",
  "scripts/harness/macos-runner-policy.ts",
  "scripts/harness/macos-evidence-contract.ts",
  "wdio.macos.conf.ts",
  "e2e/macos/native-shell.spec.ts",
  "e2e/macos/runtime.ts",
  "e2e/tauri/runtime.ts",
  "artifacts/specs/harness-scenarios/macos.json",
  "app/src-tauri/src/lib.rs",
] as const;
