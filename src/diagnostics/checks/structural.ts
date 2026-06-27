// Structural diagnostics — the "type-checker" rules computed from the IR graph
// alone (the ROADMAP Move-1 Tier-1 STATIC set, structural subset). These catch an
// UNSERIALIZABLE or silently-mis-rendering timeline before melt runs, reading only
// the typed document — no I/O, no mutation. The rules, by code:
//
//   in-out-beyond-source / in-before-source-start  a clip window outside its source
//   keyframe-outside-clip                          an animated keyframe past the trim
//   orphaned-filter                                a filter that attaches to nothing
//   dissolve-too-long                              a same-track dissolve > a neighbour
//   dissolve-unanchored / dissolve-half            a dangling / half-anchored dissolve
//   clip-overconsumed                              a clip too short for its dissolves
//   transition-track-out-of-range                  a field transition off a real track
//   transition-self-composite                      a field transition onto its own track
//   transition-inverted-window                     a field transition with in > out
//   transition-no-overlap                          a field transition over empty content
//   missing-media-file                             a producer→file ref absent ON DISK
//
// Every check is CONSERVATIVE: it fires ONLY on a genuinely broken state and is
// SILENT on every valid one (the no-false-positive gate — the clean corpus emits
// zero, whole-engine AND per-checker, in tests/diagnostics-harness.test.ts).
//
// ── On the no-I/O invariant (AGENTS.md Hard boundary #3) ────────────────────────
// `missing-media-file` is the one rule whose ground truth lives on the FILESYSTEM
// (does the path exist?), which the pure engine forbids. It is therefore written as
// a PURE function over an INJECTED probe: `structuralWith({ fileExists })` returns a
// checker that uses the probe; the default registry export `structural` injects NO
// probe, so the on-disk rule is a no-op on the pure path (and the corpus harness
// stays I/O-free + machine-independent — corpus resources point at paths that may
// only exist on one machine). A host WITH I/O (the driver / the LSP/CLI host) builds
// the probing variant and merges its findings through the SAME Diagnostic type —
// the rule lives here once, the I/O lives at the edge. (Mirrors media.ts's deferral
// of the same concern to the driver; this is the structural facet, opt-in.)
//
// FINALIZED SIGNATURE. The exported `structural: Checker` is the stable contract the
// registry consumes; new in-IR rules land here additively, each held to the same
// zero-false-positive bar.
import { FADE_IN_SERVICE, FADE_OUT_SERVICE } from "../../ir/builder";
import { isAnimated, parseAnim } from "../../ir/keyframes";
import type { Clip, Item, Timeline, Track } from "../../ir/types";
import { type Diagnostic, type DiagnosticInput, diag } from "../types";

/** Played length of a clip (inclusive window). */
function playtime(c: Clip): number {
  return c.out - c.in + 1;
}

/** The played length an item occupies on a track's timeline: a clip's window, a
 *  blank's length; a dissolve consumes nothing of its own (it overlaps neighbours). */
function itemSpan(it: Item): number {
  if (it.kind === "clip") return playtime(it);
  if (it.kind === "blank") return it.length;
  return 0; // dissolve: overlap, no own span
}

/** A clip is a synthesized GENERATOR (a solid color or other infinite producer)
 *  rather than a finite media FILE. Generators have no on-disk source and no source
 *  length to exceed — the file/length rules skip them. `service: "color"` is the
 *  builder's solid; a `resource` that is a color spec (`#AARRGGBB` / `#RRGGBB`) is
 *  the same thing parsed back. */
function isGenerator(clip: Clip): boolean {
  if (clip.service === "color") return true;
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(clip.resource.trim());
}

// ─── A clip window must lie within its source ──────────────────────────────────
/** A media clip's window must lie within its source: `out` < `length`, `in` ≥ 0. A
 *  `length`-less clip (melt probes the file) can't be checked I/O-free, so it's
 *  skipped. A generator's `length` is its own played count, so `out < length` holds
 *  by construction — only a corrupt state trips this. */
function checkInOutBeyondSource(clip: Clip, track: Track): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  if (clip.length != null && clip.out >= clip.length) {
    out.push(
      diag({
        code: "in-out-beyond-source",
        severity: "error",
        message: `clip "${clip.id}" out-point ${clip.out} is at/beyond its source length ${clip.length} (plays past the end of the media)`,
        location: { clip: clip.id, track: track.id },
        fix: `trim the out-point to at most ${clip.length - 1}`,
        data: { out: clip.out, length: clip.length },
      }),
    );
  }
  if (clip.in < 0) {
    out.push(
      diag({
        code: "in-before-source-start",
        severity: "error",
        message: `clip "${clip.id}" in-point ${clip.in} is before source frame 0`,
        location: { clip: clip.id, track: track.id },
        fix: "set the in-point to 0 or later",
        data: { in: clip.in },
      }),
    );
  }
  return out;
}

