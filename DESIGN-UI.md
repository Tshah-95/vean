# DESIGN-UI.md — vean's visual design system & editor shell

> The intentional layer the viewer never had. This is the plan of record for
> *how vean looks and where things live* — the sibling to `DESIGN-MOVE*.md`
> (which govern behavior). Grounded in a full teardown of `viewer/`, an
> extraction of Carlo's design system, and reference-editor navigation research
> (Resolve / Premiere / FCP / CapCut / Palmier / Descript).

## Decisions (2026-07-01, with Tejas)

Three forks were decided. They are locked; this doc is their expansion.

1. **Adopt Carlo's design system in full** — migrate `viewer/` to **Tailwind v4 +
   shadcn/ui** and port Carlo's **pure-CSS-variable token layer** wholesale. Not
   tokens-only, not incremental-hybrid. The two apps stay a mirror; vean inherits
   Carlo's component vocabulary and its craft. Carlo is `carlo-finance`
   (`components.json` = shadcn new-york + lucide; tokens in `src/app/globals.css`).
2. **Neutral surround, Carlo structure** — Carlo's signature deep-green
   (`#0F1A16`) field tints footage perception, so we **hue-neutralize the field to
   near-black/neutral-gray**, hardest around the monitor (every serious NLE uses a
   neutral surround for color-critical work). Keep *everything else* from Carlo:
   the gold accent `#C7AE7A`, Hanken Grotesk + JetBrains Mono, the 8px radius, the
   8/16/24/40 spacing ladder, mono uppercase eyebrows, "hover lights the row up by
   brightness, not background," and tick-curve motion (no springs).
