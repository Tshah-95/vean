// A/V LINK diagnostics — the rules that reason over vean's TYPED link (`Clip.link`)
// and STREAM SELECTORS (`Clip.streams`), the two orthogonal concepts Shotcut
// entangles in a loose `shotcut:group` int (see DESIGN-UI.md §"Appendix: modeling
// linked A/V" + artifacts/research/shotcut-detach-audio-2026-07-01.md). Where
// Shotcut's trim/split/ripple are NOT group-aware and silently desync a detached
// A/V pair, vean's whole point is to CATCH that class of bug. These are the checks
// that unlock it, computed from the IR graph alone:
//
//   dangling-link             a clip's link references a partner clip that is GONE
//   av-desync                 a linked A/V pair whose in/out or timeline position
//                             drifted apart (a one-sided trim/split/ripple)
//   redundant-stream-selector audio turned OFF (astream/audio_index = -1) on a clip
//                             that still carries an audio-only filter that now
//                             operates on nothing (the in-IR slice; the "the file
//                             has no audio" slice needs a probe and lives in
//                             src/diagnostics/probe.ts)
//   ripple-link-hazard        a linked pair that is IN SYNC now but spans two tracks,
//                             so a per-track ripple would shift one member and not
//                             its partner (a latent desync — warn to ripple both)
//
// Pure: reads the IR, returns Diagnostics, no I/O, no mutation (AGENTS.md Hard
// boundary #3). CONSERVATIVE to the bone (the no-false-positive gate): a document
// with NO links / NO stream selectors — the entire clean corpus, which carries
// neither field — emits ZERO diagnostics by construction (every rule's first guard
// is "this clip is linked / has a selector"). A WELL-FORMED linked pair (the state a
// clean detach produces: same in/out, same position, both members present) is
// silent too — each rule fires only on the DRIFT, not on the link's existence.
//
// FINALIZED SIGNATURE. `link: Checker` is the stable registry contract; new in-IR
// link rules land here additively, each held to the same zero-false-positive bar.
import { FADE_IN_SERVICE, FADE_OUT_SERVICE } from "../../ir/builder";
import { type Clip, type Item, type Timeline, type Track, hasAudio } from "../../ir/types";
import { type Diagnostic, type DiagnosticInput, diag } from "../types";

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Played length of a clip (inclusive window). */
function playtime(c: Clip): number {
  return c.out - c.in + 1;
}

/** The played length an item occupies on a track's timeline: a clip's window, a
 *  blank's length; a same-track dissolve consumes nothing of its own (it overlaps
 *  its neighbours, so it adds no independent span). Mirrors structural.ts's
 *  `itemSpan` — the coordinate space the positional rules below walk. */
function itemSpan(it: Item): number {
  if (it.kind === "clip") return playtime(it);
  if (it.kind === "blank") return it.length;
  return 0; // dissolve: shared overlap, no own span
}

/** Frames from a track's start to the start of `items[index]` (its timeline
 *  position). Sums the spans of everything before it. */
function startOf(items: readonly Item[], index: number): number {
  let n = 0;
  for (let i = 0; i < index && i < items.length; i++) n += itemSpan(items[i] as Item);
  return n;
}

/** Everything a rule needs about a located, LINKED clip: the clip, its track, and
 *  its timeline start position. */
type LinkedLocation = {
  clip: Clip;
  track: Track;
  /** Frames from the track start to this clip's start. */
  position: number;
};

/** Index every clip in the timeline, plus its track and computed start position, in
 *  a single walk. Deterministic order (video tracks then audio tracks, document
 *  order within a track). */
function indexClips(state: Timeline): LinkedLocation[] {
  const out: LinkedLocation[] = [];
  for (const track of [...state.tracks.video, ...state.tracks.audio]) {
    for (let ii = 0; ii < track.items.length; ii++) {
      const it = track.items[ii] as Item;
      if (it.kind !== "clip") continue;
      out.push({ clip: it, track, position: startOf(track.items, ii) });
    }
  }
  return out;
}

/** The set of every clip id present in the timeline (for dangling-partner lookup). */
function allClipIds(located: readonly LinkedLocation[]): Set<string> {
  const s = new Set<string>();
  for (const l of located) s.add(l.clip.id);
  return s;
}

