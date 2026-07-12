import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNOWN_HOSTS,
  GUEST_REPOSITORY,
  HEADLESS_RUN_ARGS,
  VM_NAME,
  expectPasswordScript,
  guestDoctorPlan,
  guestExecPlan,
  nativeVerifyPlan,
  sshGuestExecPlan,
  sshPasswordInstallPlan,
  tartRunPlan,
  validateGuestIp,
  validateHostKeyPin,
  validateSourceRef,
} from "../scripts/vm/macos-vm";

describe("macOS Tart VM harness policy", () => {
  it("always starts Tart without host-visible graphics, audio, or clipboard", () => {
    expect(tartRunPlan()).toEqual([
      "tart",
      "run",
      "--no-graphics",
      "--no-audio",
      "--no-clipboard",
      VM_NAME,
    ]);
    expect(HEADLESS_RUN_ARGS).not.toContain("--vnc");
  });

  it("can execute only through the named Tart guest", () => {
    expect(guestExecPlan("true").slice(0, 5)).toEqual([
      "tart",
      "exec",
      VM_NAME,
      "/bin/bash",
      "-lc",
    ]);
  });

  it("uses a strict, guest-only SSH fallback when the Tart agent is unavailable", () => {
    const plan = sshGuestExecPlan("192.168.64.2", "true", "/tmp/test-key");
    expect(plan).toContain("BatchMode=yes");
    expect(plan).toContain("IdentitiesOnly=yes");
    expect(plan).toContain("StrictHostKeyChecking=yes");
    expect(plan).toContain(`UserKnownHostsFile=${DEFAULT_KNOWN_HOSTS}`);
    expect(plan).toContain("admin@192.168.64.2");
    expect(plan).not.toContain("localhost");
    expect(() => validateGuestIp("127.0.0.1")).toThrow("non-private Tart DHCP address");
    expect(() => validateGuestIp("8.8.8.8")).toThrow("non-private Tart DHCP address");
  });

  it("keeps one-time password authorization scoped to the private Tart guest", () => {
    const plan = sshPasswordInstallPlan("192.168.64.2", "true", "/tmp/known-hosts");
    expect(plan).toContain("PreferredAuthentications=password");
    expect(plan).toContain("PubkeyAuthentication=no");
    expect(plan).toContain("StrictHostKeyChecking=yes");
    expect(plan).toContain("UserKnownHostsFile=/tmp/known-hosts");
    expect(plan).toContain("admin@192.168.64.2");
    expect(plan).not.toContain("127.0.0.1");
    expect(plan).not.toContain("localhost");
  });

  it("encodes the bootstrap password with the macOS system Tcl-compatible primitive", () => {
    const script = expectPasswordScript("admin$[]");
    expect(script).toContain("binary format H*");
    expect(script).not.toContain("binary decode");
    expect(script).not.toContain("admin$[]");
  });

  it("refuses to replace a mismatched pinned guest host key", () => {
    const scanned = ["192.168.64.2 ssh-ed25519 AAAASCANNED"];
    expect(validateHostKeyPin(scanned, scanned)).toBe(scanned[0]);
    expect(() => validateHostKeyPin(scanned, ["192.168.64.2 ssh-ed25519 AAAAATTACKER"])).toThrow(
      "does not match",
    );
  });

  it("binds native verification to a clean guest-local clone and dedicated policy", () => {
    const plan = nativeVerifyPlan("main");
    const command = plan.at(-1) ?? "";
    expect(plan.slice(0, 3)).toEqual(["tart", "exec", VM_NAME]);
    expect(command).toContain(`cd ${GUEST_REPOSITORY}`);
    expect(command).toContain('test -z "$(git status --porcelain)"');
    expect(command).toContain("VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION=1");
    expect(command).toContain("VEAN_MACOS_RUNNER_CLASS=dedicated");
    expect(command).not.toContain("ssh ");
    expect(command).not.toContain("/Users/tejas/Github/vean");
  });

  it("runs the Mac2 doctor through Tart rather than on the host", () => {
    const plan = guestDoctorPlan("main");
    expect(plan.slice(0, 3)).toEqual(["tart", "exec", VM_NAME]);
    expect(plan.at(-1)).toContain("bun run doctor:macos-driver");
  });

  it("rejects refs that could inject guest shell commands", () => {
    expect(validateSourceRef("harness/h06-runtime-fix")).toBe("harness/h06-runtime-fix");
    expect(() => validateSourceRef("main; open -a Vean")).toThrow("invalid Git source ref");
    expect(() => validateSourceRef("../main")).toThrow("invalid Git source ref");
  });
});
