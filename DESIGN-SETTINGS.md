# vean settings catalog

The roadmap for vean's tunable settings, grounded in what professional editors
actually change and love across **Premiere Pro, DaVinci Resolve, Final Cut Pro,
Avid Media Composer, and Shotcut** (the spec source). It is the design backing for
the settings primitive in [`src/state/settings.ts`](src/state/settings.ts) (typed
registry → `vean config`, project-scoped, stored in `.vean/vean.db`).

**Discipline — no dead settings.** A setting is added only when something *reads*
it. Everything below is tagged:

- **`LIVE`** — implemented and read by code today.
- **`READY`** — the consumer exists; the setting is a small wiring step.
- **`ROADMAP`** — needs a behavior/surface vean hasn't built yet; add the setting
  *with* that feature, not before (a registered-but-unread setting is a lie).

## Cross-cutting principles (the distilled lessons)

These are the load-bearing design insights from the survey; they shape every entry.

1. **Match-source is the meta-default.** Premiere "New Sequence From Clip", FCP
   Automatic, Shotcut "Video Mode: Automatic" all derive fps/resolution/audio-rate
   from the first clip. vean does this via **autodetect-on-first-clip** (`LIVE`).
2. **Frame rate is rational `[num, den]`, never a float** — already a vean
   invariant. Every NLE locks fps after media is added; the whole drop-frame
   timecode apparatus exists because 29.97 ≠ 30. vean models it correctly and can
   conform instead of hard-locking (the consequence-preview model fits).
3. **Setting changes apply to *future* actions only — the #1 footgun.** In every
   NLE, changing the default transition/still duration does *not* retime existing
   clips. vean should decide deliberately and, where it can, offer "apply to
   existing too" (its op/consequence model makes this tractable).
4. **Sticky toggle + modifier override.** Snapping and linked-selection each need a
   persistent setting *and* a tap-to-suspend (Premiere's tap-`S`-mid-drag, Resolve's
   `N`, Alt-click). The preference alone is not enough.
5. **Split clip-snapping from playhead-snapping** — Resolve's single most-requested
   missing capability. A concrete differentiator.
6. **Make audio-scrubbing a *true* sticky preference** — Resolve/Premiere reset it
   per session; editors re-toggle it every launch. An easy win.
7. **Proxy/low-res-on-export is a footgun** (shipping a low-res master) — model it
   as a **diagnostic**, not just a setting: warn when a render would use proxy /
   optimized / reduced-res media. vean's diagnostics layer is the natural home.
8. **Preview quality is preview-only; export is always full.** Surface this
   explicitly so the "video looks softer when playing" / "is my export low-res?"
   confusion never happens.
9. **Three scopes: user-global · project · per-timeline.** vean settings are
   **project-scoped** today (the registry default is the global baseline). A
   user-global layer can sit *under* the read API later without changing callers.
10. **VFR detect + conform** — `LIVE`: `variable-frame-rate-source` /
    `source-fps-mismatch` diagnostics + `vean fps conform` / `transcode`.
11. **Versioned backup ON by default.** Resolve's most-cursed default is that
    *Live Save* (overwrite) is on but *Project Backups* (versioned) is off — zero
    rollback until you flip it. If vean adds backups, the versioned tier ships on.
12. **Name codec *quality tiers*, not bitrates** (the DNxHD→DNxHR lesson) — done in
    `media.transcodeCodec`.

## The catalog

### Frame rate / conform — `LIVE`
| key | default | status | notes |
|---|---|---|---|
| `fps.autodetect` | `confirm` | **LIVE** | off/confirm/auto, read on first-clip append + `vean fps conform` |
| `fps.mismatchTolerance` | `0.0005` | **LIVE** | `source-fps-mismatch` threshold |
| `fps.vfrTolerance` | `0.002` | **LIVE** | `variable-frame-rate-source` threshold |
| `media.transcodeCodec` | `prores422hq` | **LIVE** | CFR intermediate codec for `vean fps transcode` |