// ─── 1. dangling-link — a link references a partner clip that no longer exists ──
//
// A `Clip.link.partnerIds` names the OTHER members of the link group. When a
// partner clip is DELETED (a lift, a ripple-delete, an unlink that dropped only one
// side) but this clip still carries the stale reference, the link is dangling: an
// agent that reads it and tries to "move both" or "reattach" will look up an id that
// isn't there. Shotcut's loose int can't even detect this (a group is reconstructed
// by scanning for the int, so a deleted member is just "not in the scan"); vean's
// TYPED link names the partner explicitly, so a missing partner is a concrete,
// reportable defect. This is an ERROR — the link is structurally broken.

function checkDanglingLink(l: LinkedLocation, ids: ReadonlySet<string>): DiagnosticInput[] {
  const link = l.clip.link;
  if (link == null) return []; // unlinked — nothing to dangle
  const missing = link.partnerIds.filter((pid) => !ids.has(pid));
  if (missing.length === 0) return [];
  return [
    diag({
      code: "dangling-link",
      severity: "error",
      message: `clip "${l.clip.id}" is linked (group "${link.id}") to partner${missing.length === 1 ? "" : "s"} ${missing.map((m) => `"${m}"`).join(", ")} that no longer exist${missing.length === 1 ? "s" : ""} in the timeline — the link is broken (a partner was deleted without unlinking)`,
      location: { clip: l.clip.id, track: l.track.id },
      fix: "unlink this clip, or restore/relink the missing partner",
      data: { linkId: link.id, missing: missing.join(",") },
    }),
  ];
}

// ─── 2. av-desync — a linked A/V pair whose windows or positions drifted ────────
//
// A detach starts the two halves ALIGNED: same source window (`in`/`out`), same
// played length, same timeline position — the audio at source-frame N sits under
// the video at source-frame N. A ONE-SIDED trim/split/ripple (which Shotcut allows,
// because its ops aren't group-aware) moves one half's window or position and not
// the other's, so lip-sync drifts by exactly that delta. With the TYPED link we
// KNOW the two are a pair (no shared-resource inference needed — that heuristic
// lives in sync.ts's `av-asymmetric-trim` for links the IR doesn't carry). We fire
// on the drift, per unordered pair, ONCE (anchored on the video side when roles
// distinguish them), and stay silent on an aligned pair.
//
// The comparison is by role where roles are present: the pair is (video-role,
// audio-role). We compare the source WINDOW (`in`/`out`) and the timeline POSITION.
// A difference in EITHER is a desync (a head-trim shifts `in`; a tail-trim shifts
// `out`; a move shifts `position`).

/** Group linked clips by `link.id`. Only groups of ≥2 present members are real
 *  links; a solo carrier (its partners all dangling) is handled by dangling-link. */
function groupByLinkId(located: readonly LinkedLocation[]): Map<string, LinkedLocation[]> {
  const groups = new Map<string, LinkedLocation[]>();
  for (const l of located) {
    const id = l.clip.link?.id;
    if (id == null) continue;
    const g = groups.get(id) ?? [];
    g.push(l);
    groups.set(id, g);
  }
  return groups;
}