// ─── Keyframes inside the played window ─────────────────────────────────────────
/** An animated escape-hatch filter's keyframes must include at least ONE inside the
 *  clip's played window `[0, playtime-1]`. The defect this catches is an animation
 *  whose keyframes ALL fall PAST the window: melt then clamps to the first
 *  keyframe's value across the whole clip, so the motion the author authored renders
 *  as a flat constant — the intent is silently lost (verified against melt: a
 *  `100=0;200=1` ramp on a 50-frame clip renders dead-flat at 0).
 *
 *  Crucially, a keyframe past the window is NOT a defect on its own. When an
 *  IN-window keyframe anchors the animation, an out-of-window keyframe is a valid
 *  interpolation TARGET — melt paints a live gradient toward it (verified:
 *  `0=0;200=1` on a 50-frame clip ramps 0→~0.245, it renders). This is exactly the
 *  state the SPLIT op produces BY DESIGN: it keeps the HEAD half's full-span ramp
 *  verbatim (DESIGN-MOVE1.md §3 / splitEntryAt) so the in-window gradient still
 *  tends toward the real target. Flagging that would turn a routine split of any
 *  clip carrying a full-span escape-hatch ramp into a false-positive warning. So we
 *  fire ONLY when NO keyframe lands in-window.
 *
 *  Effective frames are resolved through the canonical keyframe engine
 *  (`parseAnim` + the model's resolved/negative frames), NOT an ad-hoc regex: a
 *  TIMECODE keyframe (`00:00:10.000=1`) resolves to its true frame via `fps`
 *  (the old regex stripped it at the first `:` and read frame 0, masking an
 *  all-past-window timecode animation). A NEGATIVE/relative keyframe anchors to the
 *  source end (`-1` → length-1), which is in-window by construction, so it counts as
 *  an in-window anchor. Fade SENTINELS carry no keyframe string and are skipped. */
function checkKeyframesOutsideBounds(
  clip: Clip,
  track: Track,
  fps: [number, number],
): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  const len = playtime(clip);
  const windowEnd = len - 1;
  clip.filters.forEach((f, fi) => {
    if (f.service === FADE_IN_SERVICE || f.service === FADE_OUT_SERVICE) return; // sentinel
    for (const [key, value] of Object.entries(f.properties)) {
      const s = String(value);
      if (!isAnimated(s)) continue;
      // Resolve effective frames through the model (timecodes via fps, negatives
      // against `length`). A negative/relative keyframe anchors to the source end,
      // which is in-window — treat it as an in-window anchor (it cannot be "past").
      const model = parseAnim(s, { fps, length: clip.length });
      const kfs = model.keyframes;
      if (kfs.length === 0) continue;
      let anyInWindow = false;
      let maxPast = Number.NEGATIVE_INFINITY;
      for (const kf of kfs) {
        if (kf.negative) {
          // Anchors to the source end (≤ length-1) — an in-window anchor.
          anyInWindow = true;
          continue;
        }
        const frame = kf.frame;
        if (frame <= windowEnd) anyInWindow = true;
        else if (frame > maxPast) maxPast = frame;
      }
      // Live as long as SOMETHING renders in-window; only an animation entirely past
      // the window is dead (a flat clamp). One diagnostic per property is enough.
      if (!anyInWindow && Number.isFinite(maxPast)) {
        out.push(
          diag({
            code: "keyframe-outside-clip",
            severity: "warning",
            message: `clip "${clip.id}" filter ${f.service}.${key} has all of its keyframes past the clip's played window [0, ${windowEnd}] (first past-window keyframe ${kfs.find((k) => !k.negative && k.frame > windowEnd)?.frame ?? maxPast}) — none render, so melt clamps to a flat value and the animation is lost (a trim/split likely didn't re-base the window)`,
            location: { clip: clip.id, track: track.id, filter: fi },
            fix: "re-base the keyframes into the clip's window, or drop the dead animation",
            data: { windowEnd, lastFrame: maxPast },
          }),
        );
      }
    }
  });
  return out;
}

