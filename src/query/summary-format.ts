// The COMPACT human rendering of a `TimelineSummary` — the text an agent (or a
// person) skims to orient before diving in. `timeline show` prints this by default;
// `--json` prints the structured `TimelineSummary` instead. Pure + deterministic
// (string in, string out) so it's unit-testable and reusable by the app/MCP.
//
// Design goal: one screen tells you the whole timeline — profile + duration, then
// each track top-labeled with its clips as `[start–end] Nf resource +extras`, then
// transitions and a diagnostics one-liner. Frames are canonical; the timecode lives
// in the header + JSON, not cluttering every row.
import type { ItemSummary, TimelineSummary, TrackSummary } from "./summary";

/** Last path segment of a resource (media basename), or the whole string for a
 *  color/spec resource. Keeps rows short; the full resource is in the JSON. */
function basename(resource: string): string {
  const trimmed = resource.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** The trailing annotations for a clip row (source window, gain, fades, overlay,
 *  provenance, diagnostics) — only the parts that apply. */
function clipExtras(item: Extract<ItemSummary, { kind: "clip" }>): string {
  const parts: string[] = [];
  // A trimmed source window is worth showing (in != 0 or the played length differs
  // from the source length); a full-length untrimmed clip isn't.
  const played = item.source.out - item.source.in + 1;
  if (item.source.in !== 0 || (item.source.length != null && played !== item.source.length)) {
    parts.push(`src ${item.source.in}–${item.source.out}`);
  }
  if (item.overlay === "graphic") parts.push(`▸${item.composition ?? "graphic"} (live)`);
  else if (item.overlay === "composited") parts.push(`▸${item.composition} (baked)`);
  if (item.gain === 0) parts.push("muted");
  else if (item.gainDb != null) parts.push(`${item.gainDb > 0 ? "+" : ""}${item.gainDb}dB`);
  if (item.fadeInFrames) parts.push(`fade-in ${item.fadeInFrames}f`);
  if (item.fadeOutFrames) parts.push(`fade-out ${item.fadeOutFrames}f`);
  if (item.provenance && item.provenance !== "import") parts.push(item.provenance);
  if (item.diagnostics > 0) {
    parts.push(`⚠ ${item.diagnostics} diag${item.diagnostics === 1 ? "" : "s"}`);
  }
  return parts.join("  ");
}

/** `[start–end]` padded so a track's rows align on the span + frames columns. */
function spanCell(start: number, end: number, width: number): string {
  return `[${start}–${end}]`.padEnd(width);
}

function formatTrack(track: TrackSummary): string[] {
  const header = `${track.name} ${track.kind}  ${track.length}f`;
  if (track.items.length === 0) return [header, "  (empty)"];

  // Align the span column to the widest `[start–end]` on this track.
  const spanWidth = Math.max(...track.items.map((it) => `[${it.start}–${it.end}]`.length));
  const framesWidth = Math.max(...track.items.map((it) => `${it.frames}f`.length));

  const rows = track.items.map((it) => {
    const span = spanCell(it.start, it.end, spanWidth);
    const frames = `${it.frames}f`.padStart(framesWidth);
    if (it.kind === "blank") return `  blank     ${span} ${frames}`;
    if (it.kind === "dissolve") {
      return `  dissolve  ${span} ${frames}  ${it.service}`;
    }
    const extras = clipExtras(it);
    const label = it.label && !it.label.startsWith("graphic:") ? ` "${it.label}"` : "";
    return `  clip      ${span} ${frames}  ${basename(it.resource)}${label}${
      extras ? `  ${extras}` : ""
    }`.trimEnd();
  });
  return [header, ...rows];
}

/** Render a `TimelineSummary` as compact human text. */
export function formatTimelineSummary(summary: TimelineSummary): string {
  const { profile, counts } = summary;
  const fpsStr = Number.isInteger(profile.fpsRatio)
    ? `${profile.fpsRatio}fps`
    : `${profile.fpsRatio.toFixed(3)}fps`;

  const lines: string[] = [];
  lines.push(
    `${summary.title} · ${profile.description} · ${profile.width}×${profile.height} · ${fpsStr} · ${summary.duration} (${summary.totalFrames}f)`,
  );
  const clipWord = counts.clips === 1 ? "clip" : "clips";
  const trackBits = [
    `${counts.videoTracks} video`,
    `${counts.audioTracks} audio`,
    `${counts.clips} ${clipWord}`,
  ];
  if (counts.blanks > 0) trackBits.push(`${counts.blanks} blank${counts.blanks === 1 ? "" : "s"}`);
  if (counts.dissolves > 0) trackBits.push(`${counts.dissolves} dissolve`);
  if (counts.transitions > 0) {
    trackBits.push(`${counts.transitions} transition${counts.transitions === 1 ? "" : "s"}`);
  }
  lines.push(`tracks: ${trackBits.join(" · ")}`);
  lines.push("");

  for (const track of summary.tracks) {
    lines.push(...formatTrack(track));
  }

  if (summary.transitions.length > 0) {
    lines.push("");
    lines.push("transitions");
    for (const t of summary.transitions) {
      lines.push(
        `  #${t.index}  ${t.service}  tracks ${t.aTrack}↔${t.bTrack}  [${t.start}–${t.end}]  ${t.frames}f`,
      );
    }
  }

  lines.push("");
  const { error, warning, info, hint } = counts.diagnostics;
  const total = error + warning + info + hint;
  if (total === 0) {
    lines.push("diagnostics: clean");
  } else {
    const bits: string[] = [];
    if (error) bits.push(`${error} error${error === 1 ? "" : "s"}`);
    if (warning) bits.push(`${warning} warning${warning === 1 ? "" : "s"}`);
    if (info) bits.push(`${info} info`);
    if (hint) bits.push(`${hint} hint${hint === 1 ? "" : "s"}`);
    lines.push(`diagnostics: ${bits.join(", ")}`);
    for (const d of summary.diagnostics) {
      const mark = d.severity === "error" ? "✗" : d.severity === "warning" ? "⚠" : "•";
      const where = d.clip ? `  @${d.clip}` : d.track ? `  @${d.track}` : "";
      lines.push(`  ${mark} ${d.code}  ${d.message}${where}`);
    }
  }

  return lines.join("\n");
}
