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
3. **Left icon rail of destinations** — a thin left rail
   (Edit / Media / Checks / Branch / Jobs) where each item fills a *contextual
   content-rail* (Carlo's 76px icon rail + 224px content rail pattern). The
   **monitor + timeline never swap** — that is the hard line vs Resolve's bottom
   page-rail (mode-switching). The right side becomes **Inspector + Consequences +
   agent chat** (net new — the differentiator). Both AI-native editors (Palmier,
   Descript) converged on single-workspace-plus-sidebar, not mode-switching.

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

Four zones, left → right. (Mockup rendered in the design session; this is its
spec.)

```
┌──────┬───────────┬─────────────────────────────┬────────────┐
│ icon │ content   │  monitor (neutral surround)  │ INSPECTOR  │
│ rail │ rail      │  ───────────────────────────  │ props      │
│ 48–  │ (contextual│  transport (play/tc/scrub)   │ ─────────  │
│ 56px │  ~200px)  │  ───────────────────────────  │ CONSEQUEN. │
│      │           │  TIMELINE (ruler + tracks)   │ preview-op │
│ ●Edit│           │                              │ ─────────  │
│ Media│           │                              │ chat pill  │
│ Checks(2)                                        │            │
│ Branch                                           │            │
│ Jobs │           │                              │            │
│ ⚙ R  │           │                              │            │
└──────┴───────────┴─────────────────────────────┴────────────┘
```

- **Icon rail (destinations, not modes).** ~48–56px. Lucide icons + 11px labels.
  Active = gold icon tile (`bg` gold@15% + gold glyph), inactive muted, hover
  brightens the tile only. Destinations: **Edit** (default workspace), **Media**,
  **Checks** (diagnostics — with a count badge), **Branch** (worktrees/agent
  diffs), **Jobs** (renders + transcription + probes). Bottom-anchored: **Settings**
  + project switcher avatar. Clicking a destination fills the content rail; it does
  **not** rearrange the monitor/timeline.
- **Content rail (contextual, collapsible ~200px).** The active destination's
  content: Media = dense clip rows (kind-dot + name + duration, light-up hover);
  Checks = the diagnostic list; Branch = worktree/session list; Jobs = job rows.
  Re-clicking the active destination collapses it (Carlo behavior); the stage
  reclaims the width.
- **Stage (center).** Monitor on a **neutral `--vean-bg-inset` surround**, single
  (FCP-style — vean has no source/program split and shouldn't invent one). Below:
  the transport strip (play, timecode, scrubber, volume) — split out of today's
  crammed toolbar. Below that: the **timeline** (its own tool row: blade / undo /
  redo / snap / zoom; ruler; track lanes with the existing gesture algebra and
  clip-level diagnostic badges).
- **Inspector + Consequences + Chat (right).** Net new. **Inspector**: the selected
  clip's properties as dense label:value rows (in / out / length / opacity /
  track) — there is *no* inspector today. **Consequences**: the `preview-op`
  result (ripple/overwrite/inverse) shown before commit — vean's "consequences
  before a frame renders" thesis made visible. **Chat**: the agent input pill; the
  agent and the human drive the same ops.

### Re-homing the six old tabs

| Today (6 peer tabs, right rail) | New home |
|---|---|
| Media | icon rail → **Media** (content rail) |
| Sessions | icon rail → **Branch** |
| Jobs, Render | icon rail → **Jobs** |
| Setup, Project | **project switcher** (rail bottom) + **Settings** |
| — | right side → **Inspector / Consequences / Chat** (new) |

Jobs and Project stub panels are deleted, not ported.

## Component inventory to build

- **shadcn primitives** (copy from Carlo's `src/components/ui/`): Button, Card,
  Dialog, Popover, Sheet, Select, Tooltip, ScrollArea, plus `cn()`.
- **Ported carlo components:** `Eyebrow`, the dense-row pattern, `Inspectable`
  (touch-safe hover reveal — reuse for the ± / diagnostic hovers), the motion
  keyframes.
- **New vean shell components:** `AppShell` (the 4-zone grid), `IconRail`,
  `ContentRail` (+ per-destination fills: `MediaRail`, `ChecksRail`, `BranchRail`,
  `JobsRail`), `Inspector`, `ConsequencesPanel`, `ChatPanel`.
- **Restyled existing:** `TimelineStrip`, `ClipBlock`, `Transport`, `PreviewPane`,
  `Header` — driven off tokens, no inline hex.

## Phased plan (gated, additive-first — never regress the working editor)

**Phase 1 — Foundation (additive, zero UI change).** Add Tailwind v4 + the
shadcn scaffold to `viewer/`; add `tokens.css` (neutralized palette, radius,
motion) + font loading; add `cn()` + `Eyebrow` + a couple primitives. Existing
inline-styled UI keeps rendering untouched. *Gate:* `viewer` builds; `bun run
doctor` green; a `drive` screenshot is pixel-identical to today (nothing adopted
the tokens yet).

**Phase 2 — Shell skeleton.** Build `AppShell` (icon rail + content rail + stage +
inspector slot) as the new layout wrapping the *existing* PreviewPane / Transport
/ TimelineStrip. Wire the destinations; re-home the six tabs into rail fills;
delete the Jobs/Project stubs. *Gate:* `drive` screenshot matches the mockup
zones; diagnostics still push to the Checks badge; timeline gestures unaffected.

**Phase 3 — Inspector + Consequences + Chat (net new).** Selected-clip inspector
rows; `preview-op` → Consequences panel; the chat pill wired to the edit bridge.
*Gate:* select a clip → inspector populates; `preview-op` → consequences render
before commit.

**Phase 4 — Restyle surfaces onto tokens.** Move TimelineStrip / ClipBlock /
Transport / PreviewPane / Header / all rail fills off inline hex onto the token
layer + shadcn primitives. *Gate:* `grep -r '#[0-9a-fA-F]\{6\}' viewer/src` returns
(near) nothing; `drive` parity; corpus/render gates untouched (UI-only change).

**Phase 5 — Polish & motion.** Tick-curve transitions on rail/panel/collapse;
the light-up hover language everywhere; eyebrows on every surface; `formatValue`
for timecode; keyboard-focus rings (an accessibility gap today). *Gate:* a driven
before/after clip demonstrates the calm, data-forward feel.

## Invariants (don't regress)

- **The timeline gesture algebra and the dual compositor are untouched by the
  reskin** — Phases only re-dress them. A UI change that alters edit behavior is
  out of scope for this doc (that's `DESIGN-MOVE*`/`src/ops`).
- **Neutral around footage.** No hue in the monitor surround band, ever.
- **Destinations fill the content rail; they never swap the monitor/timeline.** The
  moment a rail click rearranges the whole screen, we've rebuilt Resolve.
- **One accent.** Gold is the only chromatic accent; status colors (amber/red) are
  signal, not decoration. Track hues are meaning-bearing and stay.
- **Additive-first.** Each phase leaves the app shippable; the reskin never lands
  as one big-bang rewrite.