function checkAvDesync(group: readonly LinkedLocation[]): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  // Compare every unordered pair within the group. For the common A/V pair (2
  // members) that's one comparison; a larger group compares each pair (a group is a
  // set of clips meant to move as one, so any two drifting is a desync).
  for (let i = 0; i < group.length; i++) {
    const a = group[i];
    if (a == null) continue;
    for (let j = i + 1; j < group.length; j++) {
      const b = group[j];
      if (b == null) continue;
      const inDelta = b.clip.in - a.clip.in;
      const outDelta = b.clip.out - a.clip.out;
      const posDelta = b.position - a.position;
      if (inDelta === 0 && outDelta === 0 && posDelta === 0) continue; // aligned — correct

      // Anchor on the VIDEO-role member when the roles distinguish the pair, so the
      // primary location is the picture (what a UI selects); otherwise anchor on the
      // first by document order. The other member is the related "see also".
      const aIsVideo = a.clip.link?.role === "video";
      const [primary, secondary] = aIsVideo || b.clip.link?.role !== "video" ? [a, b] : [b, a];
      const pd =
        primary === a
          ? { inDelta, outDelta, posDelta }
          : {
              inDelta: -inDelta,
              outDelta: -outDelta,
              posDelta: -posDelta,
            };

      const drift: string[] = [];
      if (pd.posDelta !== 0) {
        drift.push(
          `the linked partner starts ${Math.abs(pd.posDelta)} frame(s) ${pd.posDelta > 0 ? "later" : "earlier"} on the timeline`,
        );
      }
      if (pd.inDelta !== 0) {
        drift.push(`its source in-point is off by ${Math.abs(pd.inDelta)} frame(s)`);
      }
      if (pd.outDelta !== 0) {
        drift.push(`its source out-point is off by ${Math.abs(pd.outDelta)} frame(s)`);
      }

      out.push(
        diag({
          code: "av-desync",
          severity: "warning",
          message: `linked clips "${primary.clip.id}" and "${secondary.clip.id}" (group "${primary.clip.link?.id}") have drifted out of sync — ${drift.join("; ")}, so audio and video no longer line up`,
          location: { clip: primary.clip.id, track: primary.track.id },
          related: [
            {
              location: { clip: secondary.clip.id, track: secondary.track.id },
              message: "its linked partner",
            },
          ],
          fix: "trim/move both linked clips by the same amount, or reattach them",
          data: {
            linkId: primary.clip.link?.id ?? "",
            inDelta: pd.inDelta,
            outDelta: pd.outDelta,
            posDelta: pd.posDelta,
          },
        }),
      );
    }
  }
  return out;
}

// ─── 3. redundant-stream-selector (in-IR slice) — audio off, audio filter still on ─
//
// The video-only half of a detach turns audio OFF (`astream=-1` / `audio_index=-1`,
// so `hasAudio(clip)` is false). If that video-only clip STILL carries an audio-only
// filter (a `volume`/`gain`/pan/audio-fade), the filter now operates on a stream
// that isn't decoded — it does nothing, wasted work, and a sign the detach left an
// orphaned filter behind (Shotcut detaches audio filters onto the audio half; a
// hand-built or mis-detached state can leave one on the video half). We fire on that
// dead audio filter. The COMPLEMENTARY "file has no audio at all" slice — a selector
// disabling a stream the media never had — needs the source's stream count (a
// probe), so it lives as a pure rule in src/diagnostics/probe.ts, same as the fps
// rule. Here we judge only what the IR carries: audio is off (a fact `hasAudio`
// derives from the selectors) AND an audio-domain filter is present.
//
// Conservative: a clip WITH audio (no selector, or audio on) is skipped entirely; an
// audio-off clip with NO audio filter is silent. Only the genuine dead-filter state
// fires, and at `info` severity (it renders correctly — it's waste, not a hazard).

/** Filter services that act ONLY on audio — present on a video-only (audio-off) clip
 *  they are dead. The vean fade SENTINELS are video/audio-agnostic markers the
 *  serializer expands per track kind, so they are NOT counted (a fade sentinel on a
 *  video-only clip is a legitimate video fade). */
const AUDIO_ONLY_FILTER_SERVICES = new Set([
  "volume",
  "gain",
  "panner",
  "audiopan",
  "audiobalance",
  "audiochannels",
  "audiowaveform",
  "audiolevelgraph",
  "fadeInVolume",
  "fadeOutVolume",
  "avfilter.pan",
  "avfilter.volume",
  "avfilter.loudnorm",
  "avfilter.acompressor",
  "avfilter.highpass",
  "avfilter.lowpass",
  "dynamic_loudness",
  "loudness",
  "sox",
]);

function isAudioOnlyFilterService(service: string): boolean {
  if (service === FADE_IN_SERVICE || service === FADE_OUT_SERVICE) return false; // agnostic marker
  return AUDIO_ONLY_FILTER_SERVICES.has(service);
}

function checkRedundantStreamSelector(l: LinkedLocation): DiagnosticInput[] {
  const clip = l.clip;
  if (clip.streams == null) return []; // no selectors → not a detached/configured producer
  if (hasAudio(clip)) return []; // audio is ON → any audio filter is live, not dead
  const out: DiagnosticInput[] = [];
  clip.filters.forEach((f, fi) => {
    if (!isAudioOnlyFilterService(f.service)) return;
    out.push(
      diag({
        code: "redundant-stream-selector",
        severity: "info",
        message: `clip "${clip.id}" has its audio turned off (a stream selector disables it) but still carries an audio-only ${f.service} filter at index ${fi} — the filter operates on a stream that isn't decoded, so it does nothing`,
        location: { clip: clip.id, track: l.track.id, filter: fi },
        fix: "remove the dead audio filter, or re-enable the clip's audio stream",
        data: { service: f.service, audioIndex: clip.streams?.audioIndex ?? -1 },
      }),
    );
  });
  return out;
}