3. **Left drawer with icon-only tabs + a full-width timeline** *(revised
   2026-07-01 after a Palmier-Pro reference — this supersedes the earlier "vertical
   icon rail" model)*. There is **no vertical icon rail**: navigation is an
   **icon-only tab row atop a left drawer** (Media / Checks / Branch / Jobs / Chat;
   **no "Edit"** — the editor view is the persistent thing, not a nav target). The
   drawer + a right panel occupy a **top band** that shares vertical space with the
   **preview**; the **timeline spans the full width beneath them** (horizontal
   space is the scarce resource in an editor — give it all to the timeline). The
   right panel holds **Inspector / Format / Consequences**; **chat is a drawer
   tab**. Both AI-native editors (Palmier, Descript) converged on
   single-workspace-plus-sidebar, not mode-switching.

## Why (the ethos in one paragraph)

vean should feel like a **calm, data-forward instrument**, not a cockpit. The
same values Carlo runs on transfer: minimal chrome, an excellent command of
spacing, and letting **visualizations, icons, and typography carry the
information** rather than borders and fills. Hover *lights up* a row; it never
slams a highlight. Mono uppercase eyebrows name each surface so the content below
carries only its verdict. Corners are crisp (8px), not soft. Density is *rationed
by spacing*, not by cramming. And vean's own differentiator — **ambient
diagnostics on the timeline** ("type errors for video") — is a first-class visual
citizen, not an afterthought.

## The baseline we're replacing

The viewer today (`viewer/`) is React 19 + Vite with **100% inline `style={{}}`
objects, zero CSS framework, zero token layer.** Colors/spacing/radii are
hand-typed per component (the gold `#c7ae7a` appears in 20+ files). There is one
ignored 8-color const in `viewer/src/components/panels/ui.tsx`. The edit *core*
(timeline gesture algebra, dual WebGL+Remotion compositor, clip-level diagnostic
badges) is genuinely strong and stays; only the *skin and shell* are replaced.

The confusing right rail (`viewer/src/components/Sidebar.tsx`) is a 340px
collapsible strip of six 11px peer tabs — Media / Render / Jobs / Project /
Sessions / Setup — two of them (Jobs, Project) stubs. It reads as six mini-apps
bolted to the edge. It is dissolved and re-homed (below).

## Token layer (ported from Carlo, hue-neutralized)

Lives in a new `viewer/src/styles/tokens.css` as CSS custom properties, bridged to
the shadcn semantic names. Dark-only. Neutral field; Carlo everything-else.

```css
/* Raw palette — NEUTRAL field (Carlo's greens flattened to neutral dark) */
--vean-bg:            #0c0d0f;  /* base field */
--vean-bg-raised:     #131519;  /* cards, panels, rails */
--vean-bg-inset:      #08090a;  /* icon rail + MONITOR SURROUND (darkest, neutral) */
--vean-bg-hover:      #1b1e23;  /* item hover */
--vean-fg-1:          #E6E3DA;  /* ink (kept from Carlo — warm, neutral enough) */
--vean-fg-2:          #9BA39B;  /* muted */
--vean-fg-3:          #6B716A;  /* faint */
--vean-gold:          #C7AE7A;  /* the one accent (already vean's, = --carlo-gold) */
--vean-gold-bright:   #D8C290;
--vean-border:        #262a2e;  /* hairline (neutralized from Carlo #324339) */
--vean-border-bright: #30353a;
--vean-amber:         #d9a050;  /* warnings / soft status */
--vean-amber-hot:     #e8702e;  /* destructive / error */
--vean-red:           #e0574f;  /* playhead / hard signal */

/* Track hues (kept from the current viewer — meaning-bearing, not decorative) */
--vean-track-video:   #6f86a8;
--vean-track-audio:   #57b98a;
--vean-track-graphic: #a98fd6;

/* Radius — crisp, instrument-like (Carlo's 8px base + ramp) */
--radius: 0.5rem;  /* 8px; sm≈4 md≈5 lg=8 xl≈10 2xl≈14 */

/* Motion — the tick curve, NO springs, no overshoot, ever */
--ease-tick: cubic-bezier(0.16, 1, 0.3, 1);
```

- **Spacing ladder (8px grid, 4 meaningful steps):** `s1=8` inside one band ·
  `s2=16` related controls · `s3=24` band separation · `s4=40` major sections.
  Gap size signals structural distance; the page is not uniformly dense.
- **Type:** `--font-sans` = Hanken Grotesk; `--font-mono` = JetBrains Mono (loaded
  the way Carlo does in `layout.tsx`). Weights **400 / 500 only**.
- **Eyebrow:** `font-mono, 11–12px, uppercase, tracking 0.22em, color fg-2/3`. The
  page-/panel-naming register. (Port Carlo's `Eyebrow` component ~as-is.)
- **Numbers:** port Carlo's `formatValue` engine, retargeted from money → **frames
  / timecode / resolution**; drop the variance-damping (finance-specific). All
  numeric UI uses `tabular-nums`.

## The shell (where things live)

*(Revised 2026-07-01. The earlier four-column icon-rail layout is superseded by
the drawer-tabs + full-width-timeline model below — Palmier-shaped.)* A full-width
top bar; a TOP BAND split three ways; a FULL-WIDTH TIMELINE beneath.

```
┌───────────────────────────────────────────────────────────────┐
│ TOP BAR: vean · project ▾    1920×1080 · 24fps    ⚙  Export    │
├──────────────┬──────────────────────────────┬─────────────────┤
│ LEFT DRAWER  │                              │ RIGHT PANEL     │
│ [▣ ! ⑂ ▤ ✦] │      PREVIEW (neutral)       │ INSPECTOR       │
│  icon tabs   │      ──────────────────       │ FORMAT          │
│ media grid / │      transport                │ CONSEQUENCES    │
│ checks /     │                              │                 │
│ branch /     │                              │                 │
│ jobs / chat  │                              │                 │
├──────────────┴──────────────────────────────┴─────────────────┤
│ TIMELINE — full width (taller/cleaner tracks, gutters)         │
└───────────────────────────────────────────────────────────────┘
```

- **Top bar.** Product mark, project switcher, route, resolution/fps/diagnostics
  badges, a **Settings** gear, and **Export**.
- **Left drawer (top band).** An **icon-only tab header** (Media / Checks / Branch
  / Jobs / Chat — active = gold tile, hover-brighten, a dot on Checks when
  non-zero) over a body that renders the active section. This *replaces* the
  vertical rail: nav lives at the top of the drawer so it doesn't spend a
  full-height column on horizontal space. Fixed width for now; the timeline sits
  below it, not beside it. Settings is a drawer view reached via the top-bar gear
  (not a visible tab).
- **Preview (top band, center).** The monitor on a **neutral `--vean-bg-inset`
  surround**, single (FCP-style — vean has no source/program split), with the
  transport strip below it.
- **Right panel (top band).** **Inspector** (selected clip's in/out/length/dials),
  **Format** (resolution / fps / aspect — the resting content), **Consequences**
  (the `preview-op` result before commit — vean's "consequences before a frame
  renders" thesis made visible).
- **Timeline (full-width bottom band).** Spans the entire width below the top band
  (horizontal space is the scarce resource). Phase 3 makes it rich: taller/cleaner
  tracks, richer headers, voice tracks with **waveform + transcript peek**, an A/V
  clip's embedded audio as a **linked companion lane**, and **drag-into-the-gutter
  → new track** above/below.

### Re-homing the old six-tab sidebar

| Old (6 peer tabs, right rail) | New home |
|---|---|
| Media | drawer tab → **Media** |
| Sessions | drawer tab → **Branch** |
| Jobs, Render | drawer tab → **Jobs** |
| Setup, Project | top-bar **gear** → Settings (Project folded in) |
| — | drawer tab → **Chat**; right panel → **Inspector / Format / Consequences** |

Jobs and Project stub panels are deleted, not ported.

### Configurable panels (later)

The shell reads panel sizes from a hardcoded `LayoutConfig` (`shell/layout.ts`)
against a tab registry (`DRAWER_TABS`) — the exact shape it needs to become
**user-editable + persisted to `.vean/vean.db`**. Enabling drag-relocate + resize
later is "make the config editable + add splitters + persist," not a rewrite;
panels are already independent, explicitly-sized flex children. Not built now (per
"hardcode for the time being").

## Component inventory

- **shadcn primitives** (copy from Carlo's `src/components/ui/` as needed): Button,
  Card, Dialog, Popover, Sheet, Select, Tooltip, ScrollArea, plus `cn()` (done).
- **Ported carlo components:** `Eyebrow` (done), the dense-row pattern,
  `Inspectable` (touch-safe hover reveal), the motion keyframes.
- **vean shell (`shell/`):** `AppShell` (top band + full-width timeline), `TopBar`,
  `Drawer` (icon-tab header + body), `RightPanel` (Inspector/Format/Consequences),
  `layout.ts` (tab registry + `LayoutConfig`). *(The Phase-2 `IconRail` /
  `ContentRail` / `Inspector` / `destinations` are removed — superseded by the
  drawer model.)*
- **Panels (`panels/`):** `MediaPanel`, `ChecksPanel` (new), `SessionsPanel`,
  `RenderPanel`, `SetupPanel`, `ChatPanel` (new).
- **Restyled existing (Phase 5):** `TimelineStrip`, `ClipBlock`, `Transport`,
  `PreviewPane`, all panel bodies — off inline hex onto tokens.

## Phased plan (gated, additive-first — never regress the working editor)

**Phase 1 — Foundation (DONE, drive-verified).** Tailwind v4 + shadcn scaffold +
`tokens.css` (neutralized palette, radius, motion) + Hanken/JetBrains fonts +
`cn()`/`Eyebrow`. Additive; the app rendered pixel-identical (theme+utilities
only, no preflight). *Commit `b77f509`.*

**Phase 2 / 2R — The shell (DONE, drive-verified).** `AppShell` = full-width top
bar over a top band (left drawer with **icon-only tabs** · preview · right panel)
and a **full-width timeline** beneath. Re-home the old six tabs; delete the
Jobs/Project stubs; new `ChecksPanel` + `ChatPanel`; global neutral+Hanken flip
(preflight). `layout.ts` scaffolds future relocatable/resizable panels. *(Phase 2
first built a vertical-rail version; **2R** pivoted to the drawer +
full-width-timeline model after the Palmier-Pro reference.)* *Gate met:* drawer
tabs switch; timeline full width; Checks lists diagnostics; zero console errors;
timeline gestures intact.

**Phase 3 — Timeline richness (next).** Taller/cleaner tracks + richer headers;
voice tracks = **waveform + transcript peek**; an A/V clip's embedded audio as a
**linked companion lane**; **drag-into-the-gutter → new track** above/below.
Absorbs the old timeline restyle + adds capability. **Fork to decide here:** the
linked audio is *display-only* (a companion lane that trims/moves with its video)
vs. *modeled* as a real A/V pair in the IR (touches the document model + ops,
since MLT carries A/V as one producer) — default is display-first.

**Phase 4 — Inspector / Consequences / Chat live.** Selected-clip inspector rows;
`preview-op` → live Consequences before commit; chat wired to the edit bridge.
*Gate:* select a clip → inspector populates; `preview-op` → consequences render
before commit.

**Phase 5 — Restyle remaining internals + motion/polish.** TimelineStrip /
ClipBlock / Transport / PreviewPane / panel bodies off inline hex onto tokens;
tick-curve transitions; light-up hover everywhere; eyebrows on every surface;
`formatValue` for timecode; keyboard-focus rings. *Gate:* `grep -r
'#[0-9a-fA-F]\{6\}' viewer/src` returns (near) nothing; a driven before/after clip
shows the calm, data-forward feel.

**Later — configurable panels.** Relocatable + resizable + persisted layout
(structured-for now via `layout.ts`; built when we want it).

## Invariants (don't regress)

- **The timeline gesture algebra and the dual compositor are untouched by the
  reskin** — Phases only re-dress them. A UI change that alters edit behavior is
  out of scope for this doc (that's `DESIGN-MOVE*`/`src/ops`).
- **Neutral around footage.** No hue in the monitor surround band, ever.
- **Drawer tabs swap only the drawer body; they never rearrange the
  monitor/timeline.** The moment a tab click reshuffles the whole screen, we've
  rebuilt Resolve's page-rail.
- **The timeline owns the full width.** Horizontal space is the scarce resource;
  the drawer + right panel live in the top band only, never beside the timeline.
- **One accent.** Gold is the only chromatic accent; status colors (amber/red) are
  signal, not decoration. Track hues are meaning-bearing and stay.
- **Additive-first.** Each phase leaves the app shippable; the reskin never lands
  as one big-bang rewrite.
