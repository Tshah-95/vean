import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_KNOWN_HOSTS,
  GUEST_REPOSITORY,
  GUEST_SMOKE_FIXTURES,
  GUEST_SMOKE_PROJECT,
  GUEST_SMOKE_SEED_VERSION,
  HEADLESS_RUN_ARGS,
  PROJECT_ARTIFACT_ALLOWLIST,
  READY_STEPS,
  VM_NAME,
  assessLaunchRecord,
  assessRemoteRef,
  buildLaunchPlan,
  collectProjectArtifactsGuestCommand,
  expectPasswordScript,
  guestDoctorPlan,
  guestExecPlan,
  guestProjectPath,
  nativeVerifyPlan,
  parseShareSpecs,
  provisionArchiveGuestCommand,
  provisionRemoteGuestCommand,
  readShareConfig,
  remoteRefGuardCommand,
  seedSmokeProjectGuestCommand,
  sshGuestExecPlan,
  sshHardeningGuestCommand,
  sshPasswordInstallPlan,
  syncGuestCommand,
  tartRunPlan,
  validateAndPublishArchive,
  validateGuestIp,
  validateHostKeyPin,
  validateProjectArtifactIncludes,
  validateProjectName,
  validateRemoteRepositoryUrl,
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
    const processCommand =
      "/opt/homebrew/bin/tart run --no-graphics --no-audio --no-clipboard vean-macos-dev";
    const current = {
      ...expected,
      pid: 123,
      processCommand,
      startedAt: "2026-07-12T00:00:00.000Z",
    };
    expect(assessLaunchRecord(expected, current, true, processCommand)).toEqual({
      ok: true,
      status: "current",
    });
    expect(assessLaunchRecord(expected, undefined, true)).toMatchObject({
      ok: false,
      status: "unknown",
    });
    expect(assessLaunchRecord(expected, current, false, processCommand)).toMatchObject({
      ok: false,
      status: "unknown",
    });
    expect(assessLaunchRecord(expected, current, true, `${processCommand} --reused`)).toMatchObject(
      {
        ok: false,
        status: "unknown",
      },
    );
    const changed = buildLaunchPlan([{ name: "other-media", hostPath: "/tmp/media" }]);
    expect(assessLaunchRecord(changed, current, true, processCommand)).toMatchObject({
      ok: false,
      status: "stale",
    });
  });

  it("rejects stale origin state and checkout state against remote truth", () => {
    const remote = "a".repeat(40);
    expect(assessRemoteRef(remote, remote, remote)).toEqual({ ok: true, sha: remote });
    expect(assessRemoteRef(remote, "b".repeat(40), remote)).toMatchObject({ ok: false });
    expect(assessRemoteRef(remote, remote, "c".repeat(40))).toMatchObject({ ok: false });
    expect(assessRemoteRef("main", remote)).toMatchObject({ ok: false });

    const command = syncGuestCommand("main");
    expect(command).toContain("git fetch --prune --tags origin");
    expect(command).toContain("git ls-remote --exit-code origin");
    expect(command).toContain("stale origin ref");
    expect(command).toContain('git checkout --detach "$advertised"');
    expect(command).toContain("bun install --frozen-lockfile");
    for (const plan of [guestDoctorPlan("main"), nativeVerifyPlan("main")]) {
      expect(plan.at(-1)).toContain("git ls-remote --exit-code origin");
      expect(plan.at(-1)).toContain("checkout is not remote truth");
    }
    expect(seedSmokeProjectGuestCommand("main")).toContain("git ls-remote --exit-code origin");
  });

  it("fails the actual guard against a stale remote-tracking ref", () => {
    const root = mkdtempSync(join(tmpdir(), "vean-stale-origin-"));
    const remote = join(root, "remote.git");
    const author = join(root, "author");
    const guest = join(root, "guest");
    const git = (args: string[], cwd = root) =>
      spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      });
    expect(git(["init", "--bare", remote]).status).toBe(0);
    expect(git(["init", "-b", "main", author]).status).toBe(0);
    writeFileSync(join(author, "fixture.txt"), "one\n");
    expect(git(["add", "fixture.txt"], author).status).toBe(0);
    expect(
      git(["-c", "user.name=test", "-c", "user.email=test@invalid", "commit", "-m", "one"], author)
        .status,
    ).toBe(0);
    expect(git(["remote", "add", "origin", remote], author).status).toBe(0);
    expect(git(["push", "-u", "origin", "main"], author).status).toBe(0);
    expect(git(["clone", "--branch", "main", remote, guest]).status).toBe(0);
    writeFileSync(join(author, "fixture.txt"), "two\n");
    expect(git(["add", "fixture.txt"], author).status).toBe(0);
    expect(
      git(["-c", "user.name=test", "-c", "user.email=test@invalid", "commit", "-m", "two"], author)
        .status,
    ).toBe(0);
    expect(git(["push", "origin", "main"], author).status).toBe(0);

    const stale = spawnSync("/bin/bash", ["-lc", remoteRefGuardCommand("main")], {
      cwd: guest,
      encoding: "utf8",
    });
    expect(stale.status).not.toBe(0);
    expect(stale.stderr).toContain("stale origin ref");
  });

  it("defines one ordered daily-ready facade and package entry points", () => {
    expect(READY_STEPS).toEqual([
      "start",
      "sync",
      "doctor-guest",
      "verify-shares",
      "seed-smoke-project",
    ]);
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const command of [
      "vm:macos:sync",
      "vm:macos:ready",
      "vm:macos:provision-project",
      "vm:macos:collect-project-artifacts",
    ]) {
      expect(packageJson.scripts[command]).toContain("scripts/vm/macos-vm.ts");
    }
  });

  it("hardens sshd only after preserving public-key authentication", () => {
    const command = sshHardeningGuestCommand();
    expect(command).toContain('"pubkeyauthentication" && $2 == "yes"');
    expect(command).toContain('"passwordauthentication" && $2 == "no"');
    expect(command).toContain('"kbdinteractiveauthentication" && $2 == "no"');
    expect(command).toContain("sshd -t");
    expect(command).toContain("launchctl kickstart -k system/com.openssh.sshd");
  });

  it("provisions only direct guest-local projects from safe remote or tracked archive sources", () => {
    expect(validateProjectName("vean-fixture.1")).toBe("vean-fixture.1");
    expect(guestProjectPath("vean-fixture")).toBe("/Users/admin/Projects/vean-fixture");
    expect(() => validateProjectName("../escape")).toThrow("invalid guest project name");
    expect(validateRemoteRepositoryUrl("https://github.com/example/project.git")).toBe(
      "https://github.com/example/project.git",
    );
    for (const url of [
      "git@github.com:example/project.git",
      "https://token@github.com/example/project.git",
      "file:///tmp/project",
    ]) {
      expect(() => validateRemoteRepositoryUrl(url)).toThrow();
    }
    const remote = provisionRemoteGuestCommand(
      "https://github.com/example/project.git",
      "main",
      "project",
    );
    expect(remote).toContain("git ls-remote --exit-code origin");
    expect(remote).toContain("test ! -e");
    const archive = provisionArchiveGuestCommand("project", "a".repeat(40), "b".repeat(40));
    expect(archive).toContain("tar -xzf -");
    expect(archive).toContain("git init -q");
    expect(archive).toContain("vean.sourceCommit");
    expect(archive).toContain("vean.sourceTree");
  });

  it("collects only fixed artifact roots and refuses symlink-bearing payloads", () => {
    expect(validateProjectArtifactIncludes(["coverage", "coverage"])).toEqual(["coverage"]);
    expect(() => validateProjectArtifactIncludes([".env"])).toThrow("not allowlisted");
    const command = collectProjectArtifactsGuestCommand("project", ["test-results"]);
    expect(command).toContain("/Users/admin/Projects/project");
    expect(command).toContain("! -type f ! -type d");
    expect(command).toContain('test ! -L "$project"');
    expect(command).toContain("test-results");
    expect(PROJECT_ARTIFACT_ALLOWLIST).not.toContain("artifacts" as never);
  });

  it("validates archives and publishes them exclusively as mode 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "vean-archive-"));
    try {
      const payload = join(root, ".vean/harness/native-runs");
      mkdirSync(payload, { recursive: true });
      writeFileSync(join(payload, "result.json"), "{}\n");
      const source = join(root, "source.tgz");
      expect(
        spawnSync("tar", ["-czf", source, "-C", root, ".vean/harness/native-runs"]).status,
      ).toBe(0);
      const target = join(root, "evidence.tgz");
      validateAndPublishArchive(target, readFileSync(source), [".vean/harness/native-runs"]);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      expect(() =>
        validateAndPublishArchive(target, readFileSync(source), [".vean/harness/native-runs"]),
      ).toThrow("refusing to overwrite");

      const wrongTarget = join(root, "wrong.tgz");
      expect(() =>
        validateAndPublishArchive(wrongTarget, readFileSync(source), ["coverage"]),
      ).toThrow("unexpected evidence archive entry");

      symlinkSync("result.json", join(payload, "linked.json"));
      const linked = join(root, "linked.tgz");
      expect(
        spawnSync("tar", ["-czf", linked, "-C", root, ".vean/harness/native-runs"]).status,
      ).toBe(0);
      expect(() =>
        validateAndPublishArchive(join(root, "linked-output.tgz"), readFileSync(linked), [
          ".vean/harness/native-runs",
        ]),
      ).toThrow("non-regular entry");

      const symlinkTarget = join(root, "destination-link.tgz");
      symlinkSync(source, symlinkTarget);
      expect(() =>
        validateAndPublishArchive(symlinkTarget, readFileSync(source), [
          ".vean/harness/native-runs",
        ]),
      ).toThrow("refusing to overwrite");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

  it("seeds a versioned guest-local audiovisual H07 smoke project without overwriting", () => {
    const command = seedSmokeProjectGuestCommand("main");
    expect(command).toContain(`project='${GUEST_SMOKE_PROJECT}'`);
    expect(GUEST_SMOKE_SEED_VERSION).toBe(2);
    expect(GUEST_SMOKE_PROJECT).toContain("vean-smoke-v2");
    expect(command).toContain(`${GUEST_REPOSITORY}/corpus/harness/media/assets`);
    expect(command).toContain("timeline add-footage");
    expect(command).toContain("timeline add-audio");
    expect(command).toContain("timeline add-graphic");
    for (const fixture of Object.values(GUEST_SMOKE_FIXTURES)) {
      expect(command).toContain(fixture);
    }
    expect(command).toContain("existing project is not owned by the vean smoke seed");
    expect(command).toContain("harness-owned smoke timeline changed; refusing overwrite");
    expect(command).toContain("cmp -s");
    expect(command).toContain("harness-seed-v2.json");
    expect(command).toContain("timeline use");
    for (const role of ["library", "recordings", "mic", "acquired"]) {
      expect(command).toContain(`/Volumes/My Shared Files/media-${role}`);
      expect(command).toContain(`--role ${role}`);
    }
    expect(command).not.toContain("media scan");
    expect(command).not.toContain("/Users/tejas");
    expect(command).not.toContain("shotcut-single.mlt");
  });
});