// ─── 4. ripple-link-hazard — an in-sync pair that a per-track ripple would break ─
//
// A linked A/V pair that is CURRENTLY IN SYNC (same source window, same timeline
// position) but lives on TWO DIFFERENT tracks is a latent desync: a per-track ripple
// (insert/delete that shifts everything after an edit point on ONE track) moves one
// member and not the partner on the other track — the exact footgun Shotcut ships
// (its ripple isn't group-aware). vean surfaces it BEFORE the ripple: a warning to
// ripple both tracks (or lift instead). We fire ONLY on the in-sync, cross-track
// pair — a pair already drifted is `av-desync` (reported above), and a pair on the
// SAME track ripples together, so it is not a hazard. Same-track pairs and aligned
// same-position-different-track pairs on their own are exactly the well-formed detach
// output, so this stays silent on every clean/aligned single-track state.
//
// This is forward-looking (it describes what a ripple WOULD do), so it is a
// `warning`, not an error — the current state is valid.

function checkRippleLinkHazard(group: readonly LinkedLocation[]): DiagnosticInput[] {
  const out: DiagnosticInput[] = [];
  for (let i = 0; i < group.length; i++) {
    const a = group[i];
    if (a == null) continue;
    for (let j = i + 1; j < group.length; j++) {
      const b = group[j];
      if (b == null) continue;
      // Only an IN-SYNC pair is a latent hazard; a drifted pair is av-desync's job.
      const aligned =
        a.clip.in === b.clip.in && a.clip.out === b.clip.out && a.position === b.position;
      if (!aligned) continue;
      // On the SAME track a ripple shifts both together — no hazard.
      if (a.track.id === b.track.id) continue;

      const aIsVideo = a.clip.link?.role === "video";
      const [primary, secondary] = aIsVideo || b.clip.link?.role !== "video" ? [a, b] : [b, a];
      out.push(
        diag({
          code: "ripple-link-hazard",
          severity: "warning",
          message: `linked clips "${primary.clip.id}" and "${secondary.clip.id}" (group "${primary.clip.link?.id}") are in sync but sit on different tracks ("${primary.track.id}" / "${secondary.track.id}") — a per-track ripple on one track would shift it and desync the partner on the other`,
          location: { clip: primary.clip.id, track: primary.track.id },
          related: [
            {
              location: { clip: secondary.clip.id, track: secondary.track.id },
              message:
                "the linked partner on the other track a per-track ripple would leave behind",
            },
          ],
          fix: "ripple both tracks together (or lift instead of ripple) to keep the link in sync",
          data: {
            linkId: primary.clip.link?.id ?? "",
            trackA: primary.track.id,
            trackB: secondary.track.id,
            position: primary.position,
          },
        }),
      );
    }
  }
  return out;
}

// ─── The link checker (composed from the rules) ─────────────────────────────────
/** Run every in-IR link/stream-selector rule over the timeline. Per-clip rules
 *  (dangling-link, redundant-stream-selector) iterate the located clips; the pair
 *  rules (av-desync, ripple-link-hazard) group by `link.id` and compare members.
 *  The registry stamps `source: "link"`. */
export function link(state: Timeline): Diagnostic[] {
  const out: DiagnosticInput[] = [];
  const located = indexClips(state);
  const ids = allClipIds(located);

  // Per-clip rules.
  for (const l of located) {
    out.push(...checkDanglingLink(l, ids));
    out.push(...checkRedundantStreamSelector(l));
  }

  // Pair rules (grouped by link id).
  for (const group of groupByLinkId(located).values()) {
    if (group.length < 2) continue; // a solo carrier is dangling-link's concern
    out.push(...checkAvDesync(group));
    out.push(...checkRippleLinkHazard(group));
  }

  // The registry stamps `source`; attach a placeholder so the type is a full
  // Diagnostic for the registry to finalize.
  return out.map((d) => ({ ...d, source: "link" }));
}
