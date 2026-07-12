# Vean persistent macOS VM harness

The native AppKit/Mac2 tier runs only inside the persistent Tart guest
`vean-macos-dev`. The harness never starts a Tart graphics window and never
executes native verification on the host. Its fixed profile is 8 vCPU, 32,768
MB RAM, and a 200 GB sparse disk.

## First setup

```sh
bun run vm:macos:doctor -- --host-only
bun run vm:macos:configure
bun run vm:macos:configure-shares -- project-media=/absolute/path/to/media reference-assets=/absolute/path/to/assets
bun run vm:macos:start
bun run vm:macos:setup-ssh
bun run vm:macos:bootstrap
bun run vm:macos:ready
```

`configure` clones the macOS Tahoe/Xcode image pinned at digest
`sha256:61f6e857a3d65dd2f8daf9c51c7b837fa458bcc9181ae8556e645b534dab6bf6`
only when the named VM is absent, then adopts and validates the fixed resource profile. It
fails rather than replacing, shrinking, or silently accepting the wrong VM.
`start` always uses `tart run --no-graphics --no-audio --no-clipboard`; it logs
under `~/.local/state/vean-vm/` and waits for a guest command transport. On the
first boot, run `setup-ssh` before `bootstrap` when `tart exec` is unavailable.

`setup-ssh` derives only the private address returned by
`tart ip vean-macos-dev --resolver dhcp`, creates a dedicated Ed25519 key, pins
the guest's Ed25519 host key in `~/.ssh/known_hosts.vean-tart`, and authorizes
the key for the documented Cirrus `admin` account through terminal-only
`/usr/bin/expect`. The public image password defaults to `admin` and is never
written to disk or a subprocess argument; set `VEAN_TART_BOOTSTRAP_PASSWORD`
if the image password changed. An existing mismatched host key is a hard
failure and is never replaced automatically. Once the dedicated key has been
proved, setup installs and validates a key-only sshd drop-in, restarts sshd,
then proves the same pinned key still works. Effective
`PasswordAuthentication no`, `KbdInteractiveAuthentication no`, and
`PubkeyAuthentication yes` are part of every guest doctor run.

After setup, the harness prefers strict SSH because this image's Tart guest
agent hangs. Every login requires `BatchMode`, `IdentitiesOnly`, the dedicated
key, the dedicated known-hosts file, and strict host-key checking. A bounded
guest-agent probe is only a fallback. Override paths with `VEAN_TART_SSH_KEY`
and `VEAN_TART_KNOWN_HOSTS`; host, loopback, and public targets are rejected.

Bootstrap is idempotent and fail-closed. It completes Xcode first launch,
prepends the Apple Silicon Homebrew path, runs `brew update`, installs `mlt`,
`ffmpeg`, `libxml2`, and `mise`, pins Bun 1.3.14, Node
24.15.0, and Rust 1.95.0, then creates a clean guest-local clone at
`/Users/admin/Github/vean-runner`. It refuses to erase a dirty guest clone. The
host checkout is neither mounted nor executed.

The bootstrap and guest commands resolve `cargo` from the pinned 1.95.0
toolchain directory explicitly. This is required on images that already ship a
Homebrew `rustup` binary without installing the usual `~/.cargo/bin` proxy
commands; native Tauri builds must not depend on an interactive shell default.

Use `--source-ref <remote-branch>` with bootstrap, ready, and native verification when
the target is not `origin/main`. The ref must already exist on GitHub; no host
credentials or secrets are copied into the guest.

## Daily readiness

```sh
bun run vm:macos:ready -- --source-ref main
```

`ready` is the canonical daily facade: start headlessly, fetch and prune the
guest clone, resolve the requested branch with `git ls-remote`, detach at that
exact advertised commit, run the guest doctor, prove every configured share is
read-only, and seed the smoke project. Individual doctor, seed, and native
commands also compare the checkout and `origin/<branch>` with the independently
advertised remote commit, so a stale remote-tracking ref cannot pass. The doctor
requires at least 40 GiB free on `/` and 20 GiB free at the guest project root.

The launch record binds the PID to the exact `ps` command captured for the Tart
runner as well as the argument vector and share digest. A reused PID, changed
command, externally started VM, or stale share configuration fails closed.

## Native proof and evidence

```sh
bun run vm:macos:status
bun run vm:macos:verify-native
bun run vm:macos:collect-evidence
bun run vm:macos:stop
```

Native verification first proves that the VM is running with the fixed profile,
the selected guest transport responds, the clone is clean, its origin is the canonical
GitHub repository, and its HEAD equals the requested remote ref. Only then does
it run H06 with both required policy variables:
`VEAN_ALLOW_INTERACTIVE_MACOS_AUTOMATION=1` and
`VEAN_MACOS_RUNNER_CLASS=dedicated`.