// ─── Orphaned filters ───────────────────────────────────────────────────────────
/** A clip filter with no service name is orphaned (it attaches to nothing melt can
 *  resolve). The IR Zod schema already requires `service.min(1)`, so this only trips
 *  a hand-built state that bypassed validation — kept as a cheap structural guard
 *  for the LSP path (which may hold an in-progress, not-yet-valid doc). */
function checkOrphanedFilters(clip: Clip, track: Track): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  clip.filters.forEach((f, fi) => {
    if (!f.service || f.service.trim() === "") {
      out.push(
        diag({
          code: "orphaned-filter",
          severity: "error",
          message: `clip "${clip.id}" has a filter at index ${fi} with no service name`,
          location: { clip: clip.id, track: track.id, filter: fi },
          fix: "give the filter an mlt_service or remove it",
        }),
      );
    }
  });
  return out;
}

// ─── Same-track dissolve: anchoring + overlap ───────────────────────────────────
/** A same-track dissolve must (a) sit BETWEEN two clips (a dangling/half marker is
 *  unrenderable), (b) be no longer than EITHER neighbour clip (insufficient overlap),
 *  and the clip it shares with adjacent dissolves must be long enough for BOTH. The
 *  serializer's `validateTrack` throws on each of these; surfacing them as diagnostics
 *  lets the LSP show the defect instead of only failing at serialize time. */
function checkDissolves(track: Track): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  const items = track.items;
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Item;
    if (it.kind !== "dissolve") continue;
    const prev = items[i - 1];
    const next = items[i + 1];
    const prevClip = prev?.kind === "clip";
    const nextClip = next?.kind === "clip";

    // (a) Anchoring. A dissolve with NEITHER neighbour a clip is fully dangling; one
    //     missing side is a HALF dissolve (a marker at a cut with nothing to fade).
    if (!prevClip && !nextClip) {
      out.push(
        diag({
          code: "dissolve-unanchored",
          severity: "error",
          message: `a ${it.frames}-frame dissolve on track "${track.id}" is not between two clips (nothing to cross-fade)`,
          location: { track: track.id },
          fix: "a dissolve must sit directly between two clips",
        }),
      );
      continue;
    }
    if (!prevClip || !nextClip) {
      const side = prevClip ? "trailing" : "leading";
      out.push(
        diag({
          code: "dissolve-half",
          severity: "error",
          message: `a ${it.frames}-frame dissolve on track "${track.id}" is missing its ${side} clip — it is half-anchored and cannot render`,
          location: { track: track.id },
          fix: "place a clip on the dissolve's open side, or remove the dissolve",
          data: { missingSide: side },
        }),
      );
      continue;
    }

    // (b) Overlap. The dissolve can't be longer than either clip it cross-fades.
    const prevLen = itemSpan(prev as Item);
    const nextLen = itemSpan(next as Item);
    const shortest = Math.min(prevLen, nextLen);
    if (it.frames > prevLen || it.frames > nextLen) {
      out.push(
        diag({
          code: "dissolve-too-long",
          severity: "error",
          message: `a ${it.frames}-frame dissolve on track "${track.id}" exceeds a neighbour clip (${shortest} frames) — there isn't enough overlap to render it`,
          location: { track: track.id },
          fix: `shorten the dissolve to at most ${shortest} frames`,
          data: { dissolveFrames: it.frames, shortestNeighbour: shortest },
        }),
      );
    }
  }

  // (c) A clip flanked by two dissolves must be long enough to feed BOTH overlaps;
  //     otherwise the two cross-fades over-consume it (the serializer's second
  //     validateTrack pass). This is the same-track "overlap" defect.
  for (let i = 0; i < items.length; i++) {
    const it = items[i] as Item;
    if (it.kind !== "clip") continue;
    const before = items[i - 1];
    const after = items[i + 1];
    const consumed =
      (before?.kind === "dissolve" ? before.frames : 0) +
      (after?.kind === "dissolve" ? after.frames : 0);
    const span = playtime(it);
    if (consumed > span) {
      out.push(
        diag({
          code: "clip-overconsumed",
          severity: "error",
          message: `clip "${it.id}" (${span} frames) on track "${track.id}" is too short for its adjacent dissolves (${consumed} frames total) — the cross-fades overlap`,
          location: { clip: it.id, track: track.id },
          fix: `lengthen the clip to at least ${consumed} frames, or shorten its dissolves`,
          data: { clipFrames: span, consumed },
        }),
      );
    }
  }
  return out;
}

// ─── Cross-track field transitions: track refs + overlap ────────────────────────
/** The total played length of a track (clips + blanks; dissolves overlap, so they
 *  add nothing). The end of the last content frame is `len - 1`. */
