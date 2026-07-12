import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNOWN_HOSTS,
  GUEST_REPOSITORY,
  GUEST_SMOKE_PROJECT,
  HEADLESS_RUN_ARGS,
  VM_NAME,
  assessLaunchRecord,
  buildLaunchPlan,
  expectPasswordScript,
  guestDoctorPlan,
  guestExecPlan,
  nativeVerifyPlan,
  parseShareSpecs,
  readShareConfig,
  seedSmokeProjectGuestCommand,
  sshGuestExecPlan,
  sshPasswordInstallPlan,
  tartRunPlan,
  validateGuestIp,
  validateHostKeyPin,
  validateShareName,
  validateSharePath,
  validateSourceRef,
  verifySharesGuestCommand,
  writeShareConfig,
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
    expect(command).toContain("rustup which --toolchain 1.95.0 cargo");
    expect(command).not.toContain("ssh ");
    expect(command).not.toContain("/Users/tejas/Github/vean");
  });

  it("runs the Mac2 doctor through Tart rather than on the host", () => {
    const plan = guestDoctorPlan("main");
    expect(plan.slice(0, 3)).toEqual(["tart", "exec", VM_NAME]);
    expect(plan.at(-1)).toContain("bun run doctor:macos-driver");
    expect(plan.at(-1)).toContain('cargo_version="$(cargo --version)"');
    expect(plan.at(-1)).not.toContain("| grep -q");
  });

  it("makes bare cargo resolve to the pinned toolchain during clean guest bootstrap", () => {
    const bootstrap = readFileSync(join(process.cwd(), "scripts/vm/bootstrap-guest.sh"), "utf8");
    expect(bootstrap).toContain("rustup which --toolchain 1.95.0 cargo");
    expect(bootstrap).toContain('[[ "$(cargo --version)" == cargo\\ 1.95.0* ]]');
  });

  it("rejects refs that could inject guest shell commands", () => {
    expect(validateSourceRef("harness/h06-runtime-fix")).toBe("harness/h06-runtime-fix");
    expect(() => validateSourceRef("main; open -a Vean")).toThrow("invalid Git source ref");
    expect(() => validateSourceRef("../main")).toThrow("invalid Git source ref");
  });

  it("builds shell-safe, read-only VirtioFS arguments without an rw escape hatch", () => {
    const root = mkdtempSync(join(tmpdir(), "vean VM media $() ; ' "));
    const shares = parseShareSpecs([`project-media=${root}`]);
    const canonical = realpathSync(root);
    const plan = tartRunPlan(shares);
    expect(plan).toContain(`--dir=project-media:${canonical}:ro`);
    expect(plan.filter((argument) => argument.startsWith("--dir="))).toEqual([
      `--dir=project-media:${canonical}:ro`,
    ]);
    expect(plan.join("\n")).not.toContain(":rw");
    expect(plan.at(-1)).toBe(VM_NAME);
  });

  it("rejects duplicate, traversal, and non-slug share names", () => {
    const root = mkdtempSync(join(tmpdir(), "vean-share-names-"));
    expect(validateShareName("project-media")).toBe("project-media");
    for (const name of ["../media", "media/raw", "Media", "-media", "media-", "a..b"]) {
      expect(() => validateShareName(name)).toThrow("invalid share name");
    }
    expect(() => parseShareSpecs([`media=${root}`, `media=${root}`])).toThrow(
      "duplicate share name",
    );
    expect(() => parseShareSpecs([`../media=${root}`])).toThrow("invalid share name");
  });

  it("accepts only existing directories and refuses repository or sensitive config roots", () => {
    const home = mkdtempSync(join(tmpdir(), "vean-share-home-"));
    const media = join(home, "Movies", "Actual Project");
    mkdirSync(media, { recursive: true });
    expect(validateSharePath(media, home)).toBe(realpathSync(media));

    const repo = join(home, "Github", "project");
    mkdirSync(join(repo, ".git"), { recursive: true });
    expect(() => validateSharePath(repo, home)).toThrow("repository root");

    const config = join(home, ".config", "vean");
    mkdirSync(config, { recursive: true });
    expect(() => validateSharePath(config, home)).toThrow("sensitive dot-config");
    expect(() => validateSharePath(home, home)).toThrow("sensitive share root");
    expect(() => validateSharePath(join(home, "missing"), home)).toThrow("existing real directory");
    const file = join(home, "Movies", "not-a-directory.mov");
    writeFileSync(file, "test");
    expect(() => validateSharePath(file, home)).toThrow("existing real directory");
    expect(() => validateSharePath("relative/media", home)).toThrow("must be absolute");
  });

  it("persists canonical host-only share configuration with mode 0600", () => {
    const home = mkdtempSync(join(tmpdir(), "vean-share-config-home-"));
    const media = join(home, "Movies", "Media");
    const state = join(home, "state");
    const path = join(state, "shares.json");
    mkdirSync(media, { recursive: true });
    const written = writeShareConfig([`media=${media}`], path, home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readShareConfig(path)).toEqual(written);
    expect(readShareConfig(path).shares[0]?.hostPath).toBe(realpathSync(media));
  });

  it("marks missing, dead, or changed launch records unsafe while a VM is running", () => {
    const expected = buildLaunchPlan([{ name: "media", hostPath: "/tmp/media" }]);
    const current = { ...expected, pid: 123, startedAt: "2026-07-12T00:00:00.000Z" };
    expect(assessLaunchRecord(expected, current, true)).toEqual({
      ok: true,
      status: "current",
    });
    expect(assessLaunchRecord(expected, undefined, true)).toMatchObject({
      ok: false,
      status: "unknown",
    });
    expect(assessLaunchRecord(expected, current, false)).toMatchObject({
      ok: false,
      status: "unknown",
    });
    const changed = buildLaunchPlan([{ name: "other-media", hostPath: "/tmp/media" }]);
    expect(assessLaunchRecord(changed, current, true)).toMatchObject({
      ok: false,
      status: "stale",
    });
  });

  it("verifies every guest share exists and cannot be written", () => {
    const command = verifySharesGuestCommand([
      { name: "media", hostPath: "/tmp/media" },
      { name: "reference-assets", hostPath: "/tmp/reference-assets" },
    ]);
    expect(command).toContain("/Volumes/My Shared Files/media");
    expect(command).toContain("/Volumes/My Shared Files/reference-assets");
    expect(command.match(/\/usr\/bin\/touch/g)).toHaveLength(2);
    expect(command).toContain("share unexpectedly writable");
    expect(command).toContain("exit 1");
  });

  it("seeds a guest-local writable smoke project without scanning or mounting host code", () => {
    const command = seedSmokeProjectGuestCommand("main");
    expect(command).toContain(`project='${GUEST_SMOKE_PROJECT}'`);
    expect(command).toContain(`${GUEST_REPOSITORY}/corpus/shotcut-single.mlt`);
    expect(command).toContain("timeline use");
    for (const role of ["library", "recordings", "mic", "acquired"]) {
      expect(command).toContain(`/Volumes/My Shared Files/media-${role}`);
      expect(command).toContain(`--role ${role}`);
    }
    expect(command).not.toContain("media scan");
    expect(command).not.toContain("/Users/tejas");
  });
});
