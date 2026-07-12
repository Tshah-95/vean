# Vean persistent macOS VM harness

The native AppKit/Mac2 tier runs only inside the persistent Tart guest
`vean-macos-dev`. The harness never starts a Tart graphics window and never
executes native verification on the host. Its fixed profile is 8 vCPU, 32,768
MB RAM, and a 200 GB sparse disk.

## First setup

```sh
bun run vm:macos:doctor -- --host-only
bun run vm:macos:configure
bun run vm:macos:start
bun run vm:macos:setup-ssh
bun run vm:macos:bootstrap
bun run vm:macos:doctor-guest
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
failure and is never replaced automatically.

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

Use `--source-ref <remote-branch>` with bootstrap and native verification when
the target is not `origin/main`. The ref must already exist on GitHub; no host
credentials or secrets are copied into the guest.

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

The guest is functional evidence for native behavior, not final physical-Mac
GPU, codec, timing, camera, USB, Secure Enclave, or performance truth.
