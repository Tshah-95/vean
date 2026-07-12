# macOS VM workspace capacity for Tejas's active repositories

Date: 2026-07-12

## Decision summary

A persistent macOS VM on the current Mac Studio is practical and useful for
native UI automation, clean-clone verification, authenticated browser/app
workflows, packaging, and ordinary TypeScript/Rust development. The recommended
starting allocation is **8 vCPU, 32 GiB RAM, and a 150–200 GiB sparse guest
disk**. A smaller **6 vCPU / 16 GiB** disposable clone is enough for Vean's
native UI lane alone. A 48 GiB guest is justified only if Carlo, a large browser
session, native Postgres, and media/render tools must run simultaneously.

The VM should **not** mount `/Users/tejas/Github` read-write as its primary
workspace. Mount it read-only as a source/cache bridge, then create clean clones
on the guest's APFS disk. This preserves clean-clone semantics, keeps build
outputs fast, and prevents host/guest races over git indexes, `.next`,
`node_modules`, Cargo targets, SQLite files, and test controls.

The largest constraint is nested virtualization: Tart documents nested
virtualization only for Linux guests on M3/M4 hosts running macOS 15 or later.
A macOS guest therefore cannot rely on OrbStack or Docker Desktop's nested Linux
VM. Repositories that expect Docker Postgres need native guest Postgres, a
sibling Linux VM, a host-exposed service, or box-1.

## Observed host capacity

Observed on 2026-07-12:

- Hardware: `Mac16,9`, Apple M4 Max, 16 CPU cores (12 performance + 4
  efficiency), 128 GiB unified memory.
- Storage: 1.8 TiB data volume, 731 GiB used, approximately 1.1 TiB free.
- Memory at measurement: `memory_pressure -Q` reported 94% free and no swap-in
  or swap-out activity.
- Existing heavy processes demonstrate the realistic upper bound: the active
  Carlo `next-server` held about 12 GiB RSS and OrbStack's VM manager about 5
  GiB RSS, while the machine remained under low memory pressure.
- No Tart, UTM, Parallels, VMware CLI, or existing macOS VM manager was installed
  at inspection time.
- Tart usage on a personal workstation is royalty-free under its current Fair
  Source license. Paid licensing begins only for organizational server fleets
  beyond the published 100-host-CPU-core free tier; there is no software fee for
  this one-Mac setup.

Apple's Virtualization configuration gives the guest a configured physical
memory size that does not change without a balloon device. Treat the VM's RAM as
a committed capacity budget, not a container-style elastic limit.

## Workspace topology

### Recommended

```text
Host ~/Github (read-only mount) ──┐
                                  ├── guest-local clean clone on APFS
GitHub origin / temporary branch ─┘      ├── guest node_modules
                                         ├── guest .next / target / .vean
                                         ├── guest keychain and auth
                                         └── guest test artifacts
```

Use the host mount for fast access to source snapshots or local git objects, but
run builds and tests from the guest-local clone. For unpushed work, create a
temporary commit/branch or a git bundle; do not share a live host worktree or
index between machines.

### Possible but weaker

A read-write shared repo works for a one-off manual command when the host is not
touching it. It is poor default infrastructure because:

- it exposes dirty and untracked files, so it is not a clean clone;
- Next, Cargo, Bun/pnpm, SQLite, and harness controls write inside the tree;
- host and guest can race the same git index or worktree metadata;
- small-file dependency/build I/O over a shared filesystem is likely slower than
  guest-local APFS;
- absolute paths and file-watcher behavior differ at `/Volumes/My Shared Files`.

## Actual repository footprint

Top-level sizes were measured with `du`; clean tracked sizes were measured from
`git archive HEAD`. The large current sizes are mostly disposable caches rather
than source that should enter a clean VM image.

| Repository | Current checkout | Clean tracked snapshot | Dominant local weight |
| --- | ---: | ---: | --- |
| `carlo-finance` | 50.5 GiB | 124.7 MiB | `.next` 45.0 GiB; `node_modules` 5.1 GiB |
| `legal-toolkit` | 48.2 GiB | 807.5 MiB | `.cache` 44.0 GiB; packages 3.2 GiB |
| `vean` | 25.1 GiB | 5.5 MiB | `.vean` 10.7 GiB; Tauri/Cargo app 8.9 GiB |
| `media` | 11.4 GiB | 0.15 MiB | media library 9.7 GiB; acquired 1.2 GiB |
| `social` | 3.2 GiB | 0.5 MiB | Tauri/build state and dependencies |
| `studio` | 2.1 GiB | 10.8 MiB | `node_modules` 1.8 GiB; render output/assets |
| `reaper` | 1.2 GiB | not measured | Tauri/native build state |
| `medcorpus` | 524 MiB | 5.7 MiB | git history and dependencies; real DB is remote |
| `legal-data` | 149 MiB | 4.9 MiB | dependencies; canonical DB is remote |

