# Timeline keyboard and accessibility product contract

Status: **approved by Tejas on 2026-07-11**
Version: `timeline-a11y-v1`
Derived from: `viewer/src/components/TimelineStrip.tsx`, `ClipBlock.tsx`,
`viewer/src/timelineGestures.ts`, and `viewer/src/App.tsx`

## Hypothesis

Vean should expose the existing frame-exact pointer edit model to keyboard and
assistive-technology users without inventing a second edit algebra. Keyboard
operations must resolve to the same registered actions, integer-frame bounds,
diagnostics, undo stack, and persisted `.mlt` truth as pointer gestures.

## Verified current behavior

- Clips are pointer-only `div` elements without focus, role, name, or selection
  semantics.
- Pointer location selects body, head, or tail. Body means move; `Alt` means
  slip; `Cmd/Ctrl` means slide. An edge means trim; `Alt` means ripple trim;
  `Cmd/Ctrl` means roll when a flush neighbor exists.
- All pointer deltas are integer frames and clamp at media, minimum-length, and
  adjacency bounds before calling the edit algebra.
- Existing global keys are `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`, `Cmd/Ctrl+Y`,
  `Cmd/Ctrl+S`, and `B` to split the selected clip at the playhead.
- Undo, redo, save, blade, snapping, and zoom controls are real buttons with
  names. The ruler, tracks, clips, selection, playhead, and drag state do not yet
  expose a coherent accessibility tree.

## Proposed v1 contract

### Semantic structure

- The timeline is a named `region`, not `role="application"`. It contains a
  named edit `toolbar`, a single-select clip `listbox`, a keyboard-help
  description, and one polite live region.
- Tracks are named groups inside the listbox (`Video track V1`, `Audio track
  A1`). Clips are options named from label/resource/composition plus placement,
  duration, source range, track, and blocking diagnostic count.
- Blank gaps and dissolves remain described structural items but are not
  selectable in v1. The playhead exposes its current integer frame and timecode.
- One clip has `tabIndex=0`; all others have `tabIndex=-1`. There is one tab stop
  for clip navigation, not hundreds.

### Browse mode

- Focus and selection move together. This matches a single-select editor and
  avoids a hidden distinction between “focused” and “the clip the edit will
  mutate.”
- `Left` / `Right`: previous / next selectable clip in the same track.
- `Up` / `Down`: selectable clip on the adjacent compatible track whose center
  is nearest the current clip center; ties choose the earlier clip.
- `Home` / `End`: first / last selectable clip in the current track.
- `Cmd/Ctrl+Home` / `Cmd/Ctrl+End`: first / last selectable clip in the timeline.
- `Space`: play/pause. `B`: split the selected clip at the current playhead.
- `N`: toggle snapping. Existing undo/redo/save shortcuts remain global.
- `Enter`: enter clip edit mode. `Escape`: leave the timeline and return focus to
  the timeline's entry option only when invoked from edit mode; otherwise it
  only clears a transient error/help surface.

### Clip edit mode

Edit mode mirrors the pointer's body/head/tail geometry instead of assigning a
large set of unrelated shortcuts.

- On entry, the active target is **body**. `Tab` / `Shift+Tab` cycles body → head
  → tail without leaving the selected clip. The live region announces the
  target and available modifiers.
- `Left` / `Right` changes the active target by 1 integer frame; `Shift` changes
  it by 10. Repeats coalesce into one undo transaction until keyup or a 500 ms
  pause.
- Body + arrows: move. `Alt` + arrows: slip. `Cmd/Ctrl` + arrows: slide.
- Body + `Up` / `Down`: move to the nearest compatible adjacent track while
  preserving the timeline position. There is no implicit cross-kind video ↔
  audio move.
- Head/tail + arrows: trim that edge. `Alt` makes it ripple across all tracks.
  `Cmd/Ctrl` performs a roll only when the selected edge has a flush clip
  neighbor; otherwise no mutation occurs and the limitation is announced.
- Snapping applies to keyboard move/trim using the same candidates as pointer
  editing. Holding `Shift` changes step size, not snapping policy.
- `Enter` commits and returns to browse mode. `Escape` cancels the uncommitted
  edit and restores the exact pre-entry IR. If each key is committed
  incrementally for preview, cancellation applies the grouped inverse.

### Announcements and focus restoration

- Selection: clip name, track, timeline start/end, duration, source in/out, and
  diagnostic count.
- Successful edit: operation, signed frame delta, resulting placement/source
  range, track, and whether snapping/ripple/roll applied.
- Hard bound: announce the media/adjacency/minimum-length boundary once; do not
  emit repeated speech while a held key remains clamped.
- Failure: announce the typed edit error and keep selection/focus on the same
  target. Visible diagnostics and the live announcement derive from the same
  error envelope.
- Undo/redo/save announce completion and dirty state.
- When an edit preserves the clip UUID, focus remains on it. After split, focus
  moves to the resulting segment under the playhead. If a later operation
  removes a clip, focus moves to the nearest following clip, then previous clip,
  then the timeline region.

### Pointer parity requirement

Every keyboard mutation must assert the same action ID, normalized input,
consequence envelope, touched timeline URI, persisted `.mlt` hash/parsed IR,
diagnostics, and inverse as its pointer equivalent. A DOM-only selection or
focus change cannot satisfy an edit scenario.

## Scope boundary

- No alternative renderer, native rewrite, or separate keyboard edit engine.
- No claim that automated DOM semantics prove VoiceOver quality; packaged manual
  VoiceOver assessment remains a release claim.
- No multi-select, range selection, lasso selection, keyframe editing, or
  accessible drag-and-drop in v1.
- Delete/ripple-delete is excluded until its confirmation and focus semantics
  are separately approved.

## Success criteria

- A keyboard-only user can enter the timeline, locate/select clips across
  tracks, move/trim/ripple-trim/roll/slip/slide, blade, undo/redo, save, and exit
  without losing focus.
- Pointer and keyboard paths converge on the same edit actions and independent
  document truth.
- Semantic tests query roles/names/selection; keyboard tests run in a real
  browser; focus, announcements, cleanup, and negative bounds are deterministic.
- H03/H06/H08 scenario ledgers bind the approved version and content hash.

## Approved decision

Tejas approved the recommended bundle without modification:

1. selection follows roving focus;
2. `Enter` opens body/head/tail edit mode instead of globally overloading arrows;
3. adjacent-track navigation/moves use nearest clip center and never cross
   video/audio kinds implicitly;
4. Delete remains outside v1.

The main alternative is direct modifier-only editing in browse mode. It is
faster for expert users but creates arrow-key conflicts, makes head/tail target
state invisible, and is substantially harder to explain through assistive
technology. The recommendation keeps expert modifiers while making the active
edit target explicit.

## Scorecard

### Established

- Pointer editing already has a complete body/head/tail × modifier model and
  frame-exact action mapping.
- The current clip surface is not keyboard- or screen-reader-operable.
- DOM state alone cannot prove a real edit; persisted document truth is required.

### Approved product semantics

- Explicit edit mode versus direct modifier-only editing.
- Selection-follows-focus versus separate focus and selection.
- The adjacent-track nearest-center rule.
- Excluding Delete from v1.

### Disproven

- Treating the timeline as an ARIA `application` is not necessary and would
  suppress standard assistive-technology navigation.
- A list of global shortcuts alone cannot provide equivalent head/tail semantics
  or reliable announcements.

### Open questions after approval

- Exact localized wording for operation and boundary announcements.
- Whether key-repeat coalescing uses keyup only or keyup plus the proposed 500 ms
  idle cutoff; this is an implementation tuning choice, not a semantic change.