### Editing behavior
| key | default (research) | status | notes |
|---|---|---|---|
| `edit.defaultTransitionDuration` | 1 s (editors → 0.5 s / 15 f) | **READY** | the dissolve/transition action would read it instead of requiring `frames`; apply-to-future per principle 3 |
| `edit.defaultClipDuration` | 4 s (FCP/Shotcut) / 5 s (Resolve/Premiere) | **ROADMAP** | needs the "add still/color/graphic" op to consult it |
| `edit.snapping` | on | **ROADMAP** | viewer already snaps — needs the viewer to read settings via the API |
| `edit.snapPlayhead` | on | **ROADMAP** | the *split* (clip vs playhead) — differentiator (principle 5) |
| `edit.snapThresholdPx` | ~8 px | **ROADMAP** | viewer-read |
| `edit.linkedSelection` | on | **ROADMAP** | needs A/V link in the IR/ops |
| `edit.audioScrubbing` | on, **sticky** | **ROADMAP** | viewer playback feature (principle 6) |
| `edit.rippleDefault` | off (Shotcut) | **ROADMAP** | ripple is a per-op arg today; a default would feed the gesture layer |

### Media / import
| key | default | status | notes |
|---|---|---|---|
| `media.conformOnImport` | (off/ask) | **ROADMAP** | Premiere's gap vs Resolve; pairs with autodetect — "conform VFR to CFR on add" |
| `media.defaultScaling` | `setToFrameSize` | **ROADMAP** | preserve source res + visible scale% (Premiere's "first thing I change"); needs a scale/fit op |
| `media.proxyCodec` / `media.proxyResolution` | ProRes Proxy / 540p | **ROADMAP** | proxy generation is a deferred media family (AGENTS.md) |
| `media.audioSampleRate` | 48000 | **ROADMAP** | + a `sample-rate-mismatch` diagnostic already exists in `checks/media.ts` |

### Playback / preview (viewer-scoped)
| key | default | status | notes |
|---|---|---|---|
| `preview.playbackResolution` | full (→ 1/2 for 4K) | **ROADMAP** | the proxy builder already downscales; expose the factor |
| `preview.pausedResolution` | full | **ROADMAP** | the two-resolution split is a genuinely good pattern (Premiere) |
| `preview.hardwareDecode` | on | **ROADMAP** | melt/ffmpeg decode flag |

### Diagnostics (the LSP/agent angle — vean-native)
| key | default | status | notes |
|---|---|---|---|
| `diagnostics.<rule>.enabled` | on | **ROADMAP** | ESLint-style per-rule toggle; applied as a post-filter at the surface (engine stays pure) |
| `diagnostics.<rule>.severity` | rule default | **ROADMAP** | treat-as-error / downgrade overrides |
| `diagnostics.autoFixOnSave` | off | **ROADMAP** | apply safe (non-destructive) code-actions on save |

### Backup / safety
| key | default | status | notes |
|---|---|---|---|
| `backup.versioned` | **on** (principle 11) | **ROADMAP** | GFS tiers; the canonical home is `.vean/` + git worktrees vean already leans on |
| `backup.intervalMinutes` | 10 | **ROADMAP** | Resolve 10/8h/5d; Avid 15m; tune to taste |

### Agent / automation (vean-native)
| key | default | status | notes |
|---|---|---|---|
| `actions.confirmDestructive` | on | **READY** | the policy already in force (additive fixes apply freely, deletes gate) — make the threshold tunable |
| `actions.autoApplySafeFixes` | off | **ROADMAP** | auto-apply pure-IR code-actions |

## "First thing editors change" — the priority order

When the consumers land, implement in roughly this order (highest editor value first):

1. **`edit.defaultTransitionDuration`** (`READY`) — universal "set once" pref.
2. **`edit.defaultClipDuration`** — the slideshow pain.
3. **`edit.snapping` + `edit.snapPlayhead` split** — most-used toggle + a differentiator.
4. **`edit.audioScrubbing` (sticky)** — top "turn off", and fix the per-session reset.
5. **`media.defaultScaling = setToFrameSize`** — preserve source res (Premiere's #1).
6. **`backup.versioned` on-by-default** — beat Resolve's most-cursed default.
7. **Proxy-export footgun diagnostic** — not a setting; a guard against shipping low-res.

The pattern holds: every one is a typed registry entry that becomes discoverable
via `vean config list` and tunable via `vean config set` the moment its consumer
exists — so a behavior becomes "just a setting" by registering it.
