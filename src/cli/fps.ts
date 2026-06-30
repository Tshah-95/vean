// `vean fps` — the frame-rate workflow surface: the autodetect consumer (reads the
// `fps.autodetect` setting and proposes/applies a timeline conform) and the two
// fixes for the fps diagnostics. Both fixes are ADDITIVE (conform retags the
// profile; transcode writes a NEW intermediate + relinks), so they apply without a
// confirm gate per the action policy — only a delete-tier action would prompt.
//
// A thin CLI over the pure conform engine (`src/conform/fps.ts`) + the ffmpeg
// transcode driver (`src/driver/transcode.ts`): resolve the timeline, probe, decide,
// write. Reads/writes the .mlt with the same parse/serialize the server's save path
// uses, so a conform/relink round-trips byte-faithfully.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { Command } from "commander";
import { type FpsConformMode, applyFpsConform, autodetectDecision } from "../conform/fps";
import { probeSource } from "../driver/probe";
import { transcodeToCfr } from "../driver/transcode";
import { fromMlt } from "../ir/parse";
import { toMlt } from "../ir/serialize";
import type { Clip, Timeline } from "../ir/types";
import { resolveProject } from "../project/context";
import { getSettingValue } from "../state/settingsStore";
import { resolveTimelineTarget } from "../state/timeline";

const repoOf = (opts: { repo?: string }): string => resolve(opts.repo ?? process.cwd());

/** Resolve a timeline target (alias or path; default `timeline:main`) to its path +
 *  parsed IR — the server's readTimeline pattern, reused for the CLI. */
function loadTimeline(repo: string, target?: string): { path: string; timeline: Timeline } {
  const project = resolveProject({ project: repo, cwd: repo, env: process.env }) ?? {
    rootPath: repo,
    source: "explicit" as const,
    stateDbPath: "",
  };
  const resolved = resolveTimelineTarget(repo, project, target);
  if ("ok" in resolved) {
    throw new Error(`no timeline for "${target ?? "timeline:main"}" — set one with \`vean timeline use\``);
  }
  return { path: resolved.resolvedPath, timeline: fromMlt(readFileSync(resolved.resolvedPath, "utf8")) };
}

const abs = (baseDir: string, resource: string): string =>
  isAbsolute(resource) ? resource : resolve(baseDir, resource);

/** The first video clip on the timeline (the autodetect reference). */
function firstVideoClip(tl: Timeline): Clip | null {
  for (const track of tl.tracks.video) {
    for (const item of track.items) if (item.kind === "clip") return item;
  }
  return null;
}

function findClipById(tl: Timeline, id: string): Clip | null {
  for (const track of [...tl.tracks.video, ...tl.tracks.audio]) {
    for (const item of track.items) if (item.kind === "clip" && item.id === id) return item;
  }
  return null;
}

export function buildFpsCommand(): Command {
  const fps = new Command("fps").description("Frame-rate autodetect + conform / transcode fixes");

  fps
    .command("conform [timeline]")
    .description("Match the timeline fps to the first clip (per the fps.autodetect setting)")
    .option("--repo <path>", "project repo path")
    .option("--apply", "apply the change even if fps.autodetect is 'confirm'")
    .option("--json", "emit JSON")
    .action(async (target: string | undefined, opts: { repo?: string; apply?: boolean; json?: boolean }) => {
      const repo = repoOf(opts);
      const { path: mltPath, timeline } = loadTimeline(repo, target);
      const clip = firstVideoClip(timeline);
      if (!clip) throw new Error("the timeline has no video clip to detect a frame rate from");
      const probe = await probeSource(abs(dirname(mltPath), clip.resource));
      if (!probe) throw new Error(`could not probe ${clip.resource}`);

      const mode: FpsConformMode = opts.apply
        ? "auto"
        : (getSettingValue(repo, "fps.autodetect") as FpsConformMode);
      const decision = autodetectDecision(mode, timeline.profile, probe);

      let applied = false;
      if (decision.decision === "apply") {
        writeFileSync(mltPath, toMlt(applyFpsConform(timeline, decision.proposal.toFps)), "utf8");
        applied = true;
      }

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, mode, ...decision, applied, timeline: mltPath }, null, 2));
        return;
      }
      switch (decision.decision) {
        case "off":
          console.log("fps.autodetect is 'off' — no change (set it with `vean config set fps.autodetect auto`)");
          break;
        case "match":
          console.log("timeline already matches the source frame rate — nothing to do");
          break;
        case "propose": {
          const { fromFps, toFps } = decision.proposal;
          console.log(
            `source is ${fmt(toFps)} fps, timeline is ${fmt(fromFps)} fps. Re-run with --apply (or set fps.autodetect=auto) to conform.`,
          );
          break;
        }
        case "apply": {
          const { fromFps, toFps } = decision.proposal;
          console.log(`Set timeline fps to ${fmt(toFps)} (was ${fmt(fromFps)}) — saved ${mltPath}`);
          break;
        }
      }
      void applied;
    });

  fps
    .command("transcode <clipId> [timeline]")
    .description("Transcode a clip's variable-rate source to a constant-rate intermediate + relink")
    .option("--repo <path>", "project repo path")
    .option("--json", "emit JSON")
    .action(async (clipId: string, target: string | undefined, opts: { repo?: string; json?: boolean }) => {
      const repo = repoOf(opts);
      const { path: mltPath, timeline } = loadTimeline(repo, target);
      const clip = findClipById(timeline, clipId);
      if (!clip) throw new Error(`clip not found: ${clipId}`);
      const src = abs(dirname(mltPath), clip.resource);
      // Conform the intermediate to the TIMELINE rate so it lands frame-exact.
      const result = await transcodeToCfr(src, timeline.profile.fps);
      clip.resource = result.outPath; // relink (additive: the original is untouched)
      writeFileSync(mltPath, toMlt(timeline), "utf8");
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, clip: clipId, ...result, timeline: mltPath }, null, 2));
        return;
      }
      console.log(
        `${result.cached ? "Reused" : "Transcoded"} CFR intermediate ${result.outPath} (${fmt(result.fps)} fps) and relinked clip ${clipId} — saved ${mltPath}`,
      );
    });

  return fps;
}

function fmt(fps: [number, number]): string {
  const r = fps[0] / fps[1];
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}