A VM-local clean workspace for the active code does not need the roughly 140
GiB occupied by current host checkouts. Source plus fresh dependencies is likely
under 20 GiB initially. The disk recommendation is 150–200 GiB because repeated
Carlo builds, legal caches, Rust targets, browser binaries, Xcode, and video
artifacts can readily add 50–100 GiB.

## Repository-by-repository effectiveness

### `vean`: excellent fit

The clean source is tiny. The VM can run Bun/Vitest, Chromium Browser Mode,
Rust/Cargo, Tauri, Appium Mac2, MLT/FFmpeg, and package installation. Native UI
automation sees the guest WindowServer and does not occupy the host display.

- Native UI correctness: strong VM fit.
- Clean packaging/install/quit tests: strong VM fit.
- Remotion/MLT functional rendering: good VM fit after installing Brew
  dependencies.
- Hardware/performance claims: retain a physical-Mac finalizer because virtual
  graphics, media acceleration, permissions, and timing are not identical.
- Suggested lane: 6 vCPU / 16 GiB for Mac2; 8 vCPU / 24 GiB when rendering too.

### `carlo-finance`: effective after one infrastructure adaptation

Carlo is a large Next.js/Bun app. Its current live Next process alone used about
12 GiB RSS, and its documentation records that an 8 GiB Vercel builder OOMed.
Use 32 GiB for serious builds and browser workflows.

The app and Playwright/Vitest suites fit well. Fresh setup currently expects
OrbStack/Docker Postgres and Workflow World. That nested VM cannot run inside a
macOS Tart guest. Choose one of:

1. native Homebrew/Postgres.app databases in the macOS guest;
2. a sibling Linux VM providing Postgres and related services;
3. host Postgres exposed over the default NAT router address;
4. approved box-1/CI databases for integration lanes.

Vercel and GitHub Packages authentication must be established in the guest or
injected per job. A persistent authenticated guest makes this practical; a
disposable runner should use scoped ephemeral credentials.

- Suggested lane: 8 vCPU / 32 GiB.
- Do not bake the current 45 GiB `.next` cache into the base image.

### `legal-toolkit` and `legal-data`: very good fit

These are primarily pnpm/Bun/TypeScript/Vitest and Postgres tooling. Their
canonical legal substrate is box-1 Postgres, so the VM does not need to host the
large authoritative database. Install Tailscale or use an approved tunnel.

The 44 GiB legal-toolkit `.cache` is disposable and should remain out of the
golden image. A clean tracked legal-toolkit snapshot is about 808 MiB.

- Suggested lane: 6 vCPU / 12–16 GiB.
- Bulk remote data work remains network/box-1 bound, not VM-memory bound.

### `medcorpus`: good for code and bounded probes, wrong place for bulk ETL

The repository is small and its source-of-truth Postgres lives on box-1 with
large OpenAlex data stored remotely. Typecheck, CLI, browser collection probes,
and fixture tests fit. The 15M+ work / 100M+ edge bulk ETL should continue on
box-1 rather than moving into the VM.

- Suggested lane: 4–6 vCPU / 12–16 GiB.
- Optional throwaway Postgres must be native or external, not Docker in the
  macOS guest.

### `studio`: good functional fit, qualified performance fit

Remotion, headless Chrome, FFmpeg, MLT, and React can run in the guest. Mount
selected catalog/media paths read-only and map them to stable guest paths.
Functional frame/render checks are useful; final throughput, VideoToolbox,
color, audio-device, and GPU-sensitive budgets should remain physical-host
claims until benchmarked.

- Suggested lane: 8 vCPU / 24–32 GiB for rendering; 16 GiB for UI/tests only.
- Keep large render outputs on a dedicated shared artifact mount or copy them
  out after the run.

### `media`: useful as a client, not a full replacement for the media node

The catalog currently uses local Postgres 18/Postgres.app, while Whisper and
enrichment run on the always-on M4 Max. The VM can run the CLI, headless page
capture, catalog queries, and bounded ingestion against an exposed/replicated
database. It should not silently become a second writer over a shared media
library or replace physical-host Whisper/GPU measurements.

- Suggested lane: 6 vCPU / 16 GiB for catalog/client work; 24–32 GiB for bounded
  transcription experiments.
- Media directories should be explicitly mounted, normally read-only.

### `social` and `reaper`: strong native smoke candidates

Both have Tauri/native surfaces. Their unit logic is lightweight; VM value is
mainly clean install, notification/menu/window behavior, permissions, and native
smoke without host-screen takeover.

- Suggested lane: 4–6 vCPU / 12–16 GiB.

### `box-1-infra`, `crm`, `life`, `company`, `fellowship`, `intel`