function trackPlayedLength(track: Track): number {
  return track.items.reduce((acc, it) => acc + itemSpan(it), 0);
}

/** Where a transition's `aTrack`/`bTrack` index lands in IR-track space. The main
 *  tractor emits the Shotcut BACKGROUND producer at index 0, then the IR tracks in
 *  `[...video, ...audio]` order at indices 1..N (serialize.ts: "Background is index
 *  0; playlists are 1..N"). So index 0 is the (always full-length) background — not
 *  an IR track — and index `i ≥ 1` maps to `irTracks[i - 1]`. Returns `"background"`
 *  for 0, the Track for a valid 1..N, or `"out-of-range"`. */
function resolveTransitionTrack(
  index: number,
  irTracks: readonly Track[],
): Track | "background" | "out-of-range" {
  if (index === 0) return "background";
  const t = irTracks[index - 1];
  return t ?? "out-of-range";
}

/** Field (cross-track) transitions: a service compositing `bTrack` over `aTrack`
 *  over a TIMELINE window `[in, out]`. We fire ONLY on a transition that genuinely
 *  cannot composite, and stay silent on Shotcut's routine auto-stamps:
 *
 *   • transition-track-out-of-range — an a/b index past the real tracks (references
 *     a track that doesn't exist; the composite is unresolvable).
 *   • transition-self-composite — aTrack === bTrack (compositing a track over itself
 *     is a no-op/degenerate reference).
 *   • transition-inverted-window — in > out (an empty/backwards window).
 *   • transition-no-overlap — the window `[in, out]` does NOT intersect the played
 *     CONTENT of one of its REAL (non-background) tracks at all, so there is nothing
 *     on that track to blend over the window. The background (index 0) always spans
 *     the project, so a transition touching it has overlap on that side by
 *     construction (this is why Shotcut's always-active `[0,0]` mix/blend stamps
 *     onto the background never fire). A window that merely EXTENDS PAST content
 *     (Shotcut writes these) still INTERSECTS it, so it is fine — we require a
 *     genuine empty intersection, the only sound "insufficient overlap" bar.
 */
function checkFieldTransitions(state: Timeline): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  const irTracks: Track[] = [...state.tracks.video, ...state.tracks.audio];
  state.transitions.forEach((t, ti) => {
    const a = resolveTransitionTrack(t.aTrack, irTracks);
    const b = resolveTransitionTrack(t.bTrack, irTracks);

    // Out-of-range reference (either side).
    for (const [role, ref, idx] of [["a", a, t.aTrack] as const, ["b", b, t.bTrack] as const]) {
      if (ref === "out-of-range") {
        out.push(
          diag({
            code: "transition-track-out-of-range",
            severity: "error",
            message: `transition #${ti} (${t.service}) references ${role}_track ${idx}, which is not a real track (the timeline has ${irTracks.length} track${irTracks.length === 1 ? "" : "s"} at indices 1..${irTracks.length})`,
            location: { transition: ti },
            fix: `point the transition at an existing track (1..${irTracks.length})`,
            data: { side: role, index: idx, trackCount: irTracks.length },
          }),
        );
      }
    }
    // If a side is unresolvable, the rest can't be reasoned about soundly.
    if (a === "out-of-range" || b === "out-of-range") return;

    // Self-composite (a track over itself).
    if (t.aTrack === t.bTrack) {
      out.push(
        diag({
          code: "transition-self-composite",
          severity: "error",
          message: `transition #${ti} (${t.service}) composites track index ${t.aTrack} onto itself — a/b must be two different tracks`,
          location: { transition: ti },
          fix: "set a_track and b_track to two different tracks",
          data: { index: t.aTrack },
        }),
      );
      return;
    }

    // Inverted/empty window.
    if (t.in > t.out) {
      out.push(
        diag({
          code: "transition-inverted-window",
          severity: "error",
          message: `transition #${ti} (${t.service}) has an inverted window in=${t.in} > out=${t.out} (it covers no frames)`,
          location: { transition: ti, range: { from: t.out, to: t.in } },
          fix: "set in ≤ out",
          data: { in: t.in, out: t.out },
        }),
      );
      return;
    }

    // No-overlap: the window must intersect the CONTENT of each REAL referenced
    // track. The background (index 0) spans the project, so it's overlap by
    // construction — only a real IR track can be empty over the window. Content
    // occupies timeline frames [0, len-1]; the window is [in, out]. They intersect
    // iff in ≤ len-1 (window starts before content ends) and out ≥ 0 (always true
    // for non-negative frames). An empty intersection means there is nothing on that
    // track to composite over the window.
    for (const [role, ref] of [["a", a] as const, ["b", b] as const]) {
      if (ref === "background") continue; // always-covering
      const len = trackPlayedLength(ref);
      const intersects = len > 0 && t.in <= len - 1;
      if (!intersects) {
        out.push(
          diag({
            code: "transition-no-overlap",
            severity: "error",
            message: `transition #${ti} (${t.service}) covers frames [${t.in}, ${t.out}] but its ${role}_track "${ref.id}" has no content there (content ends at frame ${Math.max(len - 1, 0)}) — nothing to composite`,
            location: { transition: ti, track: ref.id, range: { from: t.in, to: t.out } },
            fix: "move the transition over the overlap of both tracks' content, or shorten it",
            data: { side: role, windowStart: t.in, contentEnd: Math.max(len - 1, 0) },
          }),
        );
      }
    }
  });
  return out;
}