`doctor-guest` verifies macOS 26.4 build 25E246 on `VirtualMac2,1`, Xcode 26.5,
the pinned guest toolchains, Xcode first-launch state,
media binaries, clean-clone identity, and the real Mac2 driver doctor. On the
first run, macOS may require one guest-only setup interaction: connect to the
guest (never the host desktop), grant Accessibility to the signed Xcode Helper
reported by the doctor, and approve Xcode Automation when macOS prompts. Rerun
`doctor-guest` afterward; an unapproved or incomplete permission state remains
a hard failure.

`collect-evidence` copies only `.vean/harness/native-runs` through the selected
guest transport into a mode-0600 archive under `.vean/vm-harness/evidence/` on the host.
No shared writable repository or authenticated VM image is created.

## Projects, media, and generated assets

Code and project state always live on the guest APFS disk. Bootstrap creates a
clean clone at `/Users/admin/Github/vean-runner`; clone a test project into the
guest as a separate directory. Do not mount a host Git repository as the guest
working copy. This preserves the clean-clone signal and prevents a guest test
from changing host source, indexes, SQLite state, or build artifacts.

Provision an additional writable guest-local project in either of two ways:

```sh
# Public, credential-free HTTPS remote. The branch is resolved against ls-remote.
bun run vm:macos:provision-project -- --name sample --url https://github.com/org/repo.git --source-ref main

# Clean committed snapshot from a local worktree. Only git-tracked bytes cross.
bun run vm:macos:provision-project -- --name private-sample --source /absolute/local/repo --source-ref main
```

Remote provisioning accepts no URL credentials. Local provisioning refuses
tracked or staged changes and streams `git archive` output into the guest; it
does not copy `.git`, untracked files, ignored secrets, dependency caches, or
build caches. Targets must be direct children of `/Users/admin/Projects` and
must not already exist. This produces a clean writable guest repository without
a writable host mount.

Bring back only fixed test-output roots with a private archive:

```sh
bun run vm:macos:collect-project-artifacts -- --name sample --include test-results --include coverage
```

The collector accepts only `.vean/harness/native-runs`,
`.vean/harness/browser-runs`, `test-results`, `playwright-report`, and
`coverage`; at least one explicit `--include` is required. It rejects missing
roots and symlinks and writes a mode-0600 `.tgz`.

Large immutable inputs can be exposed with read-only VirtioFS shares:

```sh
bun run vm:macos:configure-shares -- project-media=/absolute/path/to/media
bun run vm:macos:stop
bun run vm:macos:start
bun run vm:macos:verify-shares
```

Each share appears at `/Volumes/My Shared Files/<name>`. Names are lowercase
slugs. Paths are canonicalized and must be existing directories. The harness
refuses duplicate/traversal names, Git repository roots, the home directory,
sensitive dot-configuration trees, and broad system roots. The host-local
configuration is mode 0600 under `~/.local/state/vean-vm/`; no personal path is
committed. There is no writable-share option. `verify-shares` checks every
mount exists and proves a write fails.

Read-only means integrity protection, not confidentiality. Guest processes can
read mounted personal media, and this developer VM retains ordinary network
access, so a compromised dependency could exfiltrate it. Use only committed
synthetic fixtures (and configure no personal shares) for untrusted code. Mount
personal media only for trusted project-smoke runs; network isolation is not
currently an asserted property of this profile.

Changing share configuration while the VM runs deliberately makes `start`,
`status`, `doctor`, and guest commands fail until the VM is stopped and
restarted. The exact Tart argument vector and share digest are recorded beside
the configuration, so a VM started outside this harness is treated as unknown,
not as if its media were mounted.

Use this storage split for actual editing tests:

- source code, the project clone, `.vean/vean.db`, dependency caches, render
  caches, proxies, stills, and final renders: guest-local and writable;
- camera originals, stock libraries, and stable fixture packs: read-only shared
  folders;
- small deterministic test assets: committed OSS-safe fixtures in the guest
  clone, so CI and a fresh clone get identical inputs.

`bun run vm:macos:seed-smoke-project` idempotently creates the writable project
`/Users/admin/Projects/vean-smoke`, selects its committed color-only timeline,
copies the small tone fixture, and registers the four canonical read-only media
roots without scanning them. It refuses any other share set and never overwrites
an existing smoke timeline, so the guest remains useful for hands-on editing
between harness runs. Use explicit `vean media scan --root <id>` only when a test
actually needs the large personal corpus cataloged.

For a project that already stores absolute host paths, do not recreate or
mutate the host directory layout. Point project routes at the guest mount, for
example `vean route set media:raw '/Volumes/My Shared Files/project-media'`,
register it with `vean media root add`, and run `vean media relink --search`
when catalog entries need reconnecting. If a third-party `.mlt` cannot use
routes, make an explicit guest-local compatibility mapping to the read-only
mount and document it with the test project; never make the host share writable.

The guest is functional evidence for native behavior, not final physical-Mac
GPU, codec, timing, camera, USB, Secure Enclave, or performance truth.