The small web/config repositories are easy VM workloads at 8–12 GiB. Linux
deployment truth for `box-1-infra` should remain on a Linux VM or box-1; a macOS
VM only proves repository tooling, not the production OS.

## Performance expectations

These are planning ranges, not measured claims:

- CPU-only ARM64 compilation/tests on guest-local storage should be close enough
  to native for development; budget roughly 5–15% overhead until benchmarked.
- Filesystem-heavy dependency installs/builds may be materially slower when run
  directly on shared VirtioFS. Guest-local APFS is the correct benchmark path.
- A guest allocated 8 vCPU can saturate half of the 16-core host during builds.
  CPU is mostly idle when the guest is idle; under load it competes with host
  work rather than creating free capacity.
- Treat 32 GiB as committed while the VM is running. This still leaves 96 GiB
  for the host, substantially more than the current host workload needs.
- Virtual display/media/hardware paths can differ enough that performance,
  codec, camera, USB, passkey, DRM, and final accessibility claims need explicit
  qualification or physical-device finalization.

The correct way to replace estimates is a short host-versus-guest benchmark
packet: clean install, full tests, TypeScript build, Rust/Tauri build, Carlo
Next build, Remotion render, and a shared-mount versus guest-APFS comparison.

## Recommended profiles

| Profile | vCPU | RAM | Guest disk | Use |
| --- | ---: | ---: | ---: | --- |
| `macos-ui-smoke` | 6 | 16 GiB | 100 GiB sparse | Vean/social/reaper Mac2 and package smoke |
| `macos-dev` | 8 | 32 GiB | 200 GiB sparse | Carlo, authenticated browser, full workspace testing |
| `macos-render` | 10 | 32–48 GiB | 250 GiB sparse | bounded Studio/Vean rendering; not final perf truth |

Start with one `macos-dev` golden VM. Clone disposable `macos-ui-smoke` workers
from it rather than keeping multiple 32 GiB guests running. With 128 GiB host
memory, one 32 GiB guest is conservative; two simultaneous 24–32 GiB guests are
possible but provide little value unless work is genuinely parallel and CPU
contention is acceptable.

## Authentication and security model

- Authenticate Chrome and selected apps once inside a persistent VM; preserve
  that VM's disk/keychain rather than copying the host Chrome profile.
- macOS 15+ can access iCloud in a VM, but Apple assigns the guest a distinct
  identity and requires reauthentication if it moves to another host.
- Passkeys, Secure Enclave identities, hardware tokens, DRM, and certain device
  permissions do not become interchangeable with the host merely because the
  VM is persistent.
- Never publish an authenticated VM image to an OCI registry.
- Separate the persistent authenticated desktop from disposable untrusted-code
  runners. Disposable clones get test accounts and scoped credentials only.
- Mount personal/media directories by explicit allowlist; default to read-only.

## Sources

- Apple: [Virtualize macOS on a Mac](https://developer.apple.com/documentation/virtualization/virtualize-macos-on-a-mac)
- Apple: [Running macOS in a VM on Apple silicon](https://developer.apple.com/documentation/virtualization/running-macos-in-a-virtual-machine-on-apple-silicon)
- Apple: [Shared directories](https://developer.apple.com/documentation/virtualization/shared-directories)
- Apple: [Using iCloud with macOS VMs](https://developer.apple.com/documentation/virtualization/using-icloud-with-macos-virtual-machines)
- Apple: [VM memory size](https://developer.apple.com/documentation/virtualization/vzvirtualmachineconfiguration/memorysize)
- Tart: [Quick start, images, mounts, and default resources](https://tart.run/quick-start/)
- Tart: [FAQ: headless hosts, nested virtualization, host networking, storage](https://tart.run/faq/)
- Tart: [Guest agent and `tart exec`](https://tart.run/blog/2025/06/01/bridging-the-gaps-with-the-tart-guest-agent/)
- Tart: [Current licensing and free tier](https://tart.run/licensing/)
- GitHub: [Hosted runner lifecycle](https://docs.github.com/en/actions/how-tos/manage-runners/github-hosted-runners/use-github-hosted-runners)

## Recommendation

Build one persistent, local-only `macos-dev` Tart VM at 8 vCPU / 32 GiB / 200
GiB sparse disk. Provision Xcode, Homebrew, Bun/mise, Rust, MLT/FFmpeg,
Playwright browsers, Tailscale, native Postgres, the Tart guest agent, and the
required Accessibility/Automation permissions. Keep `/Users/tejas/Github`
read-only in the guest and create fresh guest-local clones for verification.

Before moving broad workflows, benchmark Vean, Carlo, legal-toolkit, and Studio
host-versus-guest. Use that packet to decide whether a second 16 GiB disposable
UI VM or a dedicated physical Mac is warranted.