// ─── Dangling producer→file reference (missing ON DISK) — opt-in, I/O-injected ──
/** A probe answering "does this resource exist on disk?". The pure engine has NO
 *  I/O, so the default `structural` checker passes NO probe and this rule is a no-op;
 *  a host WITH I/O (the driver / LSP/CLI host) builds `structuralWith({ fileExists })`
 *  to enable it. A resource is resolved relative to `root` (the IR stores file paths
 *  root-relative; absolute paths pass through). */
export type FileProbe = {
  /** True iff `path` (already resolved) exists on disk. */
  fileExists: (path: string) => boolean;
  /** Project root for resolving root-relative resources (default: none → only
   *  absolute paths are probed). */
  root?: string;
};

function resolveResource(resource: string, root?: string): string {
  if (resource.startsWith("/")) return resource;
  if (root == null) return resource;
  return root.endsWith("/") ? `${root}${resource}` : `${root}/${resource}`;
}

/** A media (file-backed) clip whose `resource` path is absent on disk references
 *  media that won't load — melt fails (or renders black). Generators (color/infinite)
 *  have no file, so they're skipped. Only runs when a `FileProbe` is injected. */
function checkMissingMediaFile(
  clip: Clip,
  track: Track,
  probe: FileProbe | undefined,
): DiagnosticInput[] {
  if (!probe) return []; // pure path: no I/O, no-op
  if (isGenerator(clip)) return []; // no file to check
  if (!clip.resource || clip.resource.trim() === "") return []; // empty ref is media.ts's
  const resolved = resolveResource(clip.resource, probe.root);
  if (probe.fileExists(resolved)) return [];
  return [
    diag({
      code: "missing-media-file",
      severity: "error",
      message: `clip "${clip.id}" references media that is missing on disk: ${clip.resource}`,
      location: { clip: clip.id, track: track.id },
      fix: "relink the clip to an existing file, or remove it",
      data: { resource: clip.resource, resolved },
    }),
  ];
}

// ─── The checker (composed from the rules) ──────────────────────────────────────
/** Build a structural checker. `probe` (optional, I/O-bearing) enables the on-disk
 *  `missing-media-file` rule; omit it for the PURE engine path (the registry uses
 *  this — no I/O, no machine dependence). */
export function structuralWith(probe?: FileProbe): (state: Timeline) => Diagnostic[] {
  return (state: Timeline): Diagnostic[] => {
    const out: DiagnosticInput[] = [];
    const fps = state.profile.fps;
    for (const track of [...state.tracks.video, ...state.tracks.audio]) {
      out.push(...checkDissolves(track));
      for (const it of track.items) {
        if (it.kind !== "clip") continue;
        out.push(...checkInOutBeyondSource(it, track));
        out.push(...checkKeyframesOutsideBounds(it, track, fps));
        out.push(...checkOrphanedFilters(it, track));
        out.push(...checkMissingMediaFile(it, track, probe));
      }
    }
    out.push(...checkFieldTransitions(state));
    // The registry stamps `source`; attach a placeholder so the type is a full
    // Diagnostic for the registry to finalize.
    return out.map((d) => ({ ...d, source: "structural" }));
  };
}

/** The structural checker: the PURE (no-I/O) registry contract. Runs every in-IR
 *  structural rule; the on-disk `missing-media-file` rule is silent here (it needs a
 *  `FileProbe` only a host with I/O can supply — see `structuralWith`). */
export const structural: (state: Timeline) => Diagnostic[] = structuralWith();
